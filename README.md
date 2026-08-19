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

## HTTP API（市场前置门数据源）

- `GET /api/plugin-hub/health` → `{ ok, service, version }`
- `GET /api/plugin-hub/doctor` → 三态 JSON（**市场 UI 安装任何插件前必须确认 `status === "PLATFORM_READY"`**）

## Agent 工具

- `plugin_hub_doctor`：运行平台健康自检，返回三态与检查明细
- `plugin_hub_status`：返回 `ready` 布尔（装市场插件前置条件）

## 平台层组成（随本包一起装配）

| 组件 | 作用 |
|---|---|
| `@lanbaolu/dsh-fail-soft` | 容错底座：坏/不兼容插件自动隔离，服务照常拉起（第一原则承载层） |
| `@dsh-external/dsh-super-injector` | 运维底座：运行时注入 / 热重载 / 生产线 |
| `@lanbaolu/dsh-plugin-hub` | 本包：installer + doctor + 市场服务入口 |

## 开发

```bash
npm test                 # doctor 三态单测
node scripts/doctor-cli.mjs   # 实际自检
```

## 许可

BSD-3-Clause
