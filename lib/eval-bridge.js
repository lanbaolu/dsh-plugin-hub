/**
 * @lanbaolu/dsh-plugin-hub — 自进化闭环接线（agent-teams 状态 → eval-loop）。
 *
 * 把 agent-teams 持久化的团队状态（`<workspace>/.agent-teams/<teamId>/team.json`）
 * 里的新 completed 任务，喂给 eval-loop 的 onTaskCompleted（最小闭环 ①→④）。
 *
 * 为什么轮询磁盘而非订阅事件：agent-teams 的任务事件是 append 到 captain session
 * 的（且 harness 不认识的类型会被跳过，见 events.ts），磁盘 `team.json` 才是权威
 * 真相源（agent-teams 自己的活动面板也读它）。
 *
 * 安全/哲学对齐（市场哲学·特殊通道）：
 *  - 白名单 `dirs`：只轮询显式列出的状态根目录，不任意扫描整个磁盘（默认空 = 不轮询）；
 *  - 幂等：同一 `(teamId, taskId)` 只处理一次，seen 集合可持久化到 JSON 文件（重启不重喂）；
 *  - 单团队解析失败/单任务处理失败不阻断其余（对齐 MCP/Skills 桥的哲学）；
 *  - 桥只负责"发现并投喂"，实际记忆沉淀逻辑在 eval-loop（默认关闭，显式开启）。
 *
 * 零依赖：仅 node:fs / node:path。纯函数提取层无 IO，可独立单测；IO 集中在桥层。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * 创建 eval 桥。
 * @param {object} deps
 * @param {string[]} [deps.dirs] agent-teams 状态根目录白名单（每个须含 `<teamId>/team.json`）
 * @param {number} [deps.pollMs] 轮询间隔 ms（默认 30_000）
 * @param {(task: object) => (void | Promise<void>)} [deps.onTaskCompleted] 投喂回调（通常 = evalLoop.onTaskCompleted）
 * @param {string|null} [deps.seenFile] 已处理任务 id 集合的持久化 JSON 文件路径（可选）
 * @param {object} [deps.log] logger（可选，需有 info/warn）
 * @returns {{ scan(): Promise<object>, start(): void, stop(): void, status(): object, extractCompletedTasks(stateRoot: string, teamId: string, team: object): object[] }}
 */
export function createEvalBridge(deps = {}) {
  const { dirs = [], pollMs = 30_000, onTaskCompleted, seenFile = null, log } = deps

  /** 已处理任务 key（`<teamId>/<taskId>`），进程内幂等 + 可选持久化。 */
  const seen = new Set()
  let timer = null
  let lastScanAt = null
  let lastError = null
  let processedTotal = 0

  const info = (...args) => { try { log?.info?.('[eval-bridge] ' + args[0], ...args.slice(1)) } catch { /* 日志失败不阻断 */ } }
  const warn = (...args) => { try { log?.warn?.('[eval-bridge] ' + args[0], ...args.slice(1)) } catch { /* 日志失败不阻断 */ } }

  /** 启动时从持久化文件恢复 seen（重启不重喂历史任务）。 */
  function loadSeen() {
    if (!seenFile) return
    try {
      if (existsSync(seenFile)) {
        const arr = JSON.parse(readFileSync(seenFile, 'utf8'))
        if (Array.isArray(arr)) arr.forEach((k) => seen.add(k))
        info('已恢复 %d 条已处理记录', seen.size)
      }
    } catch (e) {
      warn('加载已处理记录失败（忽略）: %s', e instanceof Error ? e.message : String(e))
    }
  }

  // 创建即恢复持久化 seen（无论后续走 scan 还是 start，都不重喂历史任务）
  loadSeen()

  /** 把当前 seen 集合持久化（追加新处理的任务）。 */
  function saveSeen() {
    if (!seenFile) return
    try {
      mkdirSync(dirname(seenFile), { recursive: true })
      writeFileSync(seenFile, JSON.stringify([...seen], null, 2))
    } catch (e) {
      warn('保存已处理记录失败（忽略）: %s', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 从一份团队状态提取 completed 任务的事件对象（纯函数，无 IO）。
   * @returns {Array<{taskId: string, id: string, teamId: string, sessionId: string|null, title: string, description: string, output: string, assignee: string|null, completedAt: number|null}>}
   */
  function extractCompletedTasks(stateRoot, teamId, team) {
    const out = []
    for (const task of team.tasks ?? []) {
      if (task?.status !== 'completed') continue
      out.push({
        // 跨团队唯一键：`<teamId>/<taskId>`
        taskId: `${teamId}/${task.id}`,
        id: task.id,
        teamId,
        sessionId: team.captainSessionId ?? null,
        title: task.subject ?? task.description ?? '',
        description: task.description ?? '',
        output: task.output ?? '',
        assignee: task.assignee ?? null,
        completedAt: task.updatedAt ?? null,
      })
    }
    return out
  }

  /** 扫描全部白名单目录，把新 completed 任务喂给回调。返回本次扫描摘要。 */
  async function scan() {
    lastScanAt = new Date().toISOString()
    lastError = null
    for (const root of dirs) {
      let entries = []
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue // 目录不存在/不可读 → 跳过（不阻断）
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const teamId = entry.name
        const teamFile = join(root, teamId, 'team.json')
        let raw
        try { raw = readFileSync(teamFile, 'utf8') } catch { continue }
        let team
        try { team = JSON.parse(raw) } catch { continue }
        const completed = extractCompletedTasks(root, teamId, team)
        for (const task of completed) {
          const key = task.taskId
          if (seen.has(key)) continue
          seen.add(key)
          try {
            if (typeof onTaskCompleted === 'function') {
              await onTaskCompleted(task)
              processedTotal++
            }
          } catch (e) {
            lastError = `task ${key} 处理失败（已标记，不再重试）: ${e instanceof Error ? e.message : String(e)}`
            warn(lastError)
          }
        }
      }
    }
    saveSeen()
    return { seenCount: seen.size, processed: processedTotal, lastScanAt, lastError }
  }

  /** 启动轮询（目录白名单为空时不启动）。 */
  function start() {
    if (timer || dirs.length === 0) return
    void scan()
    timer = setInterval(() => { void scan() }, Math.max(1000, pollMs))
    if (timer.unref) timer.unref() // 不阻止进程退出
    info('已启动轮询（%d 个状态目录，间隔 %dms）', dirs.length, pollMs)
  }

  /** 停止轮询。 */
  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  /** 桥状态（供 plugin_hub_eval_status 工具展示）。 */
  function status() {
    return {
      enabled: timer !== null,
      dirs,
      pollMs,
      seenCount: seen.size,
      processed: processedTotal,
      lastScanAt,
      lastError,
    }
  }

  return { scan, start, stop, status, extractCompletedTasks }
}

export default createEvalBridge
