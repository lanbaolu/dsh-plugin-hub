/**
 * @lanbaolu/dsh-plugin-hub — MCP stdio client（手写 JSON-RPC over stdio，零依赖）。
 *
 * Model Context Protocol 的 stdio transport：spawn 子进程，stdin/stdout 走
 * newline-delimited JSON-RPC 2.0。本文件只做协议层（initialize / notifications/initialized
 * / tools/list / tools/call），工具映射与白名单在 mcp-bridge.js。
 *
 * 安全性：桥接内容来自外部进程，工具一律由调用方（bridge）标注 Experimental 且
 * 只连接配置白名单里的 server（白名单在 mcp-bridge/index.js 层）。
 */
import { spawn } from 'node:child_process'
import { ReadlineInterface } from './readline.js'

/** 默认 MCP 协议版本（广泛兼容）。 */
export const DEFAULT_MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * @param {object} opts
 * @param {string} opts.command 可执行文件
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {string} [opts.name] client 名
 * @param {string} [opts.version] client 版本
 * @param {number} [opts.requestTimeoutMs] 单请求超时（默认 30s）
 */
export class McpStdioClient {
  constructor(opts) {
    this.command = opts.command
    this.args = opts.args ?? []
    this.cwd = opts.cwd
    this.env = opts.env
    this.name = opts.name ?? 'dsh-plugin-hub'
    this.version = opts.version ?? '0.5.0'
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000

    this.child = null
    this.stdin = null
    this.stdout = null
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.nextId = 1
    this.connected = false
    this._closed = false
  }

  /** spawn + initialize + notifications/initialized。 */
  async connect() {
    if (this.connected) return
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.stdin = this.child.stdin
    this.stdout = new ReadlineInterface(this.child.stdout)

    this.stdout.onLine((line) => this._onLine(line))
    this.child.on('error', (e) => this._failAll(`MCP 进程错误：${e.message}`))
    this.child.on('exit', (code) => this._failAll(`MCP 进程退出（code ${code}）`))

    const init = await this.request('initialize', {
      protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.name, version: this.version },
    })
    // 发送 initialized 通知（notification 无 id）
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.connected = true
    this.serverInfo = init?.serverInfo ?? null
    return init
  }

  /** tools/list → { tools: [...] } */
  async listTools() {
    const r = await this.request('tools/list', {})
    return r?.tools ?? []
  }

  /** tools/call → MCP 结果对象。 */
  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args ?? {} })
    return r
  }

  /** 发一个 JSON-RPC 请求并等待 id 匹配的响应（带超时）。 */
  request(method, params) {
    if (this._closed) return Promise.reject(new Error('MCP client 已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}（${this.requestTimeoutMs}ms）`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this._send({ jsonrpc: '2.0', id, method, params: params ?? {} })
    })
  }

  _send(obj) {
    if (this.stdin?.writable) {
      this.stdin.write(JSON.stringify(obj) + '\n')
    } else {
      this._failAll('MCP stdin 不可写')
    }
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id === undefined || msg.id === null) {
      // notification（如 logMessage）——忽略
      return
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.error) pending.reject(new Error(`MCP 错误 ${msg.error.code}: ${msg.error.message}`))
    else pending.resolve(msg.result ?? null)
  }

  _failAll(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /** 关闭子进程。 */
  close() {
    this._closed = true
    this._failAll('MCP client 关闭')
    try { this.child?.kill('SIGTERM') } catch { /* ignore */ }
  }
}

export default McpStdioClient
