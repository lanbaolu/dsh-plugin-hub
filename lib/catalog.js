/**
 * @lanbaolu/dsh-plugin-hub — 市场目录（首批上架商品）。
 *
 * 市场哲学：**合规是门槛，分级是价签，特殊通道不背书**。
 *  - `Compliant` 徽章**不在此静态标注**——由 lib/compliance.js 在展示/上架时
 *    用 verify-plugin 自动校验生成（0 MUST 违规 = 合规）；
 *  - 分级徽章（Verified / Stable / Experimental / COMPAT）静态标注；
 *  - `localDir` 为本地工作区校验源（相对本包根），缺失/远程源则 npm pack 校验。
 */

export const BADGES = {
  VERIFIED: 'Verified',
  STABLE: 'Stable',
  EXPERIMENTAL: 'Experimental',
  COMPAT: 'COMPAT',
  BRIDGE: 'BRIDGE',
}

/** 内置市场目录。 */
export const CATALOG = [
  {
    id: 'agent-teams',
    name: 'Agent Teams',
    package: '@nanmicoder/dsh-agent-teams',
    version: '0.1.6',
    description: '多智能体团队协作：captain + 成员 + 任务 DAG + 直连消息 + 实时活动面板',
    badges: [BADGES.STABLE],
    source: '@nanmicoder/dsh-agent-teams',
    localDir: '../dsh-agent-teams',
  },
  {
    id: 'mneme',
    name: 'Mneme 记忆引擎',
    package: '@modusensus/dsh-mneme',
    version: '0.3.7',
    description: '结构化记忆：SQLite + Markdown 镜像、实体/时间轴、autoDream 后台巩固、离线语义搜索',
    badges: [BADGES.STABLE],
    source: '@modusensus/dsh-mneme',
    localDir: '../dsh-mneme/dsh-mneme',
    // COMPAT 样本：peerDeps 声明旧包名 @deepseek-ai/dsh-host-webserver，静态识别出 COMPAT 徽章
    compat: true,
  },
  {
    id: 'usage-stats',
    name: 'Usage Stats 用量统计',
    package: 'dsh-usage-stats',
    version: '0.2.0',
    description: '多供应商余额/配额 + Token 用量热图/下钻 + 后台监测',
    badges: [BADGES.STABLE],
    source: 'dsh-usage-stats',
    localDir: '../dsh-usage-stats',
  },
  {
    id: 'at-file',
    name: 'At File @ 引用',
    package: 'dsh-at-file',
    version: '0.6.2',
    description: '工作区 @ 路径/内容引用选择器（官方 release 分发）',
    badges: [BADGES.STABLE],
    source: 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.2.tar.gz',
    localDir: '../dsh-at-file',
  },
  {
    id: 'prompt-optimizer',
    name: 'AI Prompt Optimizer',
    package: 'dsh-ai-prompt-optimizer',
    version: '0.1.0',
    description: '输入框一键把粗略想法整理成结构化提示词',
    badges: [BADGES.STABLE],
    source: 'dsh-ai-prompt-optimizer',
    localDir: '../dsh-ai-prompt-optimizer',
  },
  {
    id: 'llm-verifier',
    name: 'LLM Verifier 校验桥',
    package: '@lanbaolu/dsh-llm-verifier',
    version: '0.1.1',
    description: 'LLM-as-a-Verifier：select/compare/track 作为 agent 工具（Python stdio 桥）',
    badges: [BADGES.EXPERIMENTAL],
    source: '@lanbaolu/dsh-llm-verifier',
    localDir: '../../llm-verifier',
  },
  {
    id: 'trajectory-debug',
    name: 'Trajectory Debug 调试台',
    package: 'dsh-trajectory-debug',
    version: '0.1.0',
    description: '轨迹 waterfall/重放/断点/性能分析/OTel 导出（monorepo，未作为单包发布）',
    badges: [BADGES.EXPERIMENTAL],
    source: 'dsh-trajectory-debug',
    localDir: '../dsh-trajectory-debug',
  },
  // ─── 生态桥（F1）· koishi 适配 · 特殊通道「平台不背书」───
  {
    id: 'koishi-bridge',
    name: 'Koishi Bridge 适配层',
    package: '@lanbaolu/dsh-koishi-bridge',
    version: '0.1.1',
    description: 'koishi 生态桥适配层（合规 DSH bundle）：把 koishi-plugin-* 经 shim 别名加载进 DSH。平台不背书（BRIDGE/Experimental），需配合 shim 别名 + 目标插件',
    badges: [BADGES.EXPERIMENTAL, BADGES.BRIDGE],
    source: '@lanbaolu/dsh-koishi-bridge',
    localDir: '../dsh-koishi-bridge',
  },
  {
    id: 'koishi-shim',
    name: 'Koishi Shim（koishi 包名别名）',
    package: '@lanbaolu/dsh-koishi-shim',
    version: '0.1.1',
    description: 'koishi 生态桥 L0/L1 shim：提供 koishi 包名（Schema/makeArray/segment），让 koishi 插件 require("koishi") 在 DSH 可解析。平台不背书（BRIDGE/Experimental）',
    badges: [BADGES.EXPERIMENTAL, BADGES.BRIDGE],
    source: '@lanbaolu/dsh-koishi-shim',
    localDir: '../dsh-koishi-shim',
  },
  // ─── COMPAT 版本兼容层（F2）───
  {
    id: 'dsh-compat',
    name: 'Compat 兼容层',
    package: '@lanbaolu/dsh-compat',
    version: '0.1.0',
    description: 'COMPAT 版本兼容层：DSH 升级导致的 服务 key / 包名 改名 → 轻量别名托底（rename，不做语义转译）；兜不住交 fail-soft。配合 verify-plugin --compat 打徽章',
    badges: [BADGES.COMPAT],
    source: '@lanbaolu/dsh-compat',
    localDir: '../dsh-compat',
  },
]

/** 返回目录副本（Compliant 由校验动态生成，不在此处）。 */
export function getCatalog() {
  return CATALOG.map((item) => ({ ...item }))
}

export default CATALOG
