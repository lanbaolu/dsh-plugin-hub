/**
 * @lanbaolu/dsh-plugin-hub — MCP 生态桥（供给面）。
 *
 * 把外部 MCP server 的工具映射成 DSH 工具（Experimental 标注）。
 * 白名单即 `servers` 配置：只连接显式列出的 server，不任意连远程。
 * 桥接内容平台不背书（市场哲学·特殊通道）。
 */
import { McpStdioClient, DEFAULT_MCP_PROTOCOL_VERSION } from './mcp-client.js'

/**
 * 把一个 MCP tool 映射成 DSH 工具定义（纯函数）。
 * MCP inputSchema（JSON Schema object）→ DSH value-schema 参数。
 * @param {object} mcpTool { name, description?, inputSchema? }
 * @param {string} serverName 用于工具名前缀（防跨 server 冲突）
 * @param {(serverName: string, toolName: string, args: object) => Promise<object>} callFn
 * @returns DSH 工具定义（execute 转发到 MCP tools/call）
 */
export function mapMcpTool(mcpTool, serverName, callFn) {
  const inputSchema = mcpTool.inputSchema ?? {}
  const properties = inputSchema.properties ?? {}
  const required = new Set(inputSchema.required ?? [])
  const parameters = {}
  for (const [pname, schema] of Object.entries(properties)) {
    parameters[pname] = {
      type: schema.type ?? 'string',
      description: schema.description ?? '',
      ...(required.has(pname) ? { required: true } : {}),
    }
  }
  const textOutput = {
    schema: { type: 'string' },
    render: (_a, v) => [{ type: 'text', text: String(v) }],
  }
  return {
    name: `${serverName}_${mcpTool.name}`,
    description: `[MCP:${serverName}] ${mcpTool.description ?? mcpTool.name}（生态桥 Experimental，平台不背书）`,
    parameters,
    output: textOutput,
    async execute(args) {
      const r = await callFn(serverName, mcpTool.name, args ?? {})
      if (r?.isError) throw new Error(`MCP ${serverName}.${mcpTool.name} 返回错误`)
      const texts = (r?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      return texts || JSON.stringify(r ?? {})
    },
  }
}

/**
 * @param {object} deps
 * @param {Array<{name: string, command: string, args?: string[], cwd?: string, env?: Record<string,string>}>} deps.servers 白名单
 * @param {string} [deps.name] client 名
 * @param {string} [deps.version]
 * @param {number} [deps.requestTimeoutMs]
 */
export function createMcpBridge(deps = {}) {
  const servers = deps.servers ?? []
  const clients = new Map()

  return {
    /** 连接全部白名单 server（单个失败不阻断其余，返回每 server 结果）。 */
    async connectAll() {
      const results = []
      for (const cfg of servers) {
        if (!cfg || !cfg.name || !cfg.command) {
          results.push({ name: cfg?.name ?? '?', ok: false, error: '配置缺 name/command' })
          continue
        }
        if (clients.has(cfg.name)) {
          results.push({ name: cfg.name, ok: true, cached: true })
          continue
        }
        const client = new McpStdioClient({
          command: cfg.command, args: cfg.args, cwd: cfg.cwd, env: cfg.env,
          name: deps.name, version: deps.version, requestTimeoutMs: deps.requestTimeoutMs,
        })
        try {
          await client.connect()
          clients.set(cfg.name, client)
          results.push({ name: cfg.name, ok: true, serverInfo: client.serverInfo })
        } catch (e) {
          client.close()
          results.push({ name: cfg.name, ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
      return results
    },

    /** 已连接 server 的原始工具列表。 */
    async listTools(serverName) {
      const client = clients.get(serverName)
      if (!client) return []
      try { return await client.listTools() } catch { return [] }
    },

    /** 全部已连接 server 的映射后 DSH 工具定义。 */
    async mappedTools() {
      const out = []
      for (const [name, client] of clients) {
        let tools = []
        try { tools = await client.listTools() } catch { continue }
        for (const t of tools) {
          out.push(mapMcpTool(t, name, async (sn, tn, args) => {
            const c = clients.get(sn)
            if (!c) throw new Error(`MCP server 未连接：${sn}`)
            return c.callTool(tn, args)
          }))
        }
      }
      return out
    },

    /** 转发一次工具调用。 */
    async call(serverName, toolName, args) {
      const client = clients.get(serverName)
      if (!client) throw new Error(`MCP server 未连接：${serverName}`)
      return client.callTool(toolName, args)
    },

    /** 关闭全部 server 子进程。 */
    closeAll() {
      for (const c of clients.values()) c.close()
      clients.clear()
    },
  }
}

export { DEFAULT_MCP_PROTOCOL_VERSION }
export default createMcpBridge
