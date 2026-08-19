/**
 * @lanbaolu/dsh-plugin-hub — 超时护栏（三层金字塔·第 3 层核心）。
 *
 * 把"插件挂起"转成"可捕获的超时错误"（code ETIMEOUT），使挂起不再是无响应黑洞，
 * 而是可以被 fail-soft / 调用方捕获、隔离、重试。纯函数，可独立测试。
 */
/** 统一的超时错误码（调用方/fail-soft 可据此识别"挂起超时"）。 */
export const TIMEOUT_ERROR_CODE = 'ETIMEOUT'

/**
 * 给一个 Promise 加超时上限。
 * @param {Promise} promise
 * @param {number} ms 超时毫秒
 * @param {string} [label] 用于错误信息（如 "tool:xxx"）
 * @returns {Promise} 超时则以 code=ETIMEOUT 的 Error 拒绝
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} 超时（${ms}ms），已由超时护栏截断`)
      err.code = TIMEOUT_ERROR_CODE
      reject(err)
    }, ms)
  })
  // 竞速：先完成者胜；无论谁胜都清理定时器（防泄漏）
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => clearTimeout(timer))
}

/**
 * 包装一个 DSH 工具定义，给其 execute 加超时护栏。
 * 保持 name/description/parameters/output 不变，只替换 execute。
 * @param {object} definition DSH 工具定义（含 execute）
 * @param {number} ms 超时毫秒
 * @returns {object} 包装后的工具定义
 */
export function wrapToolWithTimeout(definition, ms) {
  if (!definition || typeof definition.execute !== 'function') return definition
  const { execute } = definition
  const name = definition.name ?? 'unknown-tool'
  return {
    ...definition,
    execute: (args, ctx) => withTimeout(Promise.resolve(execute(args, ctx)), ms, `tool:${name}`),
  }
}

export default withTimeout
