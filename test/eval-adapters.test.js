/**
 * eval-adapters.test.js — 自进化闭环适配层回归。
 * 覆盖：tools registry 探测、mneme memory_save 沉淀、jsonl 回退、轨迹/验证降级、actor 溯源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEvalAdapters, probeTool, memoryTitle, memoryContent, jsonlRemember,
  TRAJECTORY_TOOL_CANDIDATES, VERIFY_TOOL_CANDIDATES,
} from '../lib/eval-adapters.js'

/** fake tools registry。 */
function fakeTools(map = {}) {
  return { get: (name) => map[name] ?? null }
}
/** fake ctx，仅暴露 tools。 */
function fakeCtx(tools) {
  return { get: (key) => (key === 'tools' ? tools : undefined) }
}

const entry = {
  taskId: 'teamA/t1',
  sessionId: 'session-1',
  task: { title: '实现 X', description: '做 Y', output: '产出 Z' },
  summary: { steps: 3 },
  verification: { score: 0.9, confidence: 0.85 },
}

test('probeTool: 命中可执行工具 / 未命中返回 null', () => {
  const t = { name: 'memory_save', execute: async () => ({}) }
  assert.equal(probeTool(fakeTools({ memory_save: t }), ['memory_save']), t)
  assert.equal(probeTool(fakeTools({}), ['memory_save']), null)
  assert.equal(probeTool(null, ['memory_save']), null)
})

test('memoryTitle / memoryContent: 正确构造 mneme 记忆', () => {
  assert.equal(memoryTitle(entry), '[任务经验] 实现 X')
  const c = memoryContent(entry)
  assert.ok(c.includes('做 Y'))
  assert.ok(c.includes('产出 Z'))
  assert.ok(c.includes('轨迹摘要'))
  assert.ok(c.includes('score=0.9'))
  assert.ok(c.includes('teamA/t1'))
})

test('remember: 有 memory_save 工具 → mneme 沉淀（参数正确 + actor 溯源）', async () => {
  const calls = []
  const save = { name: 'memory_save', execute: async (args) => { calls.push(args); return { action: 'created', id: 'm1' } } }
  const adapters = createEvalAdapters(fakeCtx(fakeTools({ memory_save: save })), { entriesFile: join(mkdtempSync(join(tmpdir(), 'ea-')), 'x.jsonl') })
  const r = await adapters.remember(entry, { actor: 'autoDream' })
  assert.equal(r.backend, 'mneme')
  assert.equal(calls.length, 1)
  const a = calls[0]
  assert.equal(a.type, 'project')
  assert.equal(a.title, '[任务经验] 实现 X')
  assert.ok(a.tags.includes('eval-loop'))
  assert.equal(a.importance, 3)
  assert.ok(a.source.includes('autoDream'))
  assert.ok(a.source.includes('teamA/t1'))
})

test('remember: 无 memory_save → jsonl 回退', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ea-')), 'entries.jsonl')
  const adapters = createEvalAdapters(fakeCtx(fakeTools({})), { entriesFile: file })
  const r = await adapters.remember(entry, { actor: 'autoDream' })
  assert.equal(r.backend, 'jsonl')
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('autoDream'))
  assert.ok(raw.includes('teamA/t1'))
})

test('remember: memory_save 抛错 → 回退 jsonl（不阻断闭环）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ea-')), 'entries.jsonl')
  const save = { name: 'memory_save', execute: async () => { throw new Error('mneme down') } }
  const adapters = createEvalAdapters(fakeCtx(fakeTools({ memory_save: save })), { entriesFile: file })
  const r = await adapters.remember(entry, { actor: 'autoDream' })
  assert.equal(r.backend, 'jsonl')
  assert.ok(readFileSync(file, 'utf8').length > 0)
})

test('getTrajectory: 无 trajectory 工具 → null（eval-loop 降级）', async () => {
  const adapters = createEvalAdapters(fakeCtx(fakeTools({})))
  assert.equal(await adapters.getTrajectory(entry), null)
})

test('getTrajectory: 有 trajectory 工具 → 调用并返回', async () => {
  const t = { name: 'trajectory_get', execute: async (args) => ({ steps: 5, tokens: 100 }) }
  const adapters = createEvalAdapters(fakeCtx(fakeTools({ trajectory_get: t })))
  const r = await adapters.getTrajectory({ taskId: 'teamA/t1', sessionId: 's1' })
  assert.deepEqual(r, { steps: 5, tokens: 100 })
})

test('verify: 默认不启用 → undefined', () => {
  const adapters = createEvalAdapters(fakeCtx(fakeTools({ verifier_compare: { execute: async () => ({}) } })))
  assert.equal(adapters.verify, undefined)
})

test('verify: enableVerify + verifier_compare → 映射 score/confidence', async () => {
  const t = {
    name: 'verifier_compare',
    execute: async (args) => {
      assert.equal(args.candidate_a, '产出 Z')
      return { reward_a: 0.8, reward_b: 0.2 }
    },
  }
  const adapters = createEvalAdapters(fakeCtx(fakeTools({ verifier_compare: t })), { enableVerify: true })
  // eval-bridge 构造的原始任务（顶层字段）
  const rawTask = { taskId: 'teamA/t1', id: 't1', teamId: 'teamA', sessionId: 's1', title: '实现 X', description: '做 Y', output: '产出 Z' }
  const r = await adapters.verify(rawTask, { steps: 3 })
  assert.equal(r.score, 0.8)
  assert.equal(r.confidence, 0.5)
})

test('jsonlRemember: 直接回退写入（独立工具）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ea-')), 'e.jsonl')
  const r = jsonlRemember(entry, { actor: 'autoDream' }, file)
  assert.equal(r.ok, true)
  assert.equal(r.backend, 'jsonl')
  assert.ok(readFileSync(file, 'utf8').includes('autoDream'))
})

test('候选名列表非空且不重复', () => {
  assert.ok(TRAJECTORY_TOOL_CANDIDATES.length > 0)
  assert.ok(VERIFY_TOOL_CANDIDATES.length > 0)
  assert.equal(new Set(TRAJECTORY_TOOL_CANDIDATES).size, TRAJECTORY_TOOL_CANDIDATES.length)
})
