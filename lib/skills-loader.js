/**
 * @lanbaolu/dsh-plugin-hub — Skills 生态桥（供给面）。
 *
 * 把外部 skill（markdown 指令 + 附带脚本）转成 DSH 可加载资源（Experimental 标注）。
 * 白名单即 `skillDirs` 配置：只加载显式列出的目录，不任意扫描整个磁盘。
 * 桥接内容平台不背书（市场哲学·特殊通道），与 MCP 生态桥同一套哲学。
 *
 * 资源格式对齐 DSH 实际扫描约定（参考 @liustack/modlens 与 dsh-agent-teams 的 skill）：
 *   skills/<name>/SKILL.md            — YAML frontmatter（name/description…）+ markdown 指令段
 *   skills/<name>/scripts/**          — 附带脚本（指令段里以 <skill-dir>/scripts/xxx 引用）
 *   skills/<name>/references/**       — 附带参考文档
 *
 * 零依赖：frontmatter 用轻量手写 YAML 子集解析（够覆盖常见 SKILL.md），不引入第三方。
 * 纯函数解析层无 IO，可独立单测；IO（目录扫描/物化）集中在桥层。
 */
import {
  existsSync, readFileSync, readdirSync, statSync,
  mkdirSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { join, basename } from 'node:path'

// ═══════════════════════════ 轻量 YAML frontmatter 解析 ═══════════════════════════

/** 提取 markdown 开头 `---\n…\n---` frontmatter 块。无则返回 null。 */
function parseYamlFrontmatter(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!m) return null
  return { raw: m[1], body: markdown.slice(m[0].length) }
}

/** 找到第一个不在引号内的冒号下标（用于拆分 `key: value`）。 */
function indexOfColon(s) {
  let inQ = null
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (inQ) {
      if (c === '\\' && inQ === '"') { k++; continue }
      if (c === inQ) inQ = null
      continue
    }
    if (c === '"' || c === "'") { inQ = c; continue }
    if (c === ':') return k
  }
  return -1
}

/** 按顶层逗号切分（跳过引号内逗号），用于内联 map/array。 */
function splitTopLevel(s, sep = ',') {
  const out = []
  let inQ = null
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (inQ) {
      cur += c
      if (c === '\\' && inQ === '"') continue
      if (c === inQ) inQ = null
      continue
    }
    if (c === '"' || c === "'") { inQ = c; cur += c; continue }
    if (c === '{' || c === '[') depth++
    if (c === '}' || c === ']') depth--
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** 解析内联 map `{ a: 1, b: "x" }`。 */
function parseInlineMap(s) {
  const end = s.lastIndexOf('}')
  const inner = (end >= 0 ? s.slice(1, end) : s.slice(1)).trim()
  if (!inner) return {}
  const out = {}
  for (const part of splitTopLevel(inner)) {
    const ci = indexOfColon(part)
    if (ci < 0) continue
    const key = part.slice(0, ci).trim()
    if (key) out[key] = parseYamlValue(part.slice(ci + 1))
  }
  return out
}

/** 解析 YAML 标量值（裸字符串 / 引号字符串 / 数字 / 布尔 / null / 内联 map）。 */
function parseYamlValue(raw) {
  const s = String(raw).trim()
  if (s === '') return ''
  if (s.startsWith('{')) return parseInlineMap(s)
  if (s.startsWith('[')) return splitTopLevel(s.slice(1, s.lastIndexOf(']') >= 0 ? s.lastIndexOf(']') : undefined), ',').map((x) => parseYamlValue(x)).filter((x) => x !== '')
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const q = s[0]
    let inner = s.slice(1, -1)
    if (q === '"') inner = inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
    else inner = inner.replace(/''/g, "'")
    return inner
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  // 裸字符串：去掉行内注释（` #` 之后）
  const hashIdx = s.indexOf(' #')
  return (hashIdx >= 0 ? s.slice(0, hashIdx) : s).trim()
}

/** 值以未闭合引号开头 → 需要跨行累积。 */
function needsMoreLines(val) {
  if (!val) return false
  const q = val[0]
  if (q !== '"' && q !== "'") return false
  for (let k = 1; k < val.length; k++) {
    const c = val[k]
    if (c === '\\' && q === '"') { k++; continue }
    if (c === q) return false
  }
  return true
}

/**
 * 解析 frontmatter 文本为对象（支持缩进嵌套块与多行引号值）。
 * @param {string} raw frontmatter 内文
 * @param {number} baseIndent 当前层级最小缩进（递归用）
 * @returns {object}
 */
function parseFrontmatterMap(raw, baseIndent = 0) {
  const lines = String(raw).split(/\r?\n/)
  const out = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i].replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) { i++; continue }
    const indent = line.length - line.trimStart().length
    if (indent < baseIndent) break // 已回到上级层级（递归返回）
    if (indent > baseIndent) { i++; continue } // 防御：跳过异常缩进行
    const colonIdx = indexOfColon(trimmed)
    if (colonIdx < 0) { i++; continue }
    const key = trimmed.slice(0, colonIdx).trim()
    let val = trimmed.slice(colonIdx + 1).trim()

    if (needsMoreLines(val)) {
      // 跨行引号值：累积后续行直到引号闭合
      const acc = [val]
      i++
      while (i < lines.length) {
        acc.push(lines[i])
        const joined = acc.join('\n')
        if (!needsMoreLines(joined)) { val = joined; i++; break }
        i++
      }
      out[key] = parseYamlValue(val)
      continue
    }

    if (val === '' || val === '#') {
      // 缩进嵌套块（如 metadata: 下面缩进的子键）
      let j = i + 1
      const nested = []
      while (j < lines.length) {
        const nl = lines[j].replace(/\t/g, '  ')
        const nt = nl.trim()
        if (!nt || nt.startsWith('#')) { j++; continue }
        const nIndent = nl.length - nl.trimStart().length
        if (nIndent > indent) { nested.push(nl); j++ }
        else break
      }
      if (nested.length === 0) {
        out[key] = {}
        i = j
        continue
      }
      // 剥掉公共缩进后再按 0 基线递归（子行缩进必然大于父层级）
      const minIndent = Math.min(...nested.map((l) => l.length - l.trimStart().length))
      out[key] = parseFrontmatterMap(nested.map((l) => l.slice(minIndent)).join('\n'), 0)
      i = j
      continue
    }

    out[key] = parseYamlValue(val)
    i++
  }
  return out
}

// ═══════════════════════════ 纯函数解析层（无 IO，可单测） ═══════════════════════════

/** 指令段里脚本/参考引用的正则（`<skill-dir>/scripts/xxx`、`scripts/xxx`、`references/xxx`）。 */
const PATH_REF_RE = /(?:<skill-dir>\/?|&lt;skill-dir&gt;\/?|\.\/)?(scripts|references)\/([^\s`\]}>)"'，、。；：]+)/g

/**
 * 从指令段提取附带脚本/参考的相对路径引用（去重、去尾标点，返回含 scripts|references 前缀的完整路径）。
 * @param {string} text markdown 指令段
 * @param {'scripts'|'references'} kind
 * @returns {string[]}
 */
export function extractPathRefs(text, kind) {
  const out = []
  PATH_REF_RE.lastIndex = 0
  let m
  while ((m = PATH_REF_RE.exec(text)) !== null) {
    if (m[1] !== kind) continue
    const raw = m[2].replace(/[.,;:)]+$/, '')
    const full = `${m[1]}/${raw}`
    if (!out.includes(full)) out.push(full)
  }
  return out
}

/**
 * 解析一份 SKILL.md 文本为结构化 skill。
 * @param {string} markdown SKILL.md 全文
 * @param {object} [opts]
 * @param {string} [opts.fallbackName] name 缺失时回退（通常为目录名）
 * @returns {{
 *   name: string, description: string, instructions: string,
 *   metadata: object, referencedScripts: string[], referencedReferences: string[],
 *   nameInferred: boolean, warnings: string[],
 * }}
 */
export function parseSkillMarkdown(markdown, { fallbackName } = {}) {
  const fm = parseYamlFrontmatter(markdown)
  const meta = fm ? parseFrontmatterMap(fm.raw) : {}
  const instructions = (fm ? fm.body : markdown).trim()

  const metaName = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : ''

  const warnings = []
  let name
  let nameInferred = false
  if (metaName) {
    name = metaName
  } else if (fallbackName) {
    name = fallbackName
    nameInferred = true
    warnings.push(`缺少 name（frontmatter 缺失或为空，已回退为目录名 "${fallbackName}"）`)
  } else {
    name = ''
    warnings.push('缺少 name（frontmatter 缺失或为空）')
  }

  const description = typeof meta.description === 'string' && meta.description.trim()
    ? meta.description.trim()
    : ''
  // metadata = frontmatter 除 name/description 外的全部字段；
  // 其中 `metadata:` 子对象被扁平化提升（方便调用方直接读 metadata.version 等）。
  const extra = { ...meta }
  delete extra.name
  delete extra.description
  const sub = extra.metadata && typeof extra.metadata === 'object' && !Array.isArray(extra.metadata)
    ? extra.metadata
    : {}
  delete extra.metadata
  const metadata = { ...sub, ...extra }

  const referencedScripts = extractPathRefs(instructions, 'scripts')
  const referencedReferences = extractPathRefs(instructions, 'references')

  if (!description) warnings.push('缺少 description')

  return {
    name,
    description,
    instructions,
    metadata,
    referencedScripts,
    referencedReferences,
    nameInferred,
    warnings,
  }
}

/**
 * 把解析后的 skill 转成 DSH 可加载资源对象（含 Experimental 标注）。
 * @param {object} skill 由 parseSkillMarkdown / scanSkillDir 产出的 skill
 * @param {object} [opts]
 * @param {string} [opts.provider] 提供方（默认 dsh-plugin-hub）
 * @returns {object} DSH 可加载资源（kind: 'skill'）
 */
export function toDshSkillResource(skill, { provider = 'dsh-plugin-hub' } = {}) {
  return {
    kind: 'skill',
    name: skill.name,
    description: skill.description ?? '',
    instructions: skill.instructions ?? '',
    metadata: skill.metadata ?? {},
    // 磁盘实际附带文件（[{ name, relative, path? }]）
    scripts: skill.scripts ?? [],
    references: skill.references ?? [],
    // 指令段里引用的路径（诊断用，可能与磁盘不一致）
    referencedScripts: skill.referencedScripts ?? [],
    referencedReferences: skill.referencedReferences ?? [],
    source: skill.source ?? null,
    // 解析告警（缺 name/description 等），供诊断
    warnings: skill.warnings ?? [],
    // 市场哲学·特殊通道：桥接内容一律 Experimental，平台不背书
    experimental: true,
    platformEndorsement: false,
    provider,
  }
}

/** 递归列出目录下文件（不含目录项本身）。 */
function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(entry)
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * 扫描一个外部 skill 目录（含 SKILL.md + scripts/ + references/）。
 * @param {string} dir 外部 skill 目录（skill 根目录，SKILL.md 直接位于其下）
 * @returns {{
 *   ok: true, dir: string, resource: object, files: { scripts: string[], references: string[] }
 * } | { ok: false, dir: string, error: string }}
 */
export function scanSkillDir(dir) {
  const skillMd = join(dir, 'SKILL.md')
  if (!existsSync(skillMd)) {
    return { ok: false, dir, error: '目录缺少 SKILL.md' }
  }
  let markdown
  try {
    markdown = readFileSync(skillMd, 'utf8')
  } catch (e) {
    return { ok: false, dir, error: `读取 SKILL.md 失败：${e instanceof Error ? e.message : String(e)}` }
  }

  const parsed = parseSkillMarkdown(markdown, { fallbackName: basename(dir) })

  const scripts = listFiles(join(dir, 'scripts')).map((name) => ({
    name,
    relative: join('scripts', name),
    path: join(dir, 'scripts', name),
  }))
  const references = listFiles(join(dir, 'references')).map((name) => ({
    name,
    relative: join('references', name),
    path: join(dir, 'references', name),
  }))

  const resource = toDshSkillResource({
    ...parsed,
    scripts,
    references,
    source: { kind: 'dir', dir },
  })

  return {
    ok: true,
    dir,
    resource,
    files: {
      scripts: scripts.map((f) => f.name),
      references: references.map((f) => f.name),
    },
  }
}

// ═══════════════════════════ 物化 / 重建 ═══════════════════════════

/** YAML 字符串值序列化：含特殊字符/换行/冒号，或长得像数字/布尔/null 时用双引号包裹（保证 round-trip 保真）。 */
function yamlStringValue(s) {
  const str = String(s)
  const numericLike = /^-?\d+(\.\d+)?$/.test(str) || str === 'true' || str === 'false' || str === 'null'
  if (numericLike || /[\n\r"':#]/.test(str) || str.trim() !== str) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return str
}

/** YAML 值序列化（递归，支持内联 map）。 */
function yamlValue(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(', ')}]`
  if (typeof v === 'object') {
    const inner = Object.entries(v).map(([k, val]) => `${k}: ${yamlValue(val)}`).join(', ')
    return `{ ${inner} }`
  }
  return yamlStringValue(v)
}

/**
 * 从 DSH 资源重建一份 SKILL.md（用于物化到目标目录 / 无源目录时的导出）。
 * @param {object} r DSH skill 资源（toDshSkillResource 产物）
 * @returns {string}
 */
export function renderSkillMarkdown(r) {
  const fm = ['---', `name: ${yamlStringValue(r.name)}`]
  if (r.description) fm.push(`description: ${yamlStringValue(r.description)}`)
  for (const [k, v] of Object.entries(r.metadata ?? {})) {
    if (k === 'name' || k === 'description') continue
    fm.push(`${k}: ${yamlValue(v)}`)
  }
  fm.push('---')
  return fm.join('\n') + '\n\n' + (r.instructions ?? '')
}

/** 递归复制目录树（源目录下全部文件）。 */
function copyTree(srcDir, destDir) {
  const walk = (s, d) => {
    mkdirSync(d, { recursive: true })
    for (const entry of readdirSync(s)) {
      const sp = join(s, entry)
      const dp = join(d, entry)
      if (statSync(sp).isDirectory()) walk(sp, dp)
      else copyFileSync(sp, dp)
    }
  }
  if (existsSync(srcDir)) walk(srcDir, destDir)
}

// ═══════════════════════════ 桥层（对齐 createMcpBridge） ═══════════════════════════

/**
 * 创建 Skills 生态桥：白名单目录 → 解析 → DSH 可加载资源。
 * 单条失败不阻断其余（与 MCP 桥同一哲学）。
 * @param {object} deps
 * @param {Array<string|{name?: string, dir: string}>} deps.skillDirs 外部 skill 目录白名单
 * @param {string} [deps.provider]
 */
export function createSkillsBridge(deps = {}) {
  const skillDirs = deps.skillDirs ?? []
  const provider = deps.provider ?? 'dsh-plugin-hub'
  const loaded = new Map() // skill name -> resource

  return {
    /** 加载全部白名单 skill 目录（单条失败不阻断，返回每目录结果）。 */
    loadAll() {
      const results = []
      for (const cfg of skillDirs) {
        const dir = typeof cfg === 'string' ? cfg : cfg?.dir
        const label = typeof cfg === 'string' ? cfg : (cfg?.name ?? cfg?.dir ?? '?')
        if (!dir) {
          results.push({ name: String(label), ok: false, error: '配置缺目录' })
          continue
        }
        const scanned = scanSkillDir(dir)
        if (!scanned.ok) {
          results.push({ name: String(label), ok: false, error: scanned.error })
          continue
        }
        const r = scanned.resource
        if (loaded.has(r.name)) {
          results.push({ name: r.name, ok: false, error: 'skill 重名冲突（同名只保留先加载者）' })
          continue
        }
        loaded.set(r.name, r)
        results.push({ name: r.name, ok: true, resource: r })
      }
      return results
    },

    /** 全部已加载的 DSH skill 资源。 */
    resources() {
      return [...loaded.values()]
    },

    /** 按 name 取单个资源。 */
    get(name) {
      return loaded.get(name)
    },

    /**
     * 把资源注册为 DSH 可加载资源。
     * DSH 资源注册点由调用方注入（`registerResource`），便于测试与未来适配；
     * 未注入时回退为 `ctx.provide('skill:<name>', resource)`。
     * @param {object} [ctx] DSH context（可选）
     * @param {object} [hooks]
     * @param {(resource: object) => void} [hooks.registerResource]
     * @returns {number} 注册数量
     */
    registerTo(ctx, { registerResource } = {}) {
      let count = 0
      for (const r of loaded.values()) {
        if (typeof registerResource === 'function') {
          registerResource(r)
        } else if (ctx && typeof ctx.provide === 'function') {
          ctx.provide(`skill:${r.name}`, r)
        }
        count++
      }
      return count
    },

    /**
     * 把资源物化为 DSH skills 磁盘布局（`<targetDir>/skills/<name>/SKILL.md` + scripts + references）。
     * 目标目录由调用方给定（默认不触碰运行中的 DSH 实例）。
     * @param {string} targetDir 目标根目录
     * @returns {Array<{name: string, ok: boolean, target?: string, error?: string}>}
     */
    installTo(targetDir) {
      const out = []
      for (const r of loaded.values()) {
        try {
          const skillDir = join(targetDir, 'skills', r.name)
          mkdirSync(skillDir, { recursive: true })
          if (r.source?.kind === 'dir' && existsSync(join(r.source.dir, 'SKILL.md'))) {
            // 有源目录：整树复制（保留原始 SKILL.md 与附带文件）
            copyTree(r.source.dir, skillDir)
          } else {
            // 纯解析资源：重建 SKILL.md
            writeFileSync(join(skillDir, 'SKILL.md'), renderSkillMarkdown(r), 'utf8')
            for (const f of [...(r.scripts ?? []), ...(r.references ?? [])]) {
              if (f?.path && existsSync(f.path)) copyFileSync(f.path, join(skillDir, f.relative))
            }
          }
          out.push({ name: r.name, ok: true, target: skillDir })
        } catch (e) {
          out.push({ name: r.name, ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
      return out
    },
  }
}

export default createSkillsBridge
