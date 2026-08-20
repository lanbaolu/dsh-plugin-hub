/**
 * eval-bridge.test.js — 自进化闭环接线（agent-teams 状态 → eval-loop）回归。
 * 覆盖：completed 任务提取、投喂、幂等、seen 持久化、容错、生命周期。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEvalBridge } from '../lib/eval-bridge.js'

/** 造一份 team.json。 */
function makeTeam(teamId, tasks) {
  return {
    name: teamId,
    id: teamId,
    captainSessionId: 'session-captain-' + teamId,
    tasks,
  }
}

/** 造一个临时状态根目录，返回 { root, cleanup }。 */
function makeStateRoot(teams) {
  const root = mkdtempSync(join(tmpdir(), 'eval-bridge-'))
  for (const [teamId, team] of Object.entries(teams)) {
    mkdirSync(join(root, teamId), { recursive: true })
    writeFileSync(join(root, teamId, 'team.json'), JSON.stringify(team))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const completedTask = (id, over = {}) => ({
  id,
  subject: '任务 ' + id,
  description: '描述 ' + id,
  status: 'completed',
  assignee: 'engineer',
  output: '产出 ' + id,
  updatedAt: 1787148078118,
  ...over,
})

test('extractCompletedTasks: completed 任务提取字段（跨团队 taskId/sessionId/output）', () => {
  const bridge = createEvalBridge({})
  const team = makeTeam('t1', [completedTask('a')])
  const list = bridge.extractCompletedTasks('/x', 't1', team)
  assert.equal(list.length, 1)
  assert.equal(list[0].taskId, 't1/a')
  assert.equal(list[0].sessionId, 'session-captain-t1')
  assert.equal(list[0].title, '任务 a')
  assert.equal(list[0].output, '产出 a')
  assert.equal(list[0].completedAt, 1787148078118)
})

test('extractCompletedTasks: 非 completed 任务不提取', () => {
  const bridge = createEvalBridge({})
  const team = makeTeam('t1', [
    completedTask('done'),
    { id: 'pending', subject: 'p', status: 'pending' },
    { id: 'progress', subject: 'p', status: 'in_progress' },
  ])
  assert.equal(bridge.extractCompletedTasks('/x', 't1', team).length, 1)
})

test('scan: 新 completed 任务触发 onTaskCompleted（多团队）', async () => {
  const { root, cleanup } = makeStateRoot({
    teamA: makeTeam('teamA', [completedTask('a1')]),
    teamB: makeTeam('teamB', [completedTask('b1')]),
  })
  const fed = []
  const bridge = createEvalBridge({ dirs: [root], onTaskCompleted: (t) => { fed.push(t) } })
  const r = await bridge.scan()
  cleanup()
  assert.equal(r.processed, 2)
  assert.deepEqual(fed.map((t) => t.taskId).sort(), ['teamA/a1', 'teamB/b1'].sort())
})

test('scan: 幂等——同任务只喂一次（进程内 seen）', async () => {
  const { root, cleanup } = makeStateRoot({ teamA: makeTeam('teamA', [completedTask('a1')]) })
  const fed = []
  const bridge = createEvalBridge({ dirs: [root], onTaskCompleted: (t) => { fed.push(t) } })
  await bridge.scan()
  await bridge.scan()
  await bridge.scan()
  cleanup()
  assert.equal(fed.length, 1)
})

test('scan: 团队状态损坏 / 目录缺失不阻断其余', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-bridge-bad-'))
  mkdirSync(join(root, 'good'), { recursive: true })
  writeFileSync(join(root, 'good', 'team.json'), JSON.stringify(makeTeam('good', [completedTask('g1')])))
  mkdirSync(join(root, 'broken'), { recursive: true })
  writeFileSync(join(root, 'broken', 'team.json'), '{ not json')
  const fed = []
  const bridge = createEvalBridge({ dirs: [root, join(root, 'no-such-dir')], onTaskCompleted: (t) => { fed.push(t) } })
  const r = await bridge.scan()
  rmSync(root, { recursive: true, force: true })
  assert.equal(fed.length, 1)
  assert.equal(fed[0].taskId, 'good/g1')
  assert.equal(r.processed, 1)
})

test('scan: 持久化 seenFile——重建桥后不重喂', async () => {
  const { root, cleanup } = makeStateRoot({ teamA: makeTeam('teamA', [completedTask('a1')]) })
  const seenFile = join(mkdtempSync(join(tmpdir(), 'eval-bridge-seen-')), 'seen.json')
  const fed1 = []
  const b1 = createEvalBridge({ dirs: [root], seenFile, onTaskCompleted: (t) => { fed1.push(t) } })
  await b1.scan()
  // 模拟重启：同一 dirs + 同一 seenFile 的新桥
  const fed2 = []
  const b2 = createEvalBridge({ dirs: [root], seenFile, onTaskCompleted: (t) => { fed2.push(t) } })
  await b2.scan()
  cleanup()
  assert.equal(fed1.length, 1)
  assert.equal(fed2.length, 0, '重启后不应重喂历史任务')
  assert.ok(readFileSync(seenFile, 'utf8').includes('teamA/a1'))
})

test('scan: 新任务在旧任务之后仍会被处理（增量）', async () => {
  const { root, cleanup } = makeStateRoot({ teamA: makeTeam('teamA', [completedTask('a1')]) })
  const fed = []
  const bridge = createEvalBridge({ dirs: [root], onTaskCompleted: (t) => { fed.push(t) } })
  await bridge.scan()
  // 追加一个新 completed 任务
  const team = makeTeam('teamA', [completedTask('a1'), completedTask('a2')])
  writeFileSync(join(root, 'teamA', 'team.json'), JSON.stringify(team))
  await bridge.scan()
  cleanup()
  assert.deepEqual(fed.map((t) => t.taskId).sort(), ['teamA/a1', 'teamA/a2'].sort())
})

test('start/stop: 空 dirs 不启动；status 反映 enabled', () => {
  const b1 = createEvalBridge({})
  b1.start()
  assert.equal(b1.status().enabled, false)

  const { root, cleanup } = makeStateRoot({ teamA: makeTeam('teamA', [completedTask('a1')]) })
  const fed = []
  const b2 = createEvalBridge({ dirs: [root], pollMs: 50, onTaskCompleted: (t) => { fed.push(t) } })
  b2.start()
  assert.equal(b2.status().enabled, true)
  b2.stop()
  cleanup()
  assert.equal(b2.status().enabled, false)
})
