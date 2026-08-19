/**
 * timeout-guard.test.js — 超时护栏回归。
 * 覆盖：正常完成、超时拒绝（code ETIMEOUT）、定时器清理、工具定义包装不改元数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout, wrapToolWithTimeout, TIMEOUT_ERROR_CODE } from '../lib/timeout-guard.js'

test('withTimeout: 快速 promise 正常返回', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 100), 'ok')
})

test('withTimeout: 慢 promise 超时拒绝（code ETIMEOUT）', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 500))
  await assert.rejects(
    () => withTimeout(slow, 50, 'test-op'),
    (err) => err.code === TIMEOUT_ERROR_CODE && /test-op/.test(err.message),
  )
})

test('withTimeout: 原始拒绝透传（非超时）', async () => {
  const boom = Promise.reject(new Error('original'))
  await assert.rejects(() => withTimeout(boom, 100), /original/)
})

test('withTimeout: 完成即清理定时器（不泄漏）', async () => {
  const timersBefore = process.getActiveResourcesInfo?.().filter((t) => t === 'Timeout').length ?? 0
  await withTimeout(Promise.resolve('x'), 1000)
  await new Promise((r) => setTimeout(r, 20))
  const timersAfter = process.getActiveResourcesInfo?.().filter((t) => t === 'Timeout').length ?? 0
  assert.ok(timersAfter <= timersBefore, `timer 泄漏: ${timersBefore} → ${timersAfter}`)
})

test('wrapToolWithTimeout: 元数据不变，execute 返回原值', async () => {
  const tool = {
    name: 'my_tool',
    description: 'desc',
    parameters: { x: { type: 'string' } },
    async execute(args) { return 'ran:' + args.x },
  }
  const wrapped = wrapToolWithTimeout(tool, 100)
  assert.equal(wrapped.name, 'my_tool')
  assert.equal(wrapped.description, 'desc')
  assert.deepEqual(wrapped.parameters, { x: { type: 'string' } })
  assert.equal(await wrapped.execute({ x: 'a' }), 'ran:a')
})

test('wrapToolWithTimeout: 挂起工具被超时截断（code ETIMEOUT）', async () => {
  const hanging = {
    name: 'hang_tool',
    async execute() { return new Promise(() => { /* 永不返回 */ }) },
  }
  const wrapped = wrapToolWithTimeout(hanging, 50)
  await assert.rejects(
    () => wrapped.execute({}),
    (err) => err.code === TIMEOUT_ERROR_CODE,
  )
})

test('wrapToolWithTimeout: 非工具对象（无 execute）原样返回', () => {
  const obj = { name: 'x' }
  assert.equal(wrapToolWithTimeout(obj, 10), obj)
  assert.equal(wrapToolWithTimeout(undefined, 10), undefined)
})
