/**
 * @lanbaolu/dsh-plugin-hub — 上架自动合规校验（Compliant 徽章动态生成）。
 *
 * 市场哲学：合规是门槛。`Compliant` 徽章不由人工标注，而是在展示/上架时
 * 用 dsh-plugin-standard 的 verify-plugin 自动校验生成（0 MUST 违规 = 合规）。
 *
 * 校验源解析优先级：
 *  1. 商品有 localDir（本地工作区目录）→ 直接校验；
 *  2. 否则对 source（npm 包 / GitHub tarball）npm pack 到临时目录后校验。
 * 结果按 (package, version) 缓存 TTL（默认 5 分钟），避免每次展示都 spawn。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CACHE_TTL_MS = 5 * 60 * 1000

/** 本包根目录（用于 resolve 商品的 localDir 相对路径）。 */
const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 定位 verify-plugin 脚本：环境变量 > 已安装依赖 > monorepo 开发布局 > null。
 * 返回的是可 `node <path> <dir> --json` 直接执行的真实脚本路径（非 .bin shim）。
 */
export function verifyScriptPath() {
  if (process.env.DSH_PLUGIN_STANDARD_VERIFY) return process.env.DSH_PLUGIN_STANDARD_VERIFY
  // 1) 本项目已安装的 dsh-plugin-standard（npm 分发环境：用户端 / 独立 CI checkout）
  const installed = join(HUB_DIR, 'node_modules', 'dsh-plugin-standard', 'scripts', 'verify-plugin.mjs')
  if (existsSync(installed)) return installed
  // 2) monorepo 开发布局（本仓库 插件/ 下相邻目录）
  const local = join(HUB_DIR, '..', 'dsh-plugin-standard', 'scripts', 'verify-plugin.mjs')
  if (existsSync(local)) return local
  return null
}

/**
 * 对插件目录跑 verify-plugin（--json）。
 * @param {string} dir 插件目录（含 package.json）
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{ok: boolean, compliant: boolean, package?: string, version?: string, failCount?: number, warnCount?: number, fails?: string[], error?: string}}
 */
/**
 * 对插件目录跑 verify-plugin（--json）。
 * @param {string} dir 插件目录（含 package.json）
 * @param {{timeoutMs?: number, koishi?: boolean}} [opts] koishi=true 走 --koishi 兼容校验（生态桥 F1）
 * @returns {{ok: boolean, compliant: boolean, package?: string, version?: string, failCount?: number, warnCount?: number, fails?: string[], error?: string}}
 */
export function runVerify(dir, { timeoutMs = 60_000, koishi = false, compat = false } = {}) {
  const script = verifyScriptPath()
  const flags = []
  if (koishi) flags.push('--koishi')
  if (compat) flags.push('--compat')
  let cmd, args
  if (script) {
    cmd = 'node'
    args = [script, dir, ...flags, '--json']
  } else {
    // 回退：npx 在线解析 dsh-plugin-standard（不依赖 monorepo 布局；与 CI verify job 同源）
    cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    args = ['--yes', 'dsh-plugin-standard@2', dir, ...flags, '--json']
  }
  let r
  try {
    r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs })
  } catch (e) {
    return { ok: false, compliant: false, error: `verify-plugin 执行失败：${e instanceof Error ? e.message : String(e)}` }
  }
  let data = null
  try { data = JSON.parse(r.stdout ?? '') } catch { /* 非 JSON */ }
  if (!data || !data.summary) {
    return { ok: false, compliant: false, error: `verify-plugin 输出不可解析（exit ${r.status}）：${String(r.stderr ?? '').slice(0, 200)}` }
  }
  return {
    ok: true,
    compliant: data.summary.fail === 0,
    package: data.package,
    version: data.version,
    failCount: data.summary.fail,
    warnCount: data.summary.warn,
    infoCount: data.summary.info,
    fails: (data.results ?? []).filter((x) => x.level === 'FAIL').map((x) => `${x.clause} ${x.message}`),
    compat: data.compat ?? null, // --compat 判级：Compliant | COMPAT | Not-Compliant
  }
}

/** 把 npm 源（包名/tarball URL）pack 到临时目录并解压，返回可校验目录。 */
function unpackToTemp(source) {
  const tmp = mkdtempSync(join(tmpdir(), 'plugin-hub-verify-'))
  try {
    const pack = spawnSync('npm', ['pack', source, '--pack-destination', tmp, '--silent'], { encoding: 'utf8', timeout: 120_000 })
    const tgzName = String(pack.stdout ?? '').trim().split('\n').pop()
    if (!tgzName || !existsSync(join(tmp, tgzName))) {
      rmSync(tmp, { recursive: true, force: true })
      return { error: `npm pack 失败：${String(pack.stderr ?? '').slice(0, 200)}` }
    }
    const extract = spawnSync('tar', ['-xzf', join(tmp, tgzName), '-C', tmp], { encoding: 'utf8', timeout: 60_000 })
    if (extract.status !== 0) {
      rmSync(tmp, { recursive: true, force: true })
      return { error: 'tar 解压失败' }
    }
    // npm pack 解压到 <tmp>/package/
    return { dir: join(tmp, 'package'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    return { error: `unpack 异常：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 校验源缓存。 */
const complianceCache = new Map()

/**
 * 对市场商品做合规校验（带缓存）。
 * @param {object} item catalog 商品（含 package/version/source/localDir）
 * @param {{ttlMs?: number}} [opts]
 * @returns {Promise<{compliant: boolean, failCount?: number, warnCount?: number, fails?: string[], error?: string, fromCache?: boolean}>}
 */
export async function checkCompliance(item, { ttlMs = CACHE_TTL_MS } = {}) {
  const key = `${item.package}@${item.version}`
  const cached = complianceCache.get(key)
  if (cached && Date.now() - cached.at < ttlMs) {
    return { ...cached.result, fromCache: true }
  }

  let result
  const verifyOpts = { koishi: item.koishi === true, compat: item.compat === true }
  if (item.localDir) {
    const dir = existsSync(item.localDir) ? item.localDir : resolve(HUB_DIR, item.localDir)
    if (existsSync(dir)) {
      result = runVerify(dir, verifyOpts)
    } else {
      result = { ok: false, compliant: false, error: `本地校验源不存在：${dir}` }
    }
  } else {
    const unpacked = unpackToTemp(item.source)
    if (unpacked.error) {
      result = { ok: false, compliant: false, error: unpacked.error }
    } else {
      try {
        result = runVerify(unpacked.dir, verifyOpts)
      } finally {
        unpacked.cleanup?.()
      }
    }
  }

  const out = {
    compliant: result.compliant === true,
    failCount: result.failCount,
    warnCount: result.warnCount,
    fails: result.fails,
    error: result.error,
    package: result.package,
    version: result.version,
    compat: result.compat ?? null,
    at: new Date().toISOString(),
  }
  complianceCache.set(key, { at: Date.now(), result: out })
  return out
}

export default checkCompliance
