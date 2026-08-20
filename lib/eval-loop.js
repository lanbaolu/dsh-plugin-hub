/**
 * @lanbaolu/dsh-plugin-hub — 自进化闭环骨架（eval-loop，Phase 3·E 能力面·旗舰示例）。
 *
 * 最小闭环 ①→④：任务完成 → 轨迹摘要占位 → 验证占位 → mneme 记忆沉淀。
 *  ① 触发：onTaskCompleted(task)（由 agent-teams 等外部把 completed 事件喂进来）
 *  ② 观测：deps.getTrajectory(task) → 轨迹摘要（占位，缺失/失败降级）
 *  ③ 验证：deps.verify(task, summary) → { score, confidence }（占位，默认关闭）
 *  ④ 记忆：deps.remember(entry, { actor: 'autoDream' }) → mneme 沉淀
 *
 * 反馈护栏（防"越用越错"）：
 *  - 验证返回但置信度 < minConfidence（默认 0.7）→ 只记录不沉淀；
 *  - requireVerification=true 且未接验证 → 不沉淀；
 *  - 每个环节失败不阻断后续（观测/验证缺失时跳过，记忆仍可写）；
 *  - 闭环默认关闭（enable(false)），由调用方显式开启。
 *
 * 红线（Do-Not-Repeat）：写记忆必须 { actor: 'autoDream' }——否则 mneme 的
 * reflectionFailureTracking 会把机器自动整理误记为 user_correction，污染反思数据。
 * 本模块调用 deps.remember 时强制携带该 actor，不可绕过。
 *
 * 依赖注入设计：不直接依赖 agent-teams / trajectory-debug / llm-verifier / mneme，
 * 通过 deps 注入适配函数，桥层集中适配，可独立单测。
 */

const DEFAULT_CONFIG = {
  /** 默认关闭（旗舰示例，显式开启）。 */
  enabled: false,
  /** 验证置信度阈值：低于它不沉淀记忆（防固化坏经验）。 */
  minConfidence: 0.7,
  /** 是否强制要求验证环节（true 且未接 verify 时不沉淀）。默认 false：验证缺失时记忆仍可写。 */
  requireVerification: false,
}

/**
 * 创建自进化闭环骨架。
 * @param {object} deps 依赖注入
 * @param {boolean} [deps.enabled] 初始开关（默认 false）
 * @param {number} [deps.minConfidence] 验证置信度阈值（默认 0.7）
 * @param {boolean} [deps.requireVerification] 是否强制验证（默认 false）
 * @param {(task: object) => (object | Promise<object>)} [deps.getTrajectory] ② 轨迹摘要（占位）
 * @param {(task: object, summary: object|null) => (object | Promise<object>)} [deps.verify] ③ 验证，返回 { score, confidence }
 * @param {(entry: object, opts: { actor: string }) => (any | Promise<any>)} [deps.remember] ④ 记忆沉淀（mneme service.update / memory_save）
 * @param {object} [deps.log] logger（可选，需有 info/warn）
 * @returns {{ enable(enabled: boolean): boolean, isEnabled(): boolean, onTaskCompleted(task: object): Promise<object> }}
 */
export function createEvalLoop(deps = {}) {
  const { getTrajectory, verify, remember, log } = deps
  const minConfidence = deps.minConfidence ?? DEFAULT_CONFIG.minConfidence
  const requireVerification = deps.requireVerification ?? DEFAULT_CONFIG.requireVerification
  let enabled = Boolean(deps.enabled ?? DEFAULT_CONFIG.enabled)

  const info = (...args) => { try { log?.info?.('[eval-loop] ' + args[0], ...args.slice(1)) } catch { /* 日志失败不阻断 */ } }
  const warn = (...args) => { try { log?.warn?.('[eval-loop] ' + args[0], ...args.slice(1)) } catch { /* 日志失败不阻断 */ } }

  /**
   * ① 触发：任务完成 → 串起 ②③④。
   * 每个环节失败不阻断后续；反馈护栏在验证低置信度时拦截记忆沉淀。
   * @param {object} task { taskId (或 id), sessionId?, title?, description?, output? }
   * @returns {Promise<object>} 执行报告
   */
  async function onTaskCompleted(task) {
    const taskId = task?.taskId ?? task?.id
    if (!enabled) {
      return { ok: true, skipped: true, reason: 'disabled', taskId: taskId ?? null }
    }
    if (!taskId) {
      return { ok: false, error: 'task 缺少 taskId/id' }
    }

    const report = {
      ok: true,
      enabled: true,
      taskId,
      sessionId: task.sessionId ?? null,
      steps: { observe: {}, verify: {}, remember: {} },
    }

    // ② 观测：轨迹摘要（占位；缺失/失败降级，不阻断）
    let summary = null
    try {
      if (typeof getTrajectory === 'function') {
        summary = await getTrajectory(task)
        report.steps.observe = { ok: true, summary }
      } else {
        report.steps.observe = { skipped: true, reason: '未接入 getTrajectory（观测占位）' }
      }
    } catch (e) {
      report.steps.observe = { ok: false, error: e instanceof Error ? e.message : String(e) }
      warn('task %s 观测失败（不阻断）：%s', taskId, report.steps.observe.error)
    }

    // ③ 验证：带置信度评分（占位；默认关闭 → verify 缺失时跳过，记忆仍可写）
    let verification = null
    try {
      if (typeof verify === 'function') {
        verification = await verify(task, summary)
        report.steps.verify = { ok: true, ...normalizeVerification(verification) }
      } else {
        report.steps.verify = { skipped: true, reason: '验证环节默认关闭（未接入 verify）' }
      }
    } catch (e) {
      report.steps.verify = { ok: false, error: e instanceof Error ? e.message : String(e) }
      warn('task %s 验证失败（降级为未验证，不阻断）：%s', taskId, report.steps.verify.error)
    }

    // 反馈护栏 ①：验证返回且置信度低于阈值 → 只记录不沉淀（防固化坏经验）
    if (verification && typeof verification.confidence === 'number' && verification.confidence < minConfidence) {
      report.steps.remember = {
        blocked: true,
        reason: 'low-confidence',
        confidence: verification.confidence,
        minConfidence,
      }
      warn(`task ${taskId} 验证置信度 ${verification.confidence.toFixed(2)} < 阈值 ${minConfidence.toFixed(2)}，不沉淀记忆`)
      return report
    }

    // 反馈护栏 ②：要求验证但未接验证 → 不沉淀
    if (requireVerification && !verification) {
      report.steps.remember = { blocked: true, reason: 'require-verification', minConfidence }
      warn('task %s 要求验证但未接入 verify，不沉淀记忆', taskId)
      return report
    }

    // ④ 记忆沉淀：强制 actor='autoDream'（红线，不可绕过）
    if (typeof remember === 'function') {
      const entry = buildMemoryEntry(task, { summary, verification })
      try {
        await remember(entry, { actor: 'autoDream' })
        report.steps.remember = { ok: true, actor: 'autoDream', entry }
        info('task %s 已沉淀记忆（actor=autoDream）', taskId)
      } catch (e) {
        report.steps.remember = { ok: false, error: e instanceof Error ? e.message : String(e) }
        warn('task %s 记忆沉淀失败（不阻断服务）：%s', taskId, report.steps.remember.error)
      }
    } else {
      report.steps.remember = { skipped: true, reason: '未接入 remember（记忆沉淀缺失）' }
    }

    return report
  }

  return {
    /** 开关闭环（默认关闭）。返回当前状态。 */
    enable(enabledFlag) {
      enabled = Boolean(enabledFlag)
      return enabled
    },
    isEnabled: () => enabled,
    onTaskCompleted,
  }
}

/** 规范化验证结果（score/confidence/note，容忍缺字段）。 */
function normalizeVerification(v) {
  const out = {}
  if (v && typeof v === 'object') {
    if ('score' in v) out.score = v.score
    if ('confidence' in v) out.confidence = v.confidence
    if (v.note) out.note = v.note
  }
  return out
}

/** 组装记忆条目（可追溯：sessionId + taskId + 产出 + 摘要 + 验证）。 */
function buildMemoryEntry(task, { summary, verification }) {
  return {
    source: 'eval-loop',
    kind: 'task-experience',
    taskId: task.taskId ?? task.id,
    sessionId: task.sessionId ?? null,
    task: {
      title: task.title ?? task.description ?? '',
      description: task.description ?? '',
      output: task.output ?? '',
    },
    summary: summary ?? null,
    verification: verification
      ? { score: verification.score ?? null, confidence: verification.confidence ?? null }
      : null,
    at: new Date().toISOString(),
  }
}

export default createEvalLoop
