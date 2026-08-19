/**
 * market.test.js — 市场服务回归（安装前置门 / 隔离 / 恢复 / 状态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarket } from '../lib/market.js'
import { getCatalog } from '../lib/catalog.js'

const READY = async () => ({ status: 'PLATFORM_READY', blockers: [] })
const NOT_READY = async () => ({ status: 'NEEDS_RESTART', blockers: ['fail-soft 内核补丁: needs-apply'] })

function makeDeps(over = {}) {
  return {
    doctor: READY,
    checkInstalled: () => false,
    readQuarantinedIds: () => [],
    spawnInstall: () => ({ ok: true }),
    quarantinePlugin: (id, name) => ({ ok: true, id, name }),
    removePatchEntry: (id) => ({ ok: true, id }),
    ...over,
  }
}

test('install: 平台就绪 + 安装成功', async () => {
  const market = createMarket(makeDeps())
  const r = await market.install('mneme')
  assert.equal(r.ok, true)
  assert.equal(r.action, 'installed')
  assert.equal(r.package, '@modusensus/dsh-mneme')
})

test('install: 非 PLATFORM_READY → 拒绝（第一原则前置门）', async () => {
  const market = createMarket(makeDeps({ doctor: NOT_READY }))
  const r = await market.install('mneme')
  assert.equal(r.ok, false)
  assert.match(r.error, /未就绪/)
  assert.deepEqual(r.blockers, ['fail-soft 内核补丁: needs-apply'])
})

test('install: 目录中无此插件 → 拒绝', async () => {
  const market = createMarket(makeDeps())
  const r = await market.install('nonexistent')
  assert.equal(r.ok, false)
  assert.match(r.error, /目录中无插件/)
})

test('install: 已安装 → 拒绝', async () => {
  const market = createMarket(makeDeps({ checkInstalled: () => true }))
  const r = await market.install('mneme')
  assert.equal(r.ok, false)
  assert.match(r.error, /已安装/)
})

test('install: 安装命令失败 → 返回失败', async () => {
  const market = createMarket(makeDeps({ spawnInstall: () => ({ ok: false, error: 'dsh plugin add 失败' }) }))
  const r = await market.install('mneme')
  assert.equal(r.ok, false)
  assert.match(r.error, /安装失败/)
})

test('quarantine: 调用 fail-soft 隔离并传包名', async () => {
  let called = null
  const market = createMarket(makeDeps({
    quarantinePlugin: (id, name, reason) => { called = { id, name, reason }; return { ok: true } },
  }))
  const r = await market.quarantine('mneme', 'Mneme', '测试')
  assert.equal(r.ok, true)
  assert.deepEqual(called, { id: '@modusensus/dsh-mneme', name: 'Mneme', reason: '测试' })
})

test('restore: 调用 fail-soft 恢复', async () => {
  let restored = null
  const market = createMarket(makeDeps({
    removePatchEntry: (id) => { restored = id; return { ok: true } },
  }))
  const r = await market.restore('mneme')
  assert.equal(r.ok, true)
  assert.equal(restored, '@modusensus/dsh-mneme')
})

test('status: 返回目录 + 安装/隔离状态', async () => {
  const market = createMarket(makeDeps({
    checkInstalled: (pkg) => pkg === 'dsh-usage-stats',
    readQuarantinedIds: () => ['dsh-ai-prompt-optimizer'],
  }))
  const list = await market.status()
  assert.equal(list.length, getCatalog().length)
  const usage = list.find((p) => p.id === 'usage-stats')
  assert.equal(usage.installed, true)
  const prompt = list.find((p) => p.id === 'prompt-optimizer')
  assert.equal(prompt.quarantined, true)
  const mneme = list.find((p) => p.id === 'mneme')
  assert.equal(mneme.installed, false)
  assert.ok(mneme.badges.includes('Compliant'))
})
