/**
 * failsoft-web.test.js — 进程级启动包装器决策逻辑回归。
 * decideRestart 为纯函数：正常退出/插件隔离重拉/未知崩溃只给一次机会。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideRestart } from '../scripts/failsoft-web.mjs'

test('正常退出(0) → 不重拉', () => {
  assert.deepEqual(decideRestart({ code: 0, quarantinedNew: 0, restarts: 0, maxRestarts: 3 }), {
    restart: false,
    reason: 'normal-exit',
  })
})

test('崩溃 + 新隔离 + 未达上限 → 重拉（quarantined）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedNew: 2, restarts: 0, maxRestarts: 3 }), {
    restart: true,
    reason: 'quarantined',
    quarantinedNew: 2,
  })
})

test('崩溃 + 新隔离 + 达上限 → 停止（max-restarts）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedNew: 1, restarts: 3, maxRestarts: 3 }), {
    restart: false,
    reason: 'max-restarts',
  })
})

test('崩溃 + 无新隔离 + 首次 → 给一次机会（unknown-once）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedNew: 0, restarts: 0, maxRestarts: 3 }), {
    restart: true,
    reason: 'unknown-once',
  })
})

test('崩溃 + 无新隔离 + 已重试过 → 停止（not-plugin，非插件问题）', () => {
  assert.deepEqual(decideRestart({ code: 1, quarantinedNew: 0, restarts: 1, maxRestarts: 3 }), {
    restart: false,
    reason: 'not-plugin',
  })
})

test('读不到隔离数(-1)视为无新隔离', () => {
  const r = decideRestart({ code: 1, quarantinedNew: 0, restarts: 0, maxRestarts: 3 })
  assert.equal(r.restart, true)
  assert.equal(r.reason, 'unknown-once')
})
