#!/usr/bin/env node
/**
 * @lanbaolu/dsh-plugin-hub — suite:doctor CLI。
 *
 * 用法：
 *   node scripts/doctor-cli.mjs          # 人类可读 + JSON
 *   node scripts/doctor-cli.mjs --json   # 纯 JSON（供脚本/市场 UI 消费）
 *
 * 退出码：0 = PLATFORM_READY；2 = NEEDS_RESTART；1 = NEEDS_FIX。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runDoctor, STATUS_READY, STATUS_RESTART } from '../lib/doctor.js'

const PROFILE = argValue('--profile') ?? process.env.DSH_PROFILE ?? 'web'
function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 从 profile 依赖树解析 fail-soft（hub 自身不一定有 node_modules 链接）。 */
const profileRequire = createRequire(join(homedir(), '.dsh', 'profiles', PROFILE, 'package.json'))

/** fail-soft 内核补丁健康（复用 heal.getPatchStatus；失败不阻塞，报告 FIX）。 */
async function checkPatch() {
  try {
    const healPath = profileRequire.resolve('@lanbaolu/dsh-fail-soft/lib/heal.js')
    const { getPatchStatus } = await import(pathToFileURL(healPath).href)
    return await getPatchStatus()
  } catch (e) {
    return { status: 'failed', error: `无法加载 @lanbaolu/dsh-fail-soft（平台层未装?）：${e instanceof Error ? e.message : String(e)}` }
  }
}

function checkInjectorRegistry() {
  const file = join(homedir(), '.dsh', 'super-injector', 'registry.json')
  if (!existsSync(file)) return { ok: false, detail: `injector registry 缺失：${file}` }
  try {
    JSON.parse(readFileSync(file, 'utf8'))
    return { ok: true, detail: file }
  } catch (e) {
    return { ok: false, detail: `injector registry 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

function checkHubService() {
  return { ok: true, detail: '@lanbaolu/dsh-plugin-hub' }
}

const jsonOnly = process.argv.includes('--json')

const result = await runDoctor({ checkPatch, checkInjectorRegistry, checkHubService })

if (jsonOnly) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} else {
  process.stdout.write(`===== suite:doctor — ${result.status} (${result.ok}/${result.total}) =====\n`)
  for (const c of result.checks) {
    process.stdout.write(`- [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}\n`)
  }
  if (result.blockers.length > 0) {
    process.stdout.write('\n阻塞项：\n')
    for (const b of result.blockers) process.stdout.write(`  - ${b}\n`)
  }
  if (result.status === STATUS_RESTART) {
    process.stdout.write('\n提示：请重启 dsh web（使 fail-soft 内核补丁生效），然后重跑本命令。\n')
  }
}

process.exit(result.status === STATUS_READY ? 0 : result.status === STATUS_RESTART ? 2 : 1)
