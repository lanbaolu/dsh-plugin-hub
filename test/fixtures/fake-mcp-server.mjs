#!/usr/bin/env node
/**
 * 假 MCP stdio server（测试用）：实现 initialize / notifications/initialized /
 * tools/list / tools/call（echo 与 add 两个工具）。
 */
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    })
  } else if (msg.method === 'notifications/initialized') {
    // 通知，不响应
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'echo', description: 'echo text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'text to echo' } }, required: ['text'] },
          },
          {
            name: 'add', description: 'add two numbers',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          },
        ],
      },
    })
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + args.text }], isError: false } })
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.a + args.b) }], isError: false } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } })
    }
  }
})
