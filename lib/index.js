/**
 * @lanbaolu/dsh-plugin-hub — DSH 插件治理平台（平台层服务入口）。
 *
 * 提供：
 *  1. `plugin_hub_doctor` / `plugin_hub_status` 工具（agent 可调用）；
 *  2. `GET /api/plugin-hub/health|doctor|status|catalog` + `POST install|quarantine|restore`；
 *  3. 市场安装前置门：**非 PLATFORM_READY 拒绝安装任何插件**（第一原则）；
 *  4. 超时护栏：平台自身工具加超时，示范"挂起 → 可捕获错误"。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runDoctor, STATUS_READY } from './doctor.js'
import { wrapToolWithTimeout } from './timeout-guard.js'
import { createMarket } from './market.js'
import { getCatalog } from './catalog.js'
import { checkCompliance } from './compliance.js'
import { createMcpBridge } from './mcp-bridge.js'

export const name = 'dsh-plugin-hub'
export const inject = ['tools', 'webServer']

/** 默认配置（无 zod 依赖，保持手写 JS 零构建）。 */
export const DEFAULT_CONFIG = {
  /** 平台工具执行超时（ms）；把挂起转成可捕获超时错误。 */
  toolTimeoutMs: 120_000,
  /** 目标 profile 名（决定装配/隔离写哪个 profile）。 */
  profile: 'web',
  /** MCP 生态桥白名单：只连接显式列出的 server（name/command/args），工具标 Experimental。 */
  mcpServers: [],
}

/** profile 目录（从 ctx.baseUrl 推导，回退 ~/.dsh/profiles/<profile>）。 */
function profileDirOf(ctx, profile) {
  try {
    if (ctx.baseUrl) {
      const path = fileURLToPath(ctx.baseUrl)
      return path.endsWith('/') ? path.slice(0, -1) : dirname(path)
    }
  } catch { /* fallthrough */ }
  return join(homedir(), '.dsh', 'profiles', profile)
}

/** 从 profile 依赖树解析 fail-soft 的 patch 操作（隔离/恢复/读列表）。 */
async function failSoftOps(ctx, profile) {
  const pd = profileDirOf(ctx, profile)
  const req = createRequire(join(pd, 'package.json'))
  const ops = await import(pathToFileURL(req.resolve('@lanbaolu/dsh-fail-soft/lib/patch-ops.js')).href)
  return {
    profileDir: pd,
    readQuarantinedIds: () => ops.readPatchEntries(pd).entries.filter((e) => e.quarantined).map((e) => e.id),
    quarantinePlugin: (id, name, reason) => ops.quarantinePlugin(pd, id, name, reason),
    removePatchEntry: (id) => ops.removePatchEntry(pd, id),
  }
}

/** 检查某包是否已装配到 profile。 */
function isInstalled(pd, pkg) {
  return existsSync(join(pd, 'node_modules', pkg))
}

export function apply(ctx, config = {}) {
  const profile = config.profile ?? DEFAULT_CONFIG.profile
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_CONFIG.toolTimeoutMs
  const pd = profileDirOf(ctx, profile)
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  const checkPatch = async () => {
    try {
      const req = createRequire(join(pd, 'package.json'))
      const { getPatchStatus } = await import(pathToFileURL(req.resolve('@lanbaolu/dsh-fail-soft/lib/heal.js')).href)
      return await getPatchStatus()
    } catch (e) {
      return { status: 'failed', error: `无法加载 fail-soft heal：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const checkInjectorRegistry = () => {
    const file = join(homedir(), '.dsh', 'super-injector', 'registry.json')
    if (!existsSync(file)) return { ok: false, detail: `injector registry 缺失：${file}` }
    return { ok: true, detail: file }
  }
  const checkHubService = () => ({ ok: true, detail: `@lanbaolu/dsh-plugin-hub v0.1.0` })

  // ═══ 平台服务 ═══
  const hub = {
    async doctor() {
      return runDoctor({ checkPatch, checkInjectorRegistry, checkHubService })
    },
  }
  ctx.provide('pluginHub', hub)

  // ═══ MCP 生态桥（供给面；白名单 = mcpServers；工具 Experimental，平台不背书）═══
  const bridge = createMcpBridge({
    servers: config.mcpServers ?? [],
    name: 'dsh-plugin-hub',
    version: '0.5.0',
    requestTimeoutMs: toolTimeoutMs,
  })
  void (async () => {
    const results = await bridge.connectAll()
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      ctx.logger?.warn?.('[@lanbaolu/dsh-plugin-hub] MCP 桥部分连接失败：%s', failed.map((f) => `${f.name}: ${f.error}`).join('; '))
    }
    const mapped = await bridge.mappedTools()
    if (mapped.length > 0) {
      const registerMcp = () => {
        const tools = ctx.get('tools')
        if (!tools) return
        for (const t of mapped) {
          ctx.effect(() => tools.register(wrapToolWithTimeout(t, toolTimeoutMs)), `@lanbaolu/dsh-plugin-hub: mcp:${t.name}`)
        }
        ctx.logger?.info?.('[@lanbaolu/dsh-plugin-hub] MCP 桥已注册 %d 个工具（Experimental）', mapped.length)
      }
      registerMcp()
      if (!ctx.get('tools')) {
        ctx.on('internal/service', (s) => { if (s === 'tools') registerMcp() })
      }
    }
  })().catch((e) => ctx.logger?.warn?.('[@lanbaolu/dsh-plugin-hub] MCP 桥初始化失败：%s', String(e)))

  // ═══ 市场服务（依赖注入组装）═══
  let market = null
  const marketReady = failSoftOps(ctx, profile).then((ops) => {
    market = createMarket({
      doctor: () => hub.doctor(),
      checkInstalled: (pkg) => isInstalled(pd, pkg),
      readQuarantinedIds: () => ops.readQuarantinedIds(),
      quarantinePlugin: ops.quarantinePlugin,
      removePatchEntry: ops.removePatchEntry,
      checkCompliance: (item) => checkCompliance(item),
      spawnInstall: (source) => {
        const r = spawnSync('dsh', ['plugin', '--profile', profile, 'add', source], { stdio: 'pipe' })
        return { ok: r.status === 0, error: r.status === 0 ? undefined : String(r.stderr ?? '').slice(0, 400) }
      },
    })
    return ops
  })

  // ═══ 延迟注册（tools / webServer 可用时增强）═══
  let toolsRegistered = false
  let webServerRegistered = false
  const registerIfReady = () => {
    const tools = ctx.get('tools')
    const webServer = ctx.get('webServer')
    if (tools && !toolsRegistered) {
      toolsRegistered = true
      const baseTools = [
        defineTool({
          name: 'plugin_hub_doctor',
          description: '运行 DSH 插件治理平台健康自检（suite:doctor）：返回 PLATFORM_READY / NEEDS_RESTART / NEEDS_FIX 三态。PLATFORM_READY 才允许在市场安装插件。',
          parameters: {},
          output: textOutput,
          async execute() { return JSON.stringify(await hub.doctor(), null, 2) },
        }),
        defineTool({
          name: 'plugin_hub_status',
          description: '查询平台是否就绪（PLATFORM_READY 布尔）。市场安装任何插件前必须确认 true。',
          parameters: {},
          output: textOutput,
          async execute() {
            const d = await hub.doctor()
            return JSON.stringify({ ready: d.status === STATUS_READY, ...d }, null, 2)
          },
        }),
        defineTool({
          name: 'plugin_hub_catalog',
          description: '列出市场目录：可安装的功能插件 + 质量徽章（Compliant/Verified/Stable/Experimental/COMPAT）+ 安装/隔离状态。',
          parameters: {},
          output: textOutput,
          async execute() {
            const m = await marketReady
            return JSON.stringify(await m.status(), null, 2)
          },
        }),
        defineTool({
          name: 'plugin_hub_install',
          description: '从市场安装一个功能插件。前置条件：平台必须 PLATFORM_READY（第一原则：插件错误不挡服务拉起）；非就绪会拒绝并给出 blockers。',
          parameters: {
            id: { type: 'string', required: true, description: '市场插件 id（见 plugin_hub_catalog）' },
          },
          output: textOutput,
          async execute(args) {
            const m = await marketReady
            return JSON.stringify(await m.install(String(args.id)), null, 2)
          },
        }),
        defineTool({
          name: 'plugin_hub_quarantine',
          description: '手动隔离一个市场插件（写 fail-soft 隔离标记的 disabled patch），下次启动跳过。',
          parameters: {
            id: { type: 'string', required: true, description: '市场插件 id' },
            reason: { type: 'string', description: '隔离原因（可选）' },
          },
          output: textOutput,
          async execute(args) {
            const m = await marketReady
            return JSON.stringify(await m.quarantine(String(args.id), undefined, args.reason), null, 2)
          },
        }),
        defineTool({
          name: 'plugin_hub_restore',
          description: '恢复一个被隔离的市场插件（只删带隔离标记的条目），重启后重新装配。',
          parameters: {
            id: { type: 'string', required: true, description: '市场插件 id' },
          },
          output: textOutput,
          async execute(args) {
            const m = await marketReady
            return JSON.stringify(await m.restore(String(args.id)), null, 2)
          },
        }),
      ]
      for (const tool of baseTools) {
        const guarded = wrapToolWithTimeout(tool, toolTimeoutMs)
        ctx.effect(() => tools.register(guarded), `@lanbaolu/dsh-plugin-hub: ${tool.name}`)
      }
    }
    if (webServer && !webServerRegistered) {
      webServerRegistered = true
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/plugin-hub',
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://localhost')
          const path = url.pathname
          const send = (code, data) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(data))
          }
          try {
            if (req.method === 'GET' && path === '/api/plugin-hub/health') {
              send(200, { ok: true, service: 'dsh-plugin-hub', version: '0.1.0' })
            } else if (req.method === 'GET' && (path === '/api/plugin-hub/doctor' || path === '/api/plugin-hub')) {
              send(200, await hub.doctor())
            } else if (req.method === 'GET' && path === '/api/plugin-hub/catalog') {
              const m = await marketReady
              send(200, await m.status())
            } else if (req.method === 'POST' && path === '/api/plugin-hub/install') {
              const body = JSON.parse(await readBody(req))
              const m = await marketReady
              send(200, await m.install(String(body.id)))
            } else if (req.method === 'POST' && path === '/api/plugin-hub/quarantine') {
              const body = JSON.parse(await readBody(req))
              const m = await marketReady
              send(200, await m.quarantine(String(body.id), undefined, body.reason))
            } else if (req.method === 'POST' && path === '/api/plugin-hub/restore') {
              const body = JSON.parse(await readBody(req))
              const m = await marketReady
              send(200, await m.restore(String(body.id)))
            } else {
              send(404, { ok: false, error: 'not found' })
            }
          } catch (error) {
            send(500, { ok: false, error: String(error) })
          }
        },
      }), '@lanbaolu/dsh-plugin-hub: api')
    }
    if (toolsRegistered || webServerRegistered) {
      ctx.logger?.info?.('[@lanbaolu/dsh-plugin-hub] 平台服务已注册（tools=%s webServer=%s，toolTimeoutMs=%s）', toolsRegistered, webServerRegistered, toolTimeoutMs)
    }
  }
  registerIfReady()
  if (!toolsRegistered || !webServerRegistered) {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName === 'tools' || serviceName === 'webServer') registerIfReady()
    })
  }

  ctx.logger?.info?.('[@lanbaolu/dsh-plugin-hub] 平台就绪（doctor/health/market API 可用）')
}

/** 读请求体（限 256KB）。 */
async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 256 * 1024) throw new Error('body too large')
  }
  return body || '{}'
}
