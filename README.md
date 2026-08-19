# @lanbaolu/dsh-plugin-hub — DSH 插件治理平台（平台层）

DSH 插件市场 + 治理底座的开源实现。**装完即可安全安装/管理任意插件，插件错误绝不影响服务拉起**（第一原则）。

## 这是什么 / 不是什么

- ✅ 是**平台层**：安装器（installer）+ 健康自检（suite:doctor）+ 市场服务入口。
- ❌ 不是功能全家桶：功能插件（agent-teams / mneme / usage-stats …）是**市场内容**，按需安装，不预装。

## 快速开始（一条命令装平台层）

```bash
# 0. 前置：已安装 DSH 并运行过一次 dsh web（生成 profile）
# 1. 装平台层（fail-soft → 重启 → injector + hub）
node scripts/install.mjs

# 2. 重启 dsh web（首次安装只需重启一次，让 fail-soft 内核补丁生效）
# 3. 随时自检
npm run doctor            # 或 node scripts/doctor-cli.mjs
```

> 核心约束（第一原则）：installer 强制 **fail-soft 先装并生效**，`suite:doctor` 确认
> `PLATFORM_READY` 之后才允许装其余组件 / 市场插件。**装坏插件不会拖垮服务**——
> 会被 fail-soft 自动隔离，市场里一键恢复。

## suite:doctor 三态

| 状态 | 含义 | 处理 |
|---|---|---|
| `PLATFORM_READY` | 全部就绪 | ✅ 可安装市场插件 |
| `NEEDS_RESTART` | fail-soft 已装但补丁未生效 | 重启 dsh web 后重跑 |
| `NEEDS_FIX` | 组件缺失 / 补丁需适配 | 按 blockers 修复 |

退出码：`0` = READY，`2` = RESTART，`1` = FIX。

```bash
node scripts/doctor-cli.mjs          # 人类可读
node scripts/doctor-cli.mjs --json   # 纯 JSON（供市场 UI / 脚本消费）
```

检查项：fail-soft 内核补丁健康（复用 `@lanbaolu/dsh-fail-soft` 的 `getPatchStatus`）、
super-injector registry 可达性、plugin-hub 自身服务。

## 市场分级（门槛 / 价签 / 特殊通道）

市场**不是"只收合格"也不是"什么都收"**，而是分层：

| 层 | 规则 | 徽章 |
|---|---|---|
| 门槛（MUST） | 上架商品必须过合规校验（0 MUST 违规） | `Compliant` |
| 分级（SHOULD） | 过门槛后按可信度分级，用户知情决策 | `Verified` > `Stable` > `Experimental` |
| 特殊通道（例外） | COMPAT（版本托底）/ 桥接内容（MCP/skills）不满足完整合规，明确标注**平台不背书** | `COMPAT` / `Experimental` |

> 平台不替用户做"能不能用"的裁判：合规门槛 + 徽章给足信息，fail-soft 兜住风险（装坏也不挡服务拉起）。

### 合规徽章 = 自动校验生成（不靠人工标注）

`Compliant` 徽章不是写死在目录里的——市场展示/上架时用 `dsh-plugin-standard` 的
`verify-plugin` **自动校验**生成（0 MUST 违规 = 合规，否则标注 `Not-Compliant`）：

- 商品有本地工作区目录 → 直接对本地校验；
- 远程/npm 源 → `npm pack` 到临时目录后校验；
- 结果按 `(package, version)` 缓存 5 分钟，避免每次展示都跑校验。

```bash
# 独立校验一个插件目录
node node_modules/dsh-plugin-standard/scripts/verify-plugin.mjs <插件目录> --json
```

## HTTP API（市场 + 平台）

- `GET /api/plugin-hub/health` → `{ ok, service, version }`
- `GET /api/plugin-hub/doctor` → 三态 JSON（**市场 UI 安装任何插件前必须确认 `status === "PLATFORM_READY"`**）
- `GET /api/plugin-hub/catalog` → 市场目录 + 各商品质量徽章与安装/隔离状态
- `POST /api/plugin-hub/install` `{ id }` → 安装市场插件（**前置门：非 PLATFORM_READY 拒绝**）
- `POST /api/plugin-hub/quarantine` `{ id, reason? }` → 手动隔离
- `POST /api/plugin-hub/restore` `{ id }` → 恢复隔离（只删带隔离标记的条目）

## Agent 工具

- `plugin_hub_doctor`：运行平台健康自检，返回三态与检查明细
- `plugin_hub_status`：返回 `ready` 布尔（装市场插件前置条件）
- `plugin_hub_catalog`：市场目录 + 徽章 + 状态
- `plugin_hub_install` / `plugin_hub_quarantine` / `plugin_hub_restore`：市场安装/隔离/恢复

## 进程级启动包装器（三层金字塔·第 2 层）

```bash
# 用外层进程拉起 dsh web：崩溃 → 诊断是否插件 → 隔离后带退避自动重拉
npx dsh-failsoft-web                  # 或 node scripts/failsoft-web.mjs
npx dsh-failsoft-web -- --port 3080   # 透传参数
```

- dsh 正常退出(0) → 透传退出
- dsh 崩溃 + fail-soft 隔离数增加 → 坏插件已被剔除，带退避自动重拉（默认最多 3 次）
- dsh 崩溃 + 无新隔离 → 跑 doctor 诊断，疑似非插件问题停止重拉

## 超时护栏（三层金字塔·第 3 层核心）

把"插件挂起"转成可捕获的超时错误（`code: ETIMEOUT`），挂起不再是无响应黑洞：

```js
import { withTimeout, wrapToolWithTimeout } from '@lanbaolu/dsh-plugin-hub/timeout-guard'
```

- `withTimeout(promise, ms, label)`：给任意 Promise 加超时
- `wrapToolWithTimeout(tool, ms)`：给 DSH 工具定义加超时（元数据不变）
- 平台自身工具默认 `toolTimeoutMs: 120000`（可配置）

## 平台层组成（随本包一起装配）

| 组件 | 作用 |
|---|---|
| `@lanbaolu/dsh-fail-soft` | 容错底座：坏/不兼容插件自动隔离，服务照常拉起（第一原则承载层） |
| `@dsh-external/dsh-super-injector` | 运维底座：运行时注入 / 热重载 / 生产线 |
| `@lanbaolu/dsh-plugin-hub` | 本包：installer + doctor + 市场服务 + 进程级兜底 + 超时护栏 |

## 开发

```bash
npm test                 # 30 用例（doctor/启动包装器/超时护栏/市场）
node scripts/doctor-cli.mjs   # 实际自检
```

## 许可

BSD-3-Clause

## MCP 生态桥（供给面）

把外部 MCP server 的工具映射成 DSH 工具（**Experimental，平台不背书**——市场哲学·特殊通道）：

- 手写 JSON-RPC over stdio（零依赖），支持 `initialize / tools/list / tools/call`
- 白名单即配置 `mcpServers`：只连接显式列出的 server（不任意连远程）
- 工具名加 `[server]_` 前缀防冲突；inputSchema（JSON Schema）→ DSH 参数自动映射
- 工具注册带超时护栏（挂起 → ETIMEOUT 可捕获）

```js
// 配置（cordis.patch.yml 的 config 或 DEFAULT_CONFIG）
mcpServers: [
  { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
]
```

> 桥接内容来源不可本地校验 → 一律 Experimental + 白名单；评审核过才升 Verified。
