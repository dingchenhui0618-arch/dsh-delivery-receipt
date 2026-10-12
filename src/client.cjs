// Client half of dsh-delivery-receipt: 对话视图里的「交付回执」面板。
//
// 必须保持 CommonJS —— 构建脚本会把它包进 window.__ModuleLoader__.load()，
// React 由宿主提供（不打包进来）。
//
// 这个面板**刻意不轮询**。生态里已有的状态类插件都是给自己看的实时看板；
// 这张回执是"收尾时按一下、然后拿去给人看"的东西，实时刷新反而会让人以为
// 回执一直在自动更新。所以：挂载时读一次、点「生成」时算一次。

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-delivery-receipt'

const ZONES = ['verified', 'localOnly', 'unverified']
const ZONE_LABEL = { verified: '已验证', localOnly: '仅本地', unverified: '未验证' }
const ZONE_HINT = {
  verified: '有可复现证据',
  localOnly: '只在这台机器上成立',
  unverified: '只有声称，没有证据',
}
const EMPTY = {
  verified: '没有任何一条声明带上了可复现证据。',
  localOnly: '没有只在本机成立的事实。',
  unverified: '没有被声称却缺少证据的东西。',
}

// 模块级缓存：切 Tab 回来不用重算，也不留计时器（卸载时无需清理）。
let snap = { state: null, receipt: null, error: '', busy: false, note: '' }
const listeners = new Set()

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-delivery-receipt] listener failed', error)
    }
  })
}

function set(patch) {
  snap = Object.assign({}, snap, patch)
  emit()
}

function loadState() {
  return fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) { set({ state: data, error: '' }) })
    .catch(function (error) { set({ error: String((error && error.message) || error) }) })
}

function generate() {
  set({ busy: true, note: '' })
  return fetch(API + '/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data } }) })
    .then(function (out) {
      if (out.status !== 200 || !out.data.receipt) {
        set({ busy: false, error: (out.data && out.data.error) || ('生成失败：HTTP ' + out.status) })
        return
      }
      set({ busy: false, receipt: out.data.receipt, error: '', note: '已生成：' + new Date().toLocaleTimeString() })
      return loadState()
    })
    .catch(function (error) { set({ busy: false, error: String((error && error.message) || error) }) })
}

function copyMarkdown() {
  return fetch(API + '/receipt.md')
    .then(function (res) { return res.text() })
    .then(function (text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { set({ note: 'Markdown 已复制到剪贴板' }) })
      }
      set({ note: '这个环境没有剪贴板权限：打开回执页后手动复制即可' })
    })
    .catch(function (error) { set({ error: String((error && error.message) || error) }) })
}

function Stat(props) {
  return h('div', { className: 'dr-stat dr-' + props.zone },
    h('b', null, String(props.value)),
    h('span', null, props.label),
  )
}

function Claim(props) {
  const c = props.c
  return h('div', { className: 'dr-claim' },
    h('div', { className: 'dr-claim-head' },
      h('span', { className: 'dr-claim-label' }, c.label),
      h('span', { className: 'dr-sec' }, c.sectionTitle || c.section),
    ),
    c.value ? h('div', { className: 'dr-claim-value dr-' + (c.tone || 'muted') }, c.value) : null,
    c.detail ? h('div', { className: 'dr-claim-detail' }, c.detail) : null,
    h('div', { className: 'dr-ev' }, c.evidenceLine || '证据：无'),
  )
}

function Zone(props) {
  const claims = props.claims || []
  return h('section', { className: 'dr-zone dr-' + props.zone },
    h('h4', null, ZONE_LABEL[props.zone], h('span', { className: 'dr-count' }, claims.length + ' 条'),
      h('span', { className: 'dr-hint' }, ZONE_HINT[props.zone])),
    claims.length === 0
      ? h('div', { className: 'dr-empty' }, EMPTY[props.zone])
      : h('div', null, claims.map(function (c, i) { return h(Claim, { key: c.id || String(i), c: c }) })),
  )
}

function ReceiptView() {
  const [local, setLocal] = React.useState(snap)
  React.useEffect(function () {
    listeners.add(setLocal)
    if (snap.state === null && snap.error === '') loadState()
    else setLocal(snap)
    return function () { listeners.delete(setLocal) }
  }, [])

  const state = local.state
  const receipt = local.receipt || (state && state.receipt ? null : null)
  const detail = receipt
  const cfg = state && state.config ? state.config : null

  return h('div', { className: 'dr-root' },
    h('div', { className: 'dr-head' },
      h('div', null,
        h('div', { className: 'dr-title' }, '交付回执'),
        h('div', { className: 'dr-sub' }, '把能证明的和证不了的硬性分开：已验证 / 仅本地 / 未验证'),
      ),
      h('div', { className: 'dr-spacer' }),
      h('button', { className: 'dr-btn dr-primary', type: 'button', disabled: local.busy, onClick: generate },
        local.busy ? '生成中…' : '生成回执'),
      h('button', {
        className: 'dr-btn',
        type: 'button',
        onClick: function () { window.open(API + '/receipt.html', '_blank', 'noopener') },
      }, '打开回执页'),
      h('button', { className: 'dr-btn', type: 'button', onClick: copyMarkdown }, '复制 Markdown'),
      h('button', { className: 'dr-btn', type: 'button', onClick: loadState }, '刷新'),
    ),

    local.error ? h('div', { className: 'dr-err' }, local.error) : null,
    local.note ? h('div', { className: 'dr-note-line' }, local.note) : null,

    cfg ? h('div', { className: 'dr-card' },
      h('h4', null, '这次会采集什么'),
      h('div', { className: 'dr-mono' }, cfg.cwd || '（未配置目录）'),
      h('div', { className: 'dr-meta' },
        '项目 ' + (cfg.project || '—')
        + ' · 配置来源 ' + (cfg.source === 'file' ? 'delivery-receipt.json' : cfg.source === 'inline' ? '插件配置' : '没有配置文件')
        + ' · 执行声明命令：' + (cfg.runCommands ? '是' : '否')),
      (cfg.tests || []).concat(cfg.builds || []).length > 0
        ? h('div', { className: 'dr-cmds' }, (cfg.tests || []).concat(cfg.builds || []).map(function (step, i) {
          return h('div', { className: 'dr-mono dr-cmd', key: 'c' + i }, '$ ' + step.command)
        }))
        : h('div', { className: 'dr-meta' }, '配置里没有声明测试/构建命令 —— 那就不会有测试结论，也不会替它编一个。'),
      (cfg.artifacts || []).length > 0
        ? h('div', { className: 'dr-meta' }, '交付物模式：' + cfg.artifacts.join('、'))
        : null,
      (cfg.configNotes || []).length > 0
        ? h('div', { className: 'dr-meta dr-warn' }, cfg.configNotes.join(' / '))
        : null,
    ) : null,

    detail
      ? h('div', null,
        h('div', { className: 'dr-stats' },
          h(Stat, { zone: 'verified', label: '已验证', value: detail.counts.verified }),
          h(Stat, { zone: 'localOnly', label: '仅本地', value: detail.counts.localOnly }),
          h(Stat, { zone: 'unverified', label: '未验证', value: detail.counts.unverified }),
        ),
        h('div', { className: 'dr-zones' }, ZONES.map(function (zone) {
          return h(Zone, { key: zone, zone: zone, claims: detail.zones[zone] })
        })),
        (detail.notes || []).length > 0
          ? h('div', { className: 'dr-card' },
            h('h4', null, '生成过程中的提示'),
            detail.notes.map(function (n, i) { return h('div', { className: 'dr-meta', key: 'n' + i }, '· ' + n) }))
          : null,
      )
      : h('div', { className: 'dr-card' },
        h('h4', null, state && state.hasReceipt ? '已有回执（摘要）' : '还没有回执'),
        h('div', { className: 'dr-meta' }, state && state.hasReceipt
          ? '上一次生成于 ' + (state.receipt && state.receipt.generatedAt) + '；点「生成回执」重新算一次，或点「打开回执页」看完整页面。'
          : '点「生成回执」开始。三区为空时页面会显示"此区无证据"，不会补任何一句话。'),
      ),
  )
}

function apply(ctx) {
  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-delivery-receipt'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // 与其他插件同样的防御：槽位契约变了只丢这一个面板，不能拖垮整个客户端启动。
  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'delivery-receipt', order: 50, label: '交付回执' },
        ReceiptView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-delivery-receipt] 无法注册「交付回执」面板；host 侧的 /dsh-delivery-receipt 路由仍然可用', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-delivery-receipt',
  inject: ['slots'],
  apply: apply,
}
