/**
 * @lanbaolu/dsh-plugin-hub — DSH 插件治理平台（平台层服务入口）。
 *
 * 提供：
 *  1. `plugin_hub_doctor` 工具 / `plugin_hub_status` —— agent 可调用的平台健康检查；
 *  2. `GET /api/plugin-hub/health`（存活）与 `GET /api/plugin-hub/doctor`（三态自检）；
 *  3. 市场安装前置门的数据源：非 PLATFORM_READY 时市场 UI 拒绝安装任何插件。
 *
 * 平台层随套件安装；功能插件是市场内容，本插件不声明任何功能插件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runDoctor, STATUS_READY } from './doctor.js'

export const name = 'dsh-plugin-hub'

/** super-injector 的注入清单文件（registry）。 */
function injectorRegistryPath() {
  return join(homedir(), '.dsh', 'super-injector', 'registry.json')
}

/** fail-soft 内核补丁健康（复用 @lanbaolu/dsh-fail-soft 的 heal.getPatchStatus）。 */
async function checkPatch() {
  try {
    const { getPatchStatus } = await import('@lanbaolu/dsh-fail-soft/lib/heal.js')
    return await getPatchStatus()
  } catch (e) {
    return { status: 'failed', error: `无法加载 fail-soft heal：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** super-injector registry 可达性。 */
function checkInjectorRegistry() {
  const file = injectorRegistryPath()
  if (!existsSync(file)) return { ok: false, detail: `injector registry 缺失：${file}` }
  try {
    JSON.parse(readFileSync(file, 'utf8'))
    return { ok: true, detail: file }
  } catch (e) {
    return { ok: false, detail: `injector registry 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** plugin-hub 自身服务。 */
function checkHubService() {
  return { ok: true, detail: `@lanbaolu/dsh-plugin-hub v0.1.0` }
}

export function apply(ctx) {
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  // ═══ 服务对象（供工具 / HTTP API 复用）═══
  const hub = {
    async doctor() {
      return runDoctor({ checkPatch, checkInjectorRegistry, checkHubService })
    },
    ready() {
      return true // 自身永远可达
    },
  }
  ctx.provide('pluginHub', hub)

  // ═══ 延迟注册（tools / webServer 可用时增强，缺 base 的 profile 不炸）═══
  let toolsRegistered = false
  let webServerRegistered = false
  const registerIfReady = () => {
    const tools = ctx.get('tools')
    const webServer = ctx.get('webServer')
    if (tools && !toolsRegistered) {
      toolsRegistered = true
      ctx.effect(() => tools.register(defineTool({
        name: 'plugin_hub_doctor',
        description: '运行 DSH 插件治理平台健康自检（suite:doctor）：返回 PLATFORM_READY / NEEDS_RESTART / NEEDS_FIX 三态与检查明细。PLATFORM_READY 才允许在市场安装插件。',
        parameters: {},
        output: textOutput,
        async execute() {
          return JSON.stringify(await hub.doctor(), null, 2)
        },
      })), '@lanbaolu/dsh-plugin-hub: doctor tool')

      ctx.effect(() => tools.register(defineTool({
        name: 'plugin_hub_status',
        description: '查询 DSH 插件治理平台是否就绪（PLATFORM_READY 布尔）。市场安装任何插件前必须确认该值为 true。',
        parameters: {},
        output: textOutput,
        async execute() {
          const d = await hub.doctor()
          return JSON.stringify({ ready: d.status === STATUS_READY, ...d }, null, 2)
        },
      })), '@lanbaolu/dsh-plugin-hub: status tool')
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
      ctx.logger?.info?.('[@lanbaolu/dsh-plugin-hub] 平台服务已注册（tools=%s webServer=%s）', toolsRegistered, webServerRegistered)
    }
  }
  registerIfReady()
  if (!toolsRegistered || !webServerRegistered) {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName === 'tools' || serviceName === 'webServer') registerIfReady()
    })
  }

  ctx.logger?.info?.('[@lanbaolu/dsh-plugin-hub] 平台就绪（doctor/health API 可用）')
}
