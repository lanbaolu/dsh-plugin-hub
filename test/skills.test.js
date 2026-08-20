/**
 * skills.test.js — Skills 生态桥回归（frontmatter 解析 + 指令段 + 脚本路径 + DSH 资源注册）。
 * 用 test/fixtures/sample-skill 做真实目录扫描；物化验证用临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  parseSkillMarkdown, extractPathRefs, toDshSkillResource,
  scanSkillDir, renderSkillMarkdown, createSkillsBridge,
} from '../lib/skills-loader.js'

const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-skill')
const SAMPLE_MD = readFileSync(join(SAMPLE_DIR, 'SKILL.md'), 'utf8')

// ── parseSkillMarkdown（纯函数）──
test('parseSkillMarkdown: 解析 frontmatter name/description/metadata + 指令段', () => {
  const s = parseSkillMarkdown(SAMPLE_MD)
  assert.equal(s.name, 'sample-skill')
  assert.match(s.description, /汇总环境/)
  assert.equal(s.metadata.version, '1.2.0')
  assert.equal(s.metadata.compatibility, '需要 bash（macOS / Linux）')
  // name/description 不进 metadata
  assert.equal(s.metadata.name, undefined)
  assert.equal(s.metadata.description, undefined)
  // 指令段为 frontmatter 之后的正文
  assert.match(s.instructions, /# Sample Skill/)
  assert.doesNotMatch(s.instructions, /^---/)
  assert.deepEqual(s.warnings, [])
})

test('parseSkillMarkdown: 提取附带脚本/参考引用路径（scripts/references 分离）', () => {
  const s = parseSkillMarkdown(SAMPLE_MD)
  assert.deepEqual(s.referencedScripts, ['scripts/run.sh'])
  assert.deepEqual(s.referencedReferences, ['references/guide.md'])
})

test('extractPathRefs: 去重 + 去尾标点', () => {
  const refs = extractPathRefs('a scripts/x.sh、scripts/x.sh 和 scripts/y.py，见 references/a.md;', 'scripts')
  assert.deepEqual(refs, ['scripts/x.sh', 'scripts/y.py'])
  assert.deepEqual(extractPathRefs('a scripts/x.sh', 'references'), [])
})

test('parseSkillMarkdown: 无 frontmatter → fallbackName + nameInferred + warnings', () => {
  const s = parseSkillMarkdown('# 只有正文\n\n一些指令\n', { fallbackName: 'my-skill' })
  assert.equal(s.name, 'my-skill')
  assert.equal(s.nameInferred, true)
  assert.equal(s.description, '')
  assert.ok(s.warnings.some((w) => w.includes('缺少 name') && w.includes('my-skill')))
  assert.ok(s.warnings.some((w) => w.includes('缺少 description')))
  assert.equal(s.instructions, '# 只有正文\n\n一些指令')
})

test('parseSkillMarkdown: 缺 name / 缺 description → 单独 warning', () => {
  const s1 = parseSkillMarkdown('---\ndescription: 只有描述\n---\n正文', { fallbackName: 'n' })
  assert.equal(s1.name, 'n')
  assert.ok(s1.warnings.some((w) => w.includes('name')))
  const s2 = parseSkillMarkdown('---\nname: only-name\n---\n正文')
  assert.equal(s2.name, 'only-name')
  assert.ok(s2.warnings.some((w) => w.includes('description')))
})

test('parseSkillMarkdown: 支持内联 map metadata 与多行引号 description', () => {
  const md = [
    '---',
    'name: inline-meta',
    'description: "第一行\\n第二行"',
    'metadata: { version: "9", stage: beta }',
    '---',
    '正文',
  ].join('\n')
  const s = parseSkillMarkdown(md)
  assert.equal(s.name, 'inline-meta')
  assert.equal(s.description, '第一行\n第二行')
  assert.equal(s.metadata.version, '9')
  assert.equal(s.metadata.stage, 'beta')
})

// ── toDshSkillResource ──
test('toDshSkillResource: 转成 DSH 资源并标注 Experimental', () => {
  const parsed = parseSkillMarkdown(SAMPLE_MD)
  const r = toDshSkillResource({ ...parsed, source: { kind: 'dir', dir: SAMPLE_DIR } })
  assert.equal(r.kind, 'skill')
  assert.equal(r.name, 'sample-skill')
  assert.equal(r.experimental, true)
  assert.equal(r.platformEndorsement, false)
  assert.equal(r.provider, 'dsh-plugin-hub')
  assert.equal(r.source.dir, SAMPLE_DIR)
})

// ── scanSkillDir（真实 fixtures 目录）──
test('scanSkillDir: 扫描真实 skill 目录并收集 scripts/references 文件', () => {
  const out = scanSkillDir(SAMPLE_DIR)
  assert.equal(out.ok, true)
  const r = out.resource
  assert.equal(r.name, 'sample-skill')
  assert.equal(r.scripts.length, 1)
  assert.equal(r.scripts[0].relative, join('scripts', 'run.sh'))
  assert.equal(r.references.length, 1)
  assert.equal(r.references[0].relative, join('references', 'guide.md'))
  assert.equal(out.files.scripts[0], 'run.sh')
})

test('scanSkillDir: 缺 SKILL.md → ok:false', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skills-bad-'))
  try {
    const out = scanSkillDir(tmp)
    assert.equal(out.ok, false)
    assert.match(out.error, /缺少 SKILL\.md/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── createSkillsBridge ──
test('createSkillsBridge: loadAll + resources + get', () => {
  const bridge = createSkillsBridge({ skillDirs: [SAMPLE_DIR] })
  const results = bridge.loadAll()
  assert.equal(results[0].ok, true)
  assert.equal(results[0].resource.name, 'sample-skill')
  const all = bridge.resources()
  assert.equal(all.length, 1)
  assert.equal(bridge.get('sample-skill').experimental, true)
  assert.equal(bridge.get('nope'), undefined)
})

test('createSkillsBridge: 单条失败不阻断其余', () => {
  const bridge = createSkillsBridge({ skillDirs: ['/nonexistent/skill', SAMPLE_DIR] })
  const results = bridge.loadAll()
  assert.equal(results[0].ok, false)
  assert.equal(results[1].ok, true)
  assert.equal(bridge.resources().length, 1)
})

test('createSkillsBridge: 缺目录配置 → 单条失败', () => {
  const bridge = createSkillsBridge({ skillDirs: [{ name: 'bad' }] })
  const results = bridge.loadAll()
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /缺目录/)
})

test('createSkillsBridge: 重名冲突 → 后加载者失败', () => {
  const bridge = createSkillsBridge({ skillDirs: [SAMPLE_DIR, SAMPLE_DIR] })
  const results = bridge.loadAll()
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.match(results[1].error, /重名冲突/)
  assert.equal(bridge.resources().length, 1)
})

test('createSkillsBridge: registerTo 注入 registerResource 钩子', () => {
  const bridge = createSkillsBridge({ skillDirs: [SAMPLE_DIR] })
  bridge.loadAll()
  const registered = []
  const count = bridge.registerTo(null, { registerResource: (r) => registered.push(r) })
  assert.equal(count, 1)
  assert.equal(registered[0].kind, 'skill')
  assert.equal(registered[0].name, 'sample-skill')
})

test('createSkillsBridge: installTo 物化为 DSH skills 布局（临时目录）', () => {
  const bridge = createSkillsBridge({ skillDirs: [SAMPLE_DIR] })
  bridge.loadAll()
  const target = mkdtempSync(join(tmpdir(), 'skills-install-'))
  try {
    const out = bridge.installTo(target)
    assert.equal(out[0].ok, true)
    const skillDir = join(target, 'skills', 'sample-skill')
    assert.equal(existsSync(join(skillDir, 'SKILL.md')), true)
    assert.equal(existsSync(join(skillDir, 'scripts', 'run.sh')), true)
    assert.equal(existsSync(join(skillDir, 'references', 'guide.md')), true)
    // 物化后 SKILL.md 与源一致（整树复制）
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), SAMPLE_MD)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ── renderSkillMarkdown（round-trip）──
test('renderSkillMarkdown: 重建 SKILL.md 可再次解析', () => {
  const parsed = parseSkillMarkdown(SAMPLE_MD)
  const r = toDshSkillResource({ ...parsed, source: null })
  const rebuilt = renderSkillMarkdown(r)
  const again = parseSkillMarkdown(rebuilt)
  assert.equal(again.name, 'sample-skill')
  assert.equal(again.metadata.version, '1.2.0')
  assert.match(again.instructions, /# Sample Skill/)
})
