/**
 * eval-loop.test.js — 自进化闭环骨架回归（①→④ 数据流 + 反馈护栏 + 降级）。
 * 依赖注入（getTrajectory/verify/remember/log），无 DSH 运行时依赖，可独立单测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEvalLoop } from '../lib/eval-loop.js'

const TASK = {
  taskId: 't-1',
  sessionId: 's-1',
  title: '实现 skills 加载器',
  description: '把外部 skill 转成 DSH 资源',
  output: '交付 lib/skills-loader.js + 测试 + README',
}

/** 造一个带调用记录的最小 deps。 */
function makeDeps(overrides = {}) {
  const calls = { trajectory: [], verify: [], remember: [] }
  const deps = {
    getTrajectory: async (task) => { calls.trajectory.push(task); return { steps: 5, tokens: 1200, errors: 0 } },
    verify: async () => { calls.verify.push(1); return { score: 0.9, confidence: 0.85 } },
    remember: async (entry, opts) => { calls.remember.push({ entry, opts }); return { ok: true } },
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  }
  return { deps, calls }
}

// ── 默认关闭 ──
test('createEvalLoop: 默认关闭，onTaskCompleted 直接跳过且不调用任何 deps', async () => {
  const { deps, calls } = makeDeps()
  const loop = createEvalLoop(deps)
  assert.equal(loop.isEnabled(), false)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(report.ok, true)
  assert.equal(report.skipped, true)
  assert.equal(report.reason, 'disabled')
  assert.equal(calls.trajectory.length, 0)
  assert.equal(calls.verify.length, 0)
  assert.equal(calls.remember.length, 0)
})

// ── 完整数据流 ①→④ ──
test('onTaskCompleted: enable 后串起 观测→验证→记忆，remember 强制 actor=autoDream', async () => {
  const { deps, calls } = makeDeps()
  const loop = createEvalLoop(deps)
  assert.equal(loop.enable(true), true)
  const report = await loop.onTaskCompleted(TASK)

  assert.equal(report.ok, true)
  assert.equal(report.taskId, 't-1')
  // ② 观测被调用
  assert.equal(calls.trajectory.length, 1)
  assert.deepEqual(report.steps.observe.summary, { steps: 5, tokens: 1200, errors: 0 })
  // ③ 验证被调用
  assert.equal(calls.verify.length, 1)
  assert.equal(report.steps.verify.score, 0.9)
  assert.equal(report.steps.verify.confidence, 0.85)
  // ④ 记忆被调用，且 actor 强制 autoDream（红线）
  assert.equal(calls.remember.length, 1)
  const { entry, opts } = calls.remember[0]
  assert.equal(opts.actor, 'autoDream')
  assert.equal(entry.source, 'eval-loop')
  assert.equal(entry.taskId, 't-1')
  assert.equal(entry.sessionId, 's-1')
  assert.deepEqual(entry.summary, { steps: 5, tokens: 1200, errors: 0 })
  assert.equal(entry.verification.confidence, 0.85)
  assert.equal(report.steps.remember.ok, true)
})

// ── 反馈护栏：低置信度不沉淀 ──
test('反馈护栏: 验证置信度低于阈值 → remember 不被调用（只记录不沉淀）', async () => {
  const { deps, calls } = makeDeps({ verify: async () => ({ score: 0.4, confidence: 0.3 }) })
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(calls.remember.length, 0)
  assert.equal(report.steps.remember.blocked, true)
  assert.equal(report.steps.remember.reason, 'low-confidence')
  assert.equal(report.steps.remember.confidence, 0.3)
  assert.equal(report.ok, true) // 整体不视为失败
})

test('反馈护栏: 置信度达标（>= 阈值）→ 正常沉淀', async () => {
  const { deps, calls } = makeDeps({ verify: async () => ({ score: 0.8, confidence: 0.7 }) })
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(calls.remember.length, 1)
  assert.equal(report.steps.remember.ok, true)
})

// ── 降级：环节缺失/失败不阻断 ──
test('降级: verify 缺失（验证默认关闭）→ 记忆仍写', async () => {
  const { deps, calls } = makeDeps({ verify: undefined })
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(report.steps.verify.skipped, true)
  assert.equal(calls.remember.length, 1)
  assert.equal(report.steps.remember.ok, true)
})

test('降级: getTrajectory 抛错 → 不阻断，记忆仍写', async () => {
  const { deps, calls } = makeDeps({ getTrajectory: async () => { throw new Error('trajectory down') } })
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(report.steps.observe.ok, false)
  assert.match(report.steps.observe.error, /trajectory down/)
  assert.equal(calls.remember.length, 1)
  assert.equal(report.ok, true)
})

test('降级: verify 抛错 → 视为未验证，记忆仍写', async () => {
  const { deps, calls } = makeDeps({ verify: async () => { throw new Error('verifier down') } })
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(report.steps.verify.ok, false)
  assert.match(report.steps.verify.error, /verifier down/)
  assert.equal(calls.remember.length, 1)
})

test('降级: remember 抛错 → 环节失败但整体 ok（不阻断服务）', async () => {
  const { deps } = makeDeps({ remember: async () => { throw new Error('mneme down') } })
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(report.steps.remember.ok, false)
  assert.match(report.steps.remember.error, /mneme down/)
  assert.equal(report.ok, true)
})

// ── 反馈护栏：requireVerification ──
test('反馈护栏: requireVerification=true 且未接 verify → 不沉淀', async () => {
  const { deps, calls } = makeDeps({ verify: undefined })
  const loop = createEvalLoop({ ...deps, requireVerification: true })
  loop.enable(true)
  const report = await loop.onTaskCompleted(TASK)
  assert.equal(calls.remember.length, 0)
  assert.equal(report.steps.remember.blocked, true)
  assert.equal(report.steps.remember.reason, 'require-verification')
})

// ── 输入校验与开关 ──
test('onTaskCompleted: 缺 taskId/id → 返回 ok:false', async () => {
  const loop = createEvalLoop({})
  loop.enable(true)
  const report = await loop.onTaskCompleted({ sessionId: 's' })
  assert.equal(report.ok, false)
  assert.match(report.error, /taskId\/id/)
})

test('enable: 开关状态可切换且 isEnabled 同步', () => {
  const loop = createEvalLoop({ enabled: true })
  assert.equal(loop.isEnabled(), true)
  assert.equal(loop.enable(false), false)
  assert.equal(loop.isEnabled(), false)
})

test('onTaskCompleted: 支持 task.id 作为 taskId 别名', async () => {
  const { deps, calls } = makeDeps()
  const loop = createEvalLoop(deps)
  loop.enable(true)
  const report = await loop.onTaskCompleted({ id: 'alt-1', output: 'x' })
  assert.equal(report.taskId, 'alt-1')
  assert.equal(calls.remember[0].entry.taskId, 'alt-1')
})
