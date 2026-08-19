/**
 * doctor.test.js — suite:doctor 三态判定回归。
 * doctor.js 为纯逻辑（依赖注入），可独立测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDoctor, STATUS_READY, STATUS_RESTART, STATUS_FIX } from '../lib/doctor.js'

const patchOk = async () => ({ status: 'ok', version: '0.1.0-rc.6' })
const injOk = () => ({ ok: true, detail: 'registry.json' })
const hubOk = () => ({ ok: true, detail: 'hub' })

test('全部就绪 → PLATFORM_READY', async () => {
  const r = await runDoctor({ checkPatch: patchOk, checkInjectorRegistry: injOk, checkHubService: hubOk })
  assert.equal(r.status, STATUS_READY)
  assert.equal(r.ok, 3)
  assert.equal(r.total, 3)
  assert.deepEqual(r.blockers, [])
})

test('fail-soft 补丁 needs-apply（已装未重启）→ NEEDS_RESTART', async () => {
  const r = await runDoctor({
    checkPatch: async () => ({ status: 'needs-apply' }),
    checkInjectorRegistry: injOk,
    checkHubService: hubOk,
  })
  assert.equal(r.status, STATUS_RESTART)
  assert.ok(r.blockers.some((b) => b.includes('needs-apply')))
})

test('fail-soft 补丁 needs-adaptation → NEEDS_FIX', async () => {
  const r = await runDoctor({
    checkPatch: async () => ({ status: 'needs-adaptation', error: 'backup 模板过期' }),
    checkInjectorRegistry: injOk,
    checkHubService: hubOk,
  })
  assert.equal(r.status, STATUS_FIX)
  assert.ok(r.blockers.some((b) => b.includes('needs-adaptation')))
})

test('fail-soft 补丁 no-install → NEEDS_FIX', async () => {
  const r = await runDoctor({
    checkPatch: async () => ({ status: 'no-install', error: '无法定位 DSH 安装' }),
    checkInjectorRegistry: injOk,
    checkHubService: hubOk,
  })
  assert.equal(r.status, STATUS_FIX)
})

test('fail-soft 补丁加载抛错 → 不抛异常，NEEDS_FIX', async () => {
  const r = await runDoctor({
    checkPatch: async () => { throw new Error('heal 不可用') },
    checkInjectorRegistry: injOk,
    checkHubService: hubOk,
  })
  assert.equal(r.status, STATUS_FIX)
  assert.ok(r.blockers.some((b) => b.includes('fail-soft 内核补丁')))
})

test('补丁 ok 但 injector registry 缺失 → NEEDS_FIX（非 RESTART）', async () => {
  const r = await runDoctor({
    checkPatch: patchOk,
    checkInjectorRegistry: () => ({ ok: false, detail: 'injector registry 缺失' }),
    checkHubService: hubOk,
  })
  assert.equal(r.status, STATUS_FIX)
})

test('补丁 ok 但 hub 服务不可用 → NEEDS_FIX', async () => {
  const r = await runDoctor({
    checkPatch: patchOk,
    checkInjectorRegistry: injOk,
    checkHubService: () => ({ ok: false, detail: 'hub 404' }),
  })
  assert.equal(r.status, STATUS_FIX)
})

test('checkPatch 返回未知 status → 视为失败，NEEDS_FIX', async () => {
  const r = await runDoctor({
    checkPatch: async () => ({ status: 'mystery' }),
    checkInjectorRegistry: injOk,
    checkHubService: hubOk,
  })
  assert.equal(r.status, STATUS_FIX)
})

test('返回结构包含 checks/at/ok/total', async () => {
  const r = await runDoctor({ checkPatch: patchOk, checkInjectorRegistry: injOk, checkHubService: hubOk })
  assert.ok(Array.isArray(r.checks))
  assert.ok(r.checks.every((c) => typeof c.name === 'string' && typeof c.ok === 'boolean'))
  assert.ok(r.at)
  assert.equal(typeof r.ok, 'number')
  assert.equal(typeof r.total, 'number')
})
