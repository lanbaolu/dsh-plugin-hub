/**
 * @lanbaolu/dsh-plugin-hub — eval 闭环适配层（tools registry → mneme / trajectory / verifier）。
 *
 * 把 eval-loop 的依赖注入点（remember / getTrajectory / verify）接到共享 tools
 * registry 里的真实插件工具上，**不修改任何被接入插件的源码**：
 *
 *  - remember：探测 mneme 的 `memory_save` 工具 → 真实记忆沉淀；不存在则回退本地
 *    JSONL（~/.dsh/plugin-hub/eval-entries.jsonl）。actor 溯源记入 source 字段。
 *  - getTrajectory：探测 trajectory-debug 的 trajectory_* 工具（候选名）；本机未装则
 *    返回 undefined → eval-loop 自动降级（观测缺失跳过）。
 *  - verify：探测 llm-verifier 的 verifier_compare 工具；默认不启用（实验性 + 需后端
 *    配置），由调用方 evalVerifyEnabled 显式开启。失败/缺失时 eval-loop 自动降级。
 *
 * 红线：eval-loop 内部强制 remember 的 opts.actor = 'autoDream'（本模块不绕过）。
 * 哲学：平台只做"桥的传输层"适配，内容质量由各插件自身 + 市场徽章负责。
 *
 * 零依赖：仅 node:fs / node:path。探测逻辑纯函数可测。
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** 默认 jsonl 沉淀文件。 */
export const DEFAULT_EVAL_ENTRIES_FILE = () => join(homedir(), '.dsh', 'plugin-hub', 'eval-entries.jsonl')

/** trajectory-debug 工具候选名（按优先级；未命中返回 null）。 */
export const TRAJECTORY_TOOL_CANDIDATES = [
  'trajectory_get',
  'trajectory_get_trajectory',
  'trajectory_summary',
  'trajectory_debug_get_trajectory',
]

/** llm-verifier 验证工具候选名。 */
export const VERIFY_TOOL_CANDIDATES = ['verifier_compare', 'verifier_select', 'verifier_track']

/** 从 tools registry 探测第一个可执行的工具（纯函数）。 */
export function probeTool(tools, names) {
  if (!tools || typeof tools.get !== 'function') return null
  for (const name of names) {
    const tool = tools.get(name)
    if (tool && typeof tool.execute === 'function') return tool
  }
  return null
}

/** 从记忆条目构造 mneme 记忆标题。 */
export function memoryTitle(entry) {
  const base = entry?.task?.title || entry?.title || '任务经验'
  return `[任务经验] ${base}`.slice(0, 200)
}

/** 从记忆条目构造 mneme 记忆正文（任务描述 + 产出 + 轨迹摘要 + 验证 + 溯源）。 */
export function memoryContent(entry) {
  const lines = []
  const task = entry?.task ?? {}
  if (task.description) lines.push(`任务：${task.description}`)
  if (task.output) lines.push(`产出：${task.output}`)
  if (entry?.summary) lines.push(`轨迹摘要：${JSON.stringify(entry.summary)}`)
  if (entry?.verification) {
    lines.push(`验证：score=${entry.verification.score ?? 'n/a'} confidence=${entry.verification.confidence ?? 'n/a'}`)
  }
  const id = entry?.taskId ?? entry?.id
  const sid = entry?.sessionId
  lines.push(`来源：eval-loop（${id ?? '?'}${sid ? ', session ' + sid : ''}）`)
  return lines.join('\n')
}

/** jsonl 回退沉淀（零依赖；无 mneme 时用）。 */
export function jsonlRemember(entry, opts, file = DEFAULT_EVAL_ENTRIES_FILE()) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify({ actor: opts?.actor ?? 'autoDream', at: new Date().toISOString(), entry }) + '\n')
  return { ok: true, backend: 'jsonl', file, at: new Date().toISOString() }
}

/**
 * 创建 eval 闭环适配器。
 * @param {object} ctx DSH 插件上下文（用于 ctx.get('tools')）
 * @param {object} [opts]
 * @param {boolean} [opts.enableVerify] 是否启用验证适配（默认 false，实验性）
 * @param {string} [opts.entriesFile] jsonl 回退文件（默认 ~/.dsh/plugin-hub/eval-entries.jsonl）
 * @param {object} [opts.log] logger（可选）
 * @returns {{ remember: (entry: object, opts: {actor: string}) => Promise<object>, getTrajectory: ((task: object) => Promise<object|null>)|undefined, verify: ((task: object, summary: object|null) => Promise<object>)|undefined }}
 */
export function createEvalAdapters(ctx, opts = {}) {
  const { enableVerify = false, entriesFile = DEFAULT_EVAL_ENTRIES_FILE(), log } = opts
  const warn = (...args) => { try { log?.warn?.('[eval-adapters] ' + args[0], ...args.slice(1)) } catch { /* 忽略 */ } }

  /**
   * 记忆沉淀：优先 mneme memory_save 工具，否则 jsonl 回退。
   * actor 由 eval-loop 强制传入（autoDream），此处记入 source 溯源。
   */
  async function remember(entry, rememberOpts) {
    const actor = rememberOpts?.actor ?? 'autoDream'
    const tools = ctx?.get?.('tools')
    const save = probeTool(tools, ['memory_save'])
    if (save) {
      try {
        const result = await save.execute({
          type: 'project',
          title: memoryTitle(entry),
          content: memoryContent(entry),
          tags: ['eval-loop', ...(entry?.taskId ? [entry.taskId] : [])],
          importance: 3,
          source: `eval-loop:${actor}:${entry?.taskId ?? ''}`,
        })
        return { ok: true, backend: 'mneme', actor, result }
      } catch (e) {
        warn('mneme memory_save 调用失败（回退 jsonl）: %s', e instanceof Error ? e.message : String(e))
      }
    }
    return jsonlRemember(entry, rememberOpts, entriesFile)
  }

  /**
   * 观测：探测 trajectory-debug 工具取轨迹摘要；未装/失败 → null（eval-loop 自动降级）。
   */
  async function getTrajectory(task) {
    const tools = ctx?.get?.('tools')
    const tool = probeTool(tools, TRAJECTORY_TOOL_CANDIDATES)
    if (!tool) return null
    try {
      const result = await tool.execute({ taskId: task?.taskId ?? task?.id, sessionId: task?.sessionId })
      return result ?? null
    } catch (e) {
      warn('trajectory 摘要获取失败（降级）: %s', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  /**
   * 验证：探测 llm-verifier（默认不启用）。用 verifier_compare 对 task.output 打分，
   * 映射为 eval-loop 契约 { score, confidence }；失败/缺失抛错由 eval-loop 降级。
   */
  async function verify(task, summary) {
    const tools = ctx?.get?.('tools')
    const tool = probeTool(tools, VERIFY_TOOL_CANDIDATES)
    if (!tool) throw new Error('verifier 工具不可用（llm-verifier 未装配或未配置）')
    // 兼容 eval-bridge 的原始任务（顶层字段）与记忆条目（嵌套 task.*）
    const problem = task?.description ?? task?.task?.description ?? task?.title ?? task?.task?.title ?? ''
    const output = task?.output ?? task?.task?.output ?? ''
    if (tool.name === 'verifier_compare') {
      const r = await tool.execute({
        problem,
        candidate_a: output,
        candidate_b: '(空基线)',
        criteria: '{"质量":"产出是否完整、正确、可直接使用"}',
        n_evaluations: 1,
      })
      const score = Number(r?.reward_a ?? r?.scores?.[0] ?? NaN)
      return { score: Number.isFinite(score) ? score : null, confidence: 0.5 }
    }
    // verifier_select / 其他：尽力取分数
    const r = await tool.execute({ problem, candidates: [output], criteria: '{"质量":"产出是否完整、正确、可直接使用"}', n_evaluations: 1 })
    const score = Number(r?.scores?.[0] ?? NaN)
    return { score: Number.isFinite(score) ? score : null, confidence: 0.5 }
  }

  return {
    remember,
    getTrajectory,
    verify: enableVerify ? verify : undefined,
  }
}

export default createEvalAdapters
