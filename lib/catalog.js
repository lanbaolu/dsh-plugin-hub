/**
 * @lanbaolu/dsh-plugin-hub — 市场目录（首批上架商品）。
 *
 * 平台只提供目录与安装/隔离/恢复通道；商品质量由徽章如实标注：
 *  - `Compliant`：通过 dsh-plugin-standard 合规校验（0 MUST 违规）
 *  - `Verified / Stable / Experimental`：稳定性分级
 *  - `COMPAT`：由版本兼容层托底（未适配当前 DSH，Phase 4 启用）
 * 徽章是"如实标注"，不是平台背书（桥接内容一律 Experimental）。
 */

export const BADGES = {
  COMPLIANT: 'Compliant',
  VERIFIED: 'Verified',
  STABLE: 'Stable',
  EXPERIMENTAL: 'Experimental',
  COMPAT: 'COMPAT',
}

/** 内置市场目录（可被未来第三方上架/扩展合并）。 */
export const CATALOG = [
  {
    id: 'agent-teams',
    name: 'Agent Teams',
    package: '@nanmicoder/dsh-agent-teams',
    version: '0.1.6',
    description: '多智能体团队协作：captain + 成员 + 任务 DAG + 直连消息 + 实时活动面板',
    badges: [BADGES.COMPLIANT, BADGES.STABLE],
    source: '@nanmicoder/dsh-agent-teams',
  },
  {
    id: 'mneme',
    name: 'Mneme 记忆引擎',
    package: '@modusensus/dsh-mneme',
    version: '0.3.7',
    description: '结构化记忆：SQLite + Markdown 镜像、实体/时间轴、autoDream 后台巩固、离线语义搜索',
    badges: [BADGES.COMPLIANT, BADGES.STABLE],
    source: '@modusensus/dsh-mneme',
  },
  {
    id: 'usage-stats',
    name: 'Usage Stats 用量统计',
    package: 'dsh-usage-stats',
    version: '0.2.0',
    description: '多供应商余额/配额 + Token 用量热图/下钻 + 后台监测',
    badges: [BADGES.COMPLIANT, BADGES.STABLE],
    source: 'dsh-usage-stats',
  },
  {
    id: 'at-file',
    name: 'At File @ 引用',
    package: 'dsh-at-file',
    version: '0.6.2',
    description: '工作区 @ 路径/内容引用选择器（官方 release 分发）',
    badges: [BADGES.COMPLIANT, BADGES.STABLE],
    source: 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.2.tar.gz',
  },
  {
    id: 'prompt-optimizer',
    name: 'AI Prompt Optimizer',
    package: 'dsh-ai-prompt-optimizer',
    version: '0.1.0',
    description: '输入框一键把粗略想法整理成结构化提示词',
    badges: [BADGES.COMPLIANT, BADGES.STABLE],
    source: 'dsh-ai-prompt-optimizer',
  },
  {
    id: 'llm-verifier',
    name: 'LLM Verifier 校验桥',
    package: '@lanbaolu/dsh-llm-verifier',
    version: '0.1.1',
    description: 'LLM-as-a-Verifier：select/compare/track 作为 agent 工具（Python stdio 桥）',
    badges: [BADGES.COMPLIANT, BADGES.EXPERIMENTAL],
    source: '@lanbaolu/dsh-llm-verifier',
  },
  {
    id: 'trajectory-debug',
    name: 'Trajectory Debug 调试台',
    package: 'dsh-trajectory-debug',
    version: '0.1.0',
    description: '轨迹 waterfall/重放/断点/性能分析/OTel 导出',
    badges: [BADGES.EXPERIMENTAL],
    source: 'dsh-trajectory-debug',
  },
]

/** 返回目录（未来可合并第三方上架数据）。 */
export function getCatalog() {
  return CATALOG.map((item) => ({ ...item }))
}

export default CATALOG
