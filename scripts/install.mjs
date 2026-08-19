#!/usr/bin/env node
/**
 * @lanbaolu/dsh-plugin-hub — 平台层安装器（installer，fail-soft-first）。
 *
 * 用法：
 *   node scripts/install.mjs                     # 装平台层（fail-soft → 重启 → injector + hub）
 *   node scripts/install.mjs --profile staging   # 指定 profile（默认 web）
 *   node scripts/install.mjs --injector <路径>    # 指定 super-injector 来源（默认 npm 包名）
 *
 * 退出码：0 = 平台就绪；2 = 需要重启后重跑；1 = 需要修复（见 blockers）。
 *
 * 核心约束（第一原则）：fail-soft 必须先装并生效，doctor 确认 PLATFORM_READY
 * 之后才允许装其余平台组件 / 市场插件。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runDoctor, STATUS_READY, STATUS_RESTART, STATUS_FIX } from '../lib/doctor.js'

const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = argValue('--profile') ?? 'web'
const INJECTOR_SPEC = argValue('--injector') ?? '@dsh-external/dsh-super-injector'
const FAIL_SOFT_SPEC = '@lanbaolu/dsh-fail-soft'

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const log = (msg) => process.stdout.write(`[hub-install] ${msg}\n`)
const ok = (msg) => process.stdout.write(`  ✓ ${msg}\n`)
const die = (msg, code = 1) => { process.stderr.write(`[hub-install] ✗ ${msg}\n`); process.exit(code) }

// ── 依赖组装（与 doctor-cli 一致）──
const profileRequire = createRequire(join(profileDir(), 'package.json'))
async function checkPatch() {
  try {
    const healPath = profileRequire.resolve('@lanbaolu/dsh-fail-soft/lib/heal.js')
    const { getPatchStatus } = await import(pathToFileURL(healPath).href)
    return await getPatchStatus()
  } catch (e) {
    return { status: 'failed', error: `无法加载 @lanbaolu/dsh-fail-soft：${e instanceof Error ? e.message : String(e)}` }
  }
}
function checkInjectorRegistry() {
  const file = join(homedir(), '.dsh', 'super-injector', 'registry.json')
  if (!existsSync(file)) return { ok: false, detail: `injector registry 缺失：${file}` }
  return { ok: true, detail: file }
}
function checkHubService() {
  return { ok: true, detail: '@lanbaolu/dsh-plugin-hub' }
}

function profileDir() {
  return join(homedir(), '.dsh', 'profiles', PROFILE)
}
function profilePkg() {
  return join(profileDir(), 'package.json')
}
function isInstalled(pkgName) {
  const nm = join(profileDir(), 'node_modules', pkgName)
  if (!existsSync(nm)) return false
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf8'))
    return pkg.dependencies?.[pkgName] != null || pkg.bundles?.includes(pkgName) === true
  } catch { return existsSync(nm) }
}

function dshPluginAdd(spec) {
  const cmd = 'dsh'
  const args = ['plugin', '--profile', PROFILE, 'add', spec]
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  return r.status === 0
}

// ── Step 0：预检 ──
log('Step 0/4 预检')
if (!existsSync(profilePkg())) die(`profile "${PROFILE}" 不存在：${profilePkg()}（先运行一次 dsh web 生成）`)
const dshCheck = spawnSync('dsh', ['--version'], { stdio: 'ignore' })
if (dshCheck.status !== 0) {
  die('未找到 dsh CLI（PATH 中无 dsh）。请先安装/启动 DSH，或将 dsh 加入 PATH 后重试。')
}
ok(`profile ${PROFILE} 存在；dsh CLI 可用`)

// ── Step 1：fail-soft-first ──
log(`Step 1/4 装配容错底座 ${FAIL_SOFT_SPEC}`)
if (isInstalled(FAIL_SOFT_SPEC)) {
  ok(`${FAIL_SOFT_SPEC} 已装配，跳过`)
} else {
  if (!dshPluginAdd(FAIL_SOFT_SPEC)) die(`装配 ${FAIL_SOFT_SPEC} 失败`)
  ok(`已装配 ${FAIL_SOFT_SPEC}`)
}

// ── Step 2：doctor 前置检查 ──
log('Step 2/4 doctor 前置检查（fail-soft 生效才继续）')
const doctor = await runDoctor({ checkPatch, checkInjectorRegistry, checkHubService })
for (const c of doctor.checks) ok(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
if (doctor.status === STATUS_RESTART) {
  die(`需要重启：fail-soft 内核补丁尚未生效。请重启 dsh web，然后重跑本命令（首次安装只需重启一次）。`, 2)
}
if (doctor.status === STATUS_FIX) {
  die(`平台未就绪（${doctor.status}），阻塞项：\n  - ${doctor.blockers.join('\n  - ')}`, 1)
}
ok(`doctor 通过：${STATUS_READY}`)

// ── Step 3：装 injector + hub ──
log(`Step 3/4 装配运维与平台（injector + hub）`)
if (!isInstalled(INJECTOR_SPEC)) {
  if (!dshPluginAdd(INJECTOR_SPEC)) die(`装配 ${INJECTOR_SPEC} 失败`)
  ok(`已装配 ${INJECTOR_SPEC}`)
} else {
  ok(`${INJECTOR_SPEC} 已装配，跳过`)
}
if (!isInstalled('@lanbaolu/dsh-plugin-hub')) {
  if (!dshPluginAdd(HUB_DIR)) die('装配 dsh-plugin-hub 失败')
  ok('已装配 @lanbaolu/dsh-plugin-hub')
} else {
  ok('@lanbaolu/dsh-plugin-hub 已装配，跳过')
}

// ── Step 4：最终 doctor + 引导 ──
log('Step 4/4 最终检查')
const final = await runDoctor({ checkPatch, checkInjectorRegistry, checkHubService })
if (final.status !== STATUS_READY) die(`最终检查未就绪（${final.status}）——请重启 dsh web 后重跑 suite:doctor`)
ok(`平台就绪：${final.status}（${final.ok}/${final.total}）`)
log('')
log('首次引导：')
log('  1. 重启 dsh web 后，打开市场（/api/plugin-hub）即可按需安装功能插件；')
log('  2. 运行 `npm run doctor` 或 `node scripts/doctor-cli.mjs` 随时自检；')
log('  3. 即使装到坏/不兼容插件，服务也不会瘫痪：fail-soft 自动隔离，市场里可一键恢复。')
process.exit(0)
