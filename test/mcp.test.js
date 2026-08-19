/**
 * mcp.test.js — MCP 生态桥回归（client + bridge + 工具映射）。
 * 用 test/fixtures/fake-mcp-server.mjs 做真实 stdio 端到端。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McpStdioClient } from '../lib/mcp-client.js'
import { mapMcpTool, createMcpBridge } from '../lib/mcp-bridge.js'

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs')
const SERVER_CFG = { name: 'fake', command: process.execPath, args: [FAKE_SERVER] }

// ── mapMcpTool（纯函数）──
test('mapMcpTool: inputSchema → DSH 参数映射（required/type/description）', () => {
  const tool = mapMcpTool(
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'text' }, opt: { type: 'number' } }, required: ['text'] } },
    'fake',
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  )
  assert.equal(tool.name, 'fake_echo')
  assert.match(tool.description, /\[MCP:fake\]/)
  assert.match(tool.description, /Experimental/)
  assert.deepEqual(tool.parameters.text, { type: 'string', description: 'text', required: true })
  assert.deepEqual(tool.parameters.opt, { type: 'number', description: '' }) // 非 required 无 required 字段
})

test('mapMcpTool: execute 转发并提取 text 内容', async () => {
  let called = null
  const tool = mapMcpTool(
    { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    'fake',
    async (sn, tn, args) => { called = { sn, tn, args }; return { content: [{ type: 'text', text: 'echo:' + args.text }] } },
  )
  const out = await tool.execute({ text: 'hi' })
  assert.equal(out, 'echo:hi')
  assert.deepEqual(called, { sn: 'fake', tn: 'echo', args: { text: 'hi' } })
})

test('mapMcpTool: isError 时抛错', async () => {
  const tool = mapMcpTool({ name: 'x', inputSchema: {} }, 'fake', async () => ({ isError: true, content: [] }))
  await assert.rejects(() => tool.execute({}), /返回错误/)
})

// ── McpStdioClient 端到端 ──
test('McpStdioClient: connect → listTools → callTool（真实 stdio 协议）', async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [FAKE_SERVER] })
  try {
    const init = await client.connect()
    assert.equal(init.serverInfo.name, 'fake-mcp')
    const tools = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'add'])
    const r = await client.callTool('echo', { text: 'world' })
    assert.equal(r.content[0].text, 'echo:world')
    const sum = await client.callTool('add', { a: 2, b: 3 })
    assert.equal(sum.content[0].text, '5')
  } finally {
    client.close()
  }
})

test('McpStdioClient: 未知工具 → 错误响应', async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [FAKE_SERVER] })
  try {
    await client.connect()
    await assert.rejects(() => client.callTool('nope', {}), /unknown tool nope/)
  } finally {
    client.close()
  }
})

// ── createMcpBridge ──
test('createMcpBridge: connectAll + mappedTools + call', async () => {
  const bridge = createMcpBridge({ servers: [SERVER_CFG] })
  try {
    const results = await bridge.connectAll()
    assert.equal(results[0].ok, true)
    assert.equal(results[0].serverInfo.name, 'fake-mcp')
    const tools = await bridge.mappedTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['fake_add', 'fake_echo'])
    const echoTool = tools.find((t) => t.name === 'fake_echo')
    assert.equal(await echoTool.execute({ text: 'bridge' }), 'echo:bridge')
  } finally {
    bridge.closeAll()
  }
})

test('createMcpBridge: 配置缺 name/command → 单条失败不阻断', async () => {
  const bridge = createMcpBridge({ servers: [{}, SERVER_CFG] })
  try {
    const results = await bridge.connectAll()
    assert.equal(results[0].ok, false)
    assert.equal(results[1].ok, true)
  } finally {
    bridge.closeAll()
  }
})

test('createMcpBridge: 连接失败（命令不存在）→ 单条失败不抛', async () => {
  const bridge = createMcpBridge({ servers: [{ name: 'bad', command: '/nonexistent/bin/xyz' }] })
  try {
    const results = await bridge.connectAll()
    assert.equal(results[0].ok, false)
  } finally {
    bridge.closeAll()
  }
})
