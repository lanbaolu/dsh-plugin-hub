/**
 * @lanbaolu/dsh-plugin-hub — 市场服务（安装/隔离/恢复/状态）。
 *
 * 核心约束（第一原则 + 装配顺序）：
 *  - **安装任何市场插件前必须 doctor === PLATFORM_READY**，否则拒绝；
 *  - 隔离/恢复复用 fail-soft 的 patch 语义（带隔离标记才可恢复）。
 * 全部依赖注入（deps），便于独立测试。
 */
import { getCatalog } from './catalog.js'
import { STATUS_READY } from './doctor.js'

/**
 * @param {object} deps
 * @param {Array} [deps.catalog] 市场目录（缺省内置）
 * @param {() => Promise<{status: string, blockers: string[]}>} deps.doctor 平台自检
 * @param {(pkg: string) => boolean} deps.checkInstalled 是否已安装
 * @param {() => string[]} deps.readQuarantinedIds 当前隔离的 entry id 列表
 * @param {(source: string) => {ok: boolean, error?: string}} deps.spawnInstall 执行安装（如 dsh plugin add）
 * @param {(id: string, name: string) => {ok: boolean, error?: string}} deps.quarantinePlugin fail-soft 手动隔离
 * @param {(id: string) => {ok: boolean, error?: string}} deps.removePatchEntry fail-soft 恢复
 */
export function createMarket(deps) {
  const catalog = deps.catalog ?? getCatalog()

  return {
    /** 安装前置门：必须 PLATFORM_READY；已装/目录无此插件则拒绝。 */
    async install(pluginId) {
      const item = catalog.find((p) => p.id === pluginId)
      if (!item) return { ok: false, error: `市场目录中无插件 "${pluginId}"` }
      const d = await deps.doctor()
      if (d.status !== STATUS_READY) {
        return {
          ok: false,
          error: `平台未就绪（${d.status}）——市场拒绝安装（第一原则：插件错误不挡服务拉起，须先保证容错底座生效）`,
          blockers: d.blockers ?? [],
        }
      }
      if (deps.checkInstalled(item.package)) {
        return { ok: false, error: `${item.package} 已安装` }
      }
      const res = deps.spawnInstall(item.source)
      if (res.ok) {
        return { ok: true, id: item.id, package: item.package, action: 'installed', source: item.source }
      }
      return { ok: false, error: `安装失败：${res.error ?? '未知错误'}` }
    },

    /** 手动隔离（写 fail-soft 隔离标记的 disabled patch）。 */
    async quarantine(pluginId, name, reason) {
      const item = catalog.find((p) => p.id === pluginId)
      const entryId = item?.package ?? pluginId
      return deps.quarantinePlugin(entryId, name ?? item?.name ?? entryId, reason)
    },

    /** 恢复隔离（只删带隔离标记的条目）。 */
    async restore(pluginId) {
      const item = catalog.find((p) => p.id === pluginId)
      const entryId = item?.package ?? pluginId
      return deps.removePatchEntry(entryId)
    },

    /** 目录 + 各商品安装/隔离状态 + 动态合规徽章（Compliant 由校验生成）。 */
    async status() {
      const quarantined = new Set(deps.readQuarantinedIds())
      const out = []
      for (const item of catalog) {
        const badges = [...(item.badges ?? [])]
        let compliance = null
        if (deps.checkCompliance) {
          try {
            compliance = await deps.checkCompliance(item)
            badges.unshift(compliance.compliant ? 'Compliant' : 'Not-Compliant')
          } catch {
            badges.unshift('Not-Compliant')
          }
        }
        out.push({
          ...item,
          badges,
          compliance,
          installed: deps.checkInstalled(item.package),
          quarantined: quarantined.has(item.package),
        })
      }
      return out
    },
  }
}

export default createMarket
