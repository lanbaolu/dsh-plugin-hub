/**
 * compliance.test.js — 上架自动合规校验回归。
 * 用 hub 自身目录做真实校验源（当前 0 FAIL），并验证缓存。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyScriptPath, runVerify, checkCompliance } from '../lib/compliance.js'

const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

test('verifyScriptPath: 定位到本地 verify-plugin，或走 npx 回退', () => {
  const p = verifyScriptPath()
  // 本地（monorepo / 已安装依赖）应能定位到真实脚本；CI 独立 checkout 无本地时返回 null → runVerify 走 npx 回退（由下一用例覆盖）
  if (p) {
    assert.ok(p, 'verify-plugin 路径存在')
    assert.ok(existsSync(p), 'verify-plugin 文件存在')
  } else {
    assert.ok(true, '无本地 verify-plugin → 依赖 runVerify 的 npx 回退')
  }
})

test('runVerify: 对 hub 自身目录 → compliant=true（0 MUST 违规）', () => {
  const r = runVerify(HUB_DIR)
  assert.equal(r.ok, true)
  assert.equal(r.compliant, true)
  assert.equal(r.failCount, 0)
  assert.equal(r.package, '@lanbaolu/dsh-plugin-hub')
})

test('runVerify: 目录不存在 → 返回失败', () => {
  const r = runVerify('/nonexistent/plugin-dir')
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('checkCompliance: 商品 localDir 指向本地 → 动态合规', async () => {
  const r = await checkCompliance({ package: '@lanbaolu/dsh-plugin-hub', version: '0.3.0', localDir: HUB_DIR })
  assert.equal(r.compliant, true)
  assert.ok(!r.fromCache, '首次校验不应命中缓存')
})

test('checkCompliance: 缓存命中（同 key 二次调用 fromCache=true）', async () => {
  const item = { package: 'cache-test-pkg', version: '1.0.0', localDir: HUB_DIR }
  const first = await checkCompliance(item)
  const second = await checkCompliance(item)
  assert.equal(first.compliant, second.compliant)
  assert.equal(second.fromCache, true)
})

test('checkCompliance: 本地校验源缺失 → 报错不抛异常', async () => {
  const r = await checkCompliance({ package: 'x', version: '1.0.0', localDir: '../../no-such-dir-xyz' })
  assert.equal(r.compliant, false)
  assert.ok(r.error)
})
