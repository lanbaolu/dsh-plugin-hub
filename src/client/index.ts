/**
 * @lanbaolu/dsh-plugin-hub — client 市场面板（settings.section slot）。
 *
 * DSH 设置面板注册「插件市场」区域：
 * - 平台状态卡（PLATFORM_READY / NEEDS_RESTART / NEEDS_FIX + blockers）；
 * - 市场目录：每个商品的徽章（Compliant/Verified/Stable/Experimental/COMPAT）
 *   与安装/隔离状态 + 操作按钮（安装 / 隔离 / 恢复）；
 * - **前置门：非 PLATFORM_READY 时安装按钮禁用**（第一原则）。
 *
 * 构建：npm run build:client（tsdown → lib/client.js，ModuleLoader 包装）。
 * 数据源：/api/plugin-hub/doctor|catalog|install|quarantine|restore。
 */
// @ts-nocheck
import * as React from 'react'
import { Button, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const cardStyle = {
  background: 'var(--dsw-alias-surface-2, #fafafa)',
  border: '1px solid var(--dsw-alias-border-l2, #e6e6e6)',
  borderRadius: 10,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary, #555)',
}
const hintStyle = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary, #999)',
  lineHeight: 1.5,
}

/** 徽章 → 颜色/文案映射。 */
function badgeTone(badge) {
  switch (badge) {
    case 'Compliant': return { label: '✅ 合规', color: '#2e9e5b' }
    case 'Verified': return { label: '✔ 认证', color: '#1f6feb' }
    case 'Stable': return { label: '🟢 稳定', color: '#2e9e5b' }
    case 'Experimental': return { label: '🧪 实验', color: '#d29922' }
    case 'COMPAT': return { label: '🔁 兼容托底', color: '#b887ff' }
    default: return { label: badge, color: '#888' }
  }
}

/** 市场面板主体。 */
function MarketPanel() {
  const [doctor, setDoctor] = React.useState(null)
  const [catalog, setCatalog] = React.useState([])
  const [busy, setBusy] = React.useState(null)
  const [message, setMessage] = React.useState('')

  const refresh = async () => {
    try {
      const [d, c] = await Promise.all([
        fetch('/api/plugin-hub/doctor').then((r) => r.json()),
        fetch('/api/plugin-hub/catalog').then((r) => r.json()),
      ])
      setDoctor(d)
      setCatalog(Array.isArray(c) ? c : [])
    } catch {
      setDoctor(null)
      setCatalog([])
    }
  }
  React.useEffect(() => { void refresh() }, [])

  const ready = doctor?.status === 'PLATFORM_READY'
  const statusText =
    doctor?.status === 'PLATFORM_READY' ? '平台就绪，可安装插件'
    : doctor?.status === 'NEEDS_RESTART' ? '需重启（fail-soft 补丁生效后）'
    : doctor?.status === 'NEEDS_FIX' ? '平台未就绪，需修复'
    : '检测中…'

  const act = async (item, action) => {
    setBusy(item.id)
    setMessage('')
    try {
      const res = await fetch(`/api/plugin-hub/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'quarantine' ? { id: item.id, reason: 'market' } : { id: item.id }),
      })
      const result = await res.json()
      setMessage(result?.ok
        ? `✅ ${item.name}：${result.action ?? '成功'}`
        : `❌ ${item.name}：${result?.error ?? '操作失败'}`)
      await refresh()
    } catch {
      setMessage(`❌ ${item.name}：请求失败`)
    }
    setBusy(null)
  }

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    // ── 标题 + 平台状态 ──
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      React.createElement('span', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } },
        '🛒 插件市场'),
      React.createElement(Pill, { active: ready }, ready ? '就绪' : '未就绪'),
    ),

    React.createElement('div', { style: cardStyle },
      React.createElement('div', { style: rowStyle },
        React.createElement(StateDot, { state: ready ? 'done' : 'error' }),
        React.createElement('span', null, statusText),
      ),
      !ready && Array.isArray(doctor?.blockers) && doctor.blockers.length > 0
        ? React.createElement('div', { style: { fontSize: 12, color: '#ff6b6b', lineHeight: 1.5 } },
            '阻塞项：' + doctor.blockers.join('；'))
        : null,
      React.createElement('div', { style: hintStyle },
        '第一原则：插件错误绝不影响服务拉起。非「平台就绪」时市场拒绝安装任何插件。'),
    ),

    // ── 目录列表 ──
    ...catalog.map((item) => React.createElement('div', { key: item.id, style: { ...cardStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } }, item.name),
          ...(item.badges ?? []).map((b) => {
            const t = badgeTone(b)
            return React.createElement(Pill, { key: b, active: true, style: { color: t.color, borderColor: t.color } }, t.label)
          }),
        ),
        React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #777)' } },
          item.package + ' · ' + item.description),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement(StateDot, { state: item.installed ? 'done' : 'idle' }),
          React.createElement('span', { style: { fontSize: 12 } },
            item.quarantined ? '已隔离' : item.installed ? '已安装' : '未安装')),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        item.quarantined
          ? React.createElement(Button, { size: 'sm', variant: 'outline', onClick: () => void act(item, 'restore'), disabled: busy === item.id },
              busy === item.id ? '…' : '恢复')
          : item.installed
            ? React.createElement(Button, { size: 'sm', variant: 'outline', onClick: () => void act(item, 'quarantine'), disabled: busy === item.id },
                busy === item.id ? '…' : '隔离')
            : React.createElement(Button, { size: 'sm', variant: 'primary', onClick: () => void act(item, 'install'), disabled: !ready || busy === item.id },
                busy === item.id ? '…' : '安装'),
      ),
    )),

    message ? React.createElement('div', { style: { fontSize: 12, color: '#8f8fff' } }, message) : null,
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-plugin-hub',
    label: () => '插件市场',
    inject: () => ({}),
  }, () => React.createElement(MarketPanel)), '@lanbaolu/dsh-plugin-hub: market section')
}
