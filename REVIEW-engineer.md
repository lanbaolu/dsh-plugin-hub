# REVIEW — engineer 产物审查（t1 skills 加载器 + t4 eval-loop 骨架）

- 审查人：reviewer（dsh-hub-phase4）
- 审查日期：2026-08-19
- 审查范围：`lib/skills-loader.js`（t1）、`lib/eval-loop.js`（t4）+ 对应测试 + README 小节 + `lib/index.js`/`package.json` 接线
- 审查依据：
  - `dsh-plugin-standard/STANDARD.md` v2.0.0（合规 MUST / SHOULD / §9 红线 / 附录 B Checklist）
  - hub 现有代码风格（`lib/mcp-bridge.js`：依赖注入可测、零依赖、中文注释、单条失败不阻断）
  - `自进化闭环设计.md`（eval-loop 骨架定位：默认关闭、由调用方显式开启）

---

## 0. 验证前提（通过）

| 检查 | 结果 |
|---|---|
| `npm test` 全量测试 | ✅ **74/74 通过**（46 基线 + 16 skills + 12 eval-loop） |
| `node scripts/verify-plugin.mjs` | ✅ **0 FAIL / 2 WARN**（WARN 均为既有 SHOULD 项，非本次引入） |
| `npm run typecheck`（tsc --noEmit） | ✅ 通过 |

> verify 2 WARN 明细（**既有状态，非本次引入**）：`[6.1] scripts 缺失 build/verify/pack`、`[2.1.8] 未声明 engines.node`。README 亦无 §8.4 建议的“规范遵循”声明行。建议排期补齐，不阻塞本次合并。

---

## 1. t1 — Skills 生态桥（`lib/skills-loader.js`）

### ✅ PASS 项

| # | 检查点 | 依据 |
|---|---|---|
| P1 | 依赖注入可测：`createSkillsBridge(deps)`，纯函数解析层无 IO、桥层集中 IO | 对齐 `createMcpBridge` 风格 |
| P2 | 零依赖：仅 `node:fs`/`node:path`；手写轻量 YAML 子集，不引入第三方 | §P1 最小运行面 |
| P3 | 中文注释丰富，模块分节清晰（YAML 解析 / 纯函数 / 物化 / 桥层） | hub 风格 |
| P4 | 桥接内容一律 `experimental: true` + `platformEndorsement: false`（平台不背书） | 市场哲学·特殊通道 |
| P5 | 白名单 `skillsDirs` 默认空 = 不加载任何 skill、不触碰运行中 DSH 实例 | t1 任务要求 |
| P6 | 单条目录失败不阻断其余（`loadAll`），重名冲突后加载者失败 | 对齐 MCP 桥哲学 |
| P7 | `plugin_hub_skills` 工具只读、`description` 完整（何时用/前置/Experimental）、经 `ctx.effect` 注册 | §3.4.1 / §3.2.1 |
| P8 | README 新增“Skills 生态桥”小节：配置、独立用法、Experimental 说明 | t1 交付要求 |
| P9 | `exports["./skills-loader"]` 指向真实文件 | verify PASS |
| P10 | 测试覆盖较全面（frontmatter / 路径引用 / 去重 / fallback / 内联 map / 多行引号 / scan / installTo / round-trip / 重名 / 单条失败）16 用例 | §6.3 |

### ❌ FAIL 项（必须修复）

**F1【MUST · 安全 · 路径穿越】`installTo` 用 frontmatter 的 `name` 直接拼目标路径**

`lib/skills-loader.js:506`：
```js
const skillDir = join(targetDir, 'skills', r.name)
```
`r.name` 来自外部 `SKILL.md` 的 frontmatter（**用户可控**）。实测复现：

```js
// SKILL.md 内: name: ../../pwned
bridge.installTo('/var/folders/.../T/')
// → 在 targetDir 之外创建 /T/pwned/ 并写 SKILL.md，target 显示 "…/T/pwned"
```

违反：
- §3.3.3（路径防穿越：`realpath` 二次 confine / 白名单）
- §3.7.2（文件改写需校验后写）
- §9 红线 7（文件路径不得逃逸）
- 附录 B（路径逃逸项）

当前 `installTo` 由调用方显式调用，影响面有限；但**一旦未来接线把 targetDir 指向 DSH skills 目录，恶意/畸形 SKILL.md 可向任意路径写目录与文件**，属高危。

**修复建议**：对 `name` 做白名单校验——仅允许 `[A-Za-z0-9._-]`（可加首字符限制），拒绝含 `/`、`\`、`..`、空串的 name，`loadAll`/`installTo` 对该资源标 `ok:false` 并给明确 error。**并补回归测试**（`../`、绝对路径、`a/b`、空 name 均被拒绝）。

**F2【数据正确性】嵌套 scripts/references 目录丢相对路径**

`lib/skills-loader.js:303-316` `listFiles` 递归 walk 时只 `out.push(entry)`（叶子文件名），丢弃子目录相对路径。实测：

```
scripts/sub/helper.py  →  name: "helper.py", relative: "scripts/helper.py", path: "…/scripts/helper.py"（实际在 scripts/sub/）
```

后果：
- `scanSkillDir` 返回的 `path` 指向**不存在的文件**；
- `installTo` 无源目录分支（纯解析资源）时 `existsSync(f.path)` 为 false → 该脚本**静默丢失**（不复制、不报错）；
- `plugin_hub_skills` 工具展示的 `scripts.relative` 错误。

违反 §5（数据正确性）。当前 fixtures 只有单层，测试未覆盖嵌套。

**修复建议**：walk 时保留相对 scripts/references 根的 relpath（如 `scripts/sub/helper.py`），name 用 basename 或相对路径的 basename；补嵌套目录回归测试。

### ⚠️ SHOULD 改进

- **S1**：`installTo:513` 用 `writeFileSync` 直接写 `SKILL.md`——覆盖既有文件时非原子（§3.5.1 为 MUST，但仓库 `market.js` 亦无原子写、且此处以新建为主）。至少对已存在文件提示覆盖，或 tmp+rename。
- **S2**：`scanSkillDir`/`listFiles`/`copyTree` 全同步 fs，超大目录会阻塞事件循环。白名单目录通常小，可接受；建议 README 注明“勿指向巨型目录”。
- **S3**：`name` 未做规范化（首尾空格等）——与 F1 消毒一并处理。

---

## 2. t4 — 自进化闭环骨架（`lib/eval-loop.js`）

### ✅ PASS 项

| # | 检查点 | 依据 |
|---|---|---|
| P1 | 完全对齐《自进化闭环设计.md》：`createEvalLoop(deps)` + `enable/isEnabled/onTaskCompleted` + ①→④ 数据流 | 设计定稿 |
| P2 | **红线 4 满足**：`remember` 调用强制携带 `{ actor: 'autoDream' }`（`lib/eval-loop.js:128`），代码不可绕过 | §9 红线 4 |
| P3 | 依赖注入可测、零运行时依赖（无 import） | hub 风格 |
| P4 | 默认关闭（`enabled: false`），由调用方显式开启 | 设计“旗舰示例·可选开启” |
| P5 | 每环节失败不阻断：观测/验证缺失降级、remember 失败仅记录、整体 `ok:true` | 第一原则·fail-soft 兜底 |
| P6 | 反馈护栏：低置信度（< 0.7）不沉淀、`requireVerification` 未接验证不沉淀 | 防固化坏经验 |
| P7 | 输入校验：缺 taskId/id → `ok:false`；支持 `task.id` 别名 | §5 |
| P8 | 中文注释 + 红线说明段清晰 | hub 风格 |
| P9 | README 新增“自进化闭环”小节（用法、红线、护栏、降级） | t4 交付要求 |
| P10 | `exports["./eval-loop"]` 指向真实文件 | verify PASS |
| P11 | 测试 12 用例覆盖：默认关闭 / 全链路 actor / 低置信度 / 达标 / 各降级路径 / requireVerification / taskId 校验 / 别名 | §6.3 |

### ❌ FAIL 项

无 MUST 违规。

### ⚠️ SHOULD 改进

- **S1【护栏可被绕过】verify 返回但无 `confidence` 时不拦截**：`lib/eval-loop.js:106` 低置信度判断要求 `typeof confidence === 'number'`，若 verify 返回 `{ score }`（无 confidence），实测**直接沉淀**，低置信度护栏形同虚设。建议：verify 存在但无 confidence 时视为“未验证”——按 `requireVerification` 语义决定是否沉淀，并写 warning；补测试。
- **S2【无幂等/去重】**：`onTaskCompleted` 无 per-taskId 去重，重复 completed 事件会重复沉淀记忆（接 agent-teams 后可能发生，§5.2 一次投递相关）。骨架阶段可接受，但建议在注释/README 声明“调用方负责幂等”，或加短窗口去重。
- **S3【未接线】**：`lib/index.js` 未引用 eval-loop（符合“骨架/默认关闭/由调用方显式开启”设计），但 README 称“旗舰示例”而当前**无任何调用方接线**。建议 README/STATUS 明确“骨架已交付、接线（agent-teams completed 事件）留待后续”，避免误读为已可用。

---

## 3. 工程面（共同）

- ✅ 测试可跑通、verify 0 FAIL、typecheck 通过（t5 通过前提满足）。
- ✅ 未触碰运行中 DSH 实例：无新增 HTTP 路由、无子进程、无 profile 改写、无 client 改动。
- ✅ 新增 export 均指向真实文件，`npm pack` 结构一致（verify `--pack` 级别核对）。
- ✅ 零依赖、依赖注入、中文注释三风格要求全部达成。
- ⚠️ 既有 WARN（非本次引入）：scripts 缺 build/verify/pack、engines.node 缺失、README 缺“规范遵循”声明行。

---

## 4. 审查结论

| 产物 | 结论 | 阻塞项 |
|---|---|---|
| t1 skills 加载器 | **有条件通过**（修复 F1 + F2 后通过） | F1（MUST·路径穿越）、F2（数据正确性） |
| t4 eval-loop 骨架 | **通过**（无 MUST 违规，采纳 SHOULD 即可） | — |

- **测试前提满足**：74/74 全绿、verify 0 FAIL、typecheck 通过。
- **但 t1 存在 1 个 MUST 级安全缺陷（`installTo` 路径穿越）**：按 STANDARD §0.2，MUST 违规评审应拒绝合并/发布。**建议 engineer 修复 F1、F2 并补对应回归测试后重新评审**；t4 可直接落地，SHOULD 建议排期跟进。

---

## 5. 改进清单（按优先级）

1. **[MUST] F1**：`installTo` 的 skill `name` 做白名单消毒（`[A-Za-z0-9._-]`）+ 拒绝 `..`/`/` + 补穿越回归测试。
2. **[高] F2**：`listFiles` 保留嵌套相对路径 + 补嵌套目录测试。
3. **[中] S1**：eval-loop 对“verify 无 confidence”按未验证处理 + 补测试。
4. **[低] S1/S2/S3**：installTo 原子写 / 同步 fs 备注 / eval-loop 幂等声明与 README 接线状态标注。
