// 装配与渲染层：把证据组装成回执对象，再渲染成自包含的 HTML 页与 Markdown。
//
// 两条硬约束写在这一层：
//   1. 回执对象在**生成时**就完成脱敏（家目录 → ~、疑似凭据 → <已隐去:...>），
//      所以 JSON 接口、HTML 页、Markdown、CLI 输出四条出口共用同一份干净数据。
//   2. HTML 必须自包含：没有 <link>、没有外链 <script>、没有 CDN —— 回执页会被
//      离线保存、贴进聊天、当附件发出去，任何外部依赖都会在别人的机器上变成空白。

import { redactText, sanitizePath } from './evidence.js'
import {
  ZONES,
  ZONE_EMPTY,
  ZONE_HINT,
  ZONE_LABEL,
  artifactClaims,
  commandClaims,
  declarationClaims,
  gitClaims,
  groupClaims,
  resetIds,
  scanClaims,
} from './zones.js'

export const SCHEMA = 1
export const TOOL_NAME = 'dsh-delivery-receipt'

export const SECTIONS = [
  { id: 'git', title: '分支与提交' },
  { id: 'tests', title: '测试结果' },
  { id: 'builds', title: '构建结果' },
  { id: 'artifacts', title: '交付物（尺寸与哈希）' },
  { id: 'scan', title: '密钥扫描' },
  { id: 'author-claims', title: '作者自述' },
  { id: 'config', title: '配置提示' },
]

export function sectionTitle(id) {
  const found = SECTIONS.filter((s) => s.id === id)[0]
  return found ? found.title : id
}

export function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function clean(text, home) {
  return redactText(sanitizePath(String(text === undefined || text === null ? '' : text), home))
}

export function evidenceLine(claim) {
  const ev = claim.evidence || {}
  switch (ev.kind) {
    case 'git':
      return '证据：git ' + ev.ref + (ev.local ? '（本地记录，未推送）' : '（本地记录的远端引用）')
    case 'command':
      if (ev.ran !== true) return '证据：无 —— 这条命令本次没有运行'
      return '证据：`' + ev.command + '` 退出码 ' + ev.exitCode + ' · ' + Math.round(ev.ms) + ' ms'
    case 'file':
      if (ev.matched === false) return '证据：无 —— 声明的文件不存在'
      return '证据：sha256 ' + ev.sha256 + ' · ' + ev.bytes + ' B' + (ev.tracked ? ' · 已入版本库' : ' · 未入版本库')
    case 'scan':
      return '证据：扫描 ' + (typeof ev.filesScanned === 'number' ? ev.filesScanned : 0) + ' 个文件（规则来自内置清单）'
    case 'declaration':
      return '证据：无 —— 这是人写的声明，未附任何证据'
    default:
      return '证据：无'
  }
}

// 组装。所有字符串在这里统一脱敏；分区由 zones.js 的规则算出，这一层不做任何判断。
export function buildReceipt(input) {
  const src = input || {}
  const home = src.home
  resetIds()

  const claims = []
    .concat(gitClaims(src.git))
    .concat(commandClaims('tests', src.testSteps, src.testResults))
    .concat(commandClaims('builds', src.buildSteps, src.buildResults))
    .concat(artifactClaims(src.artifacts))
    .concat(scanClaims(src.scan))
    .concat(declarationClaims(src.claims, 'author-claims'))

  const cleaned = claims.map((claim) => Object.assign({}, claim, {
    label: clean(claim.label, home),
    value: clean(claim.value, home),
    detail: claim.detail ? clean(claim.detail, home) : '',
    evidence: claim.evidence && claim.evidence.kind === 'command'
      ? Object.assign({}, claim.evidence, { command: clean(claim.evidence.command, home) })
      : claim.evidence,
  }))

  const groups = groupClaims(cleaned)
  for (const zone of ZONES) {
    groups[zone] = groups[zone].map((claim) => Object.assign({}, claim, {
      sectionTitle: sectionTitle(claim.section),
      evidenceLine: evidenceLine(claim),
    }))
  }

  const scoped = {
    project: clean(src.project || '未命名项目', home),
    cwd: clean(src.cwd || '', home),
    generatedAt: src.generatedAt || new Date().toISOString(),
    environment: {
      platform: src.environment && src.environment.platform ? src.environment.platform : process.platform,
      node: src.environment && src.environment.node ? src.environment.node : process.version,
    },
    git: src.git && src.git.isRepo === true
      ? {
        branch: clean(src.git.branch, home),
        headSha: src.git.headSha,
        headShort: src.git.headShort,
        subject: clean(src.git.subject, home),
        remoteUrl: clean(src.git.remoteUrl, home),
        remoteRef: src.git.remoteRef,
        remoteRefName: clean(src.git.remoteRefName, home),
        remoteMatchesHead: Boolean(src.git.remoteMatchesHead),
        ahead: src.git.ahead,
        clean: Boolean(src.git.clean),
        dirtyCount: Array.isArray(src.git.dirty) ? src.git.dirty.length : 0,
        tagsAtHead: Array.isArray(src.git.tagsAtHead) ? src.git.tagsAtHead.map((t) => clean(t, home)) : [],
      }
      : null,
    notes: (Array.isArray(src.notes) ? src.notes : []).map((n) => clean(n, home)),
  }

  return Object.assign({
    schema: SCHEMA,
    tool: { name: TOOL_NAME, version: src.version || '0.0.0' },
    counts: {
      verified: groups.verified.length,
      localOnly: groups.localOnly.length,
      unverified: groups.unverified.length,
      total: cleaned.length,
    },
    sections: SECTIONS.map((section) => ({
      id: section.id,
      title: section.title,
      total: cleaned.filter((c) => c.section === section.id).length,
      verified: groups.verified.filter((c) => c.section === section.id).length,
      localOnly: groups.localOnly.filter((c) => c.section === section.id).length,
      unverified: groups.unverified.filter((c) => c.section === section.id).length,
    })),
    zones: groups,
  }, scoped)
}

export function summarize(receipt) {
  if (!receipt) return null
  return {
    project: receipt.project,
    generatedAt: receipt.generatedAt,
    counts: receipt.counts,
    git: receipt.git
      ? {
        branch: receipt.git.branch,
        headShort: receipt.git.headShort,
        remoteMatchesHead: receipt.git.remoteMatchesHead,
        ahead: receipt.git.ahead,
        clean: receipt.git.clean,
      }
      : null,
  }
}

function toneClass(tone) {
  return tone === 'ok' ? 'sr-ok' : tone === 'warn' ? 'sr-warn' : tone === 'bad' ? 'sr-bad' : 'sr-muted'
}

const HTML_STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;padding:28px 20px 56px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1c1c1e;background:#f5f5f7}',
  '.sr-wrap{max-width:1000px;margin:0 auto}',
  'h1{font-size:20px;margin:0 0 4px}',
  '.sr-sub{color:#6b6b70;font-size:13px;margin-bottom:18px}',
  '.sr-sub code{font-size:12px}',
  '.sr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:18px}',
  '.sr-zone{background:#fff;border:1px solid #e3e3e6;border-radius:10px;padding:14px 16px}',
  '.sr-zone h2{font-size:14px;margin:0 0 2px;display:flex;align-items:center;gap:8px}',
  '.sr-count{font-size:12px;color:#6b6b70;font-weight:400}',
  '.sr-hint{font-size:12px;color:#6b6b70;margin:6px 0 12px}',
  '.sr-zone.sr-verified{border-top:3px solid #16a34a}',
  '.sr-zone.sr-localOnly{border-top:3px solid #d97706}',
  '.sr-zone.sr-unverified{border-top:3px solid #9ca3af}',
  '.sr-claim{padding:9px 0;border-top:1px solid #eeeef0}',
  '.sr-claim:first-of-type{border-top:0}',
  '.sr-claim-label{font-weight:600;font-size:13px;word-break:break-all}',
  '.sr-claim-value{font-size:13px;word-break:break-word}',
  '.sr-claim-detail{font-size:12px;color:#6b6b70;margin-top:2px}',
  '.sr-ev{font-size:11.5px;color:#6b6b70;margin-top:4px;word-break:break-all}',
  '.sr-ev code{font-size:11px}',
  '.sr-sec{font-size:11px;color:#8a8a90}',
  '.sr-ok{color:#15803d}',
  '.sr-warn{color:#b45309}',
  '.sr-bad{color:#b91c1c}',
  '.sr-muted{color:#6b6b70}',
  '.sr-empty{color:#8a8a90;font-size:12.5px;padding:6px 0}',
  '.sr-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e3e6;border-radius:10px;overflow:hidden}',
  '.sr-table th,.sr-table td{text-align:left;padding:7px 12px;font-size:12.5px;border-bottom:1px solid #eeeef0}',
  '.sr-table th{background:#fafafa;font-weight:600}',
  '.sr-note{background:#fff;border:1px solid #e3e3e6;border-radius:10px;padding:12px 16px;font-size:12.5px;color:#4b4b50;margin-top:16px}',
  '.sr-note h3{font-size:13px;margin:0 0 6px}',
  '.sr-foot{margin-top:20px;font-size:12px;color:#6b6b70}',
  '@media print{body{background:#fff;padding:0}.sr-zone,.sr-table,.sr-note{break-inside:avoid}}',
].join('')

function claimHtml(claim) {
  const value = claim.value ? '<div class="sr-claim-value ' + toneClass(claim.tone) + '">' + esc(claim.value) + '</div>' : ''
  const detail = claim.detail ? '<div class="sr-claim-detail">' + esc(claim.detail) + '</div>' : ''
  return '<div class="sr-claim">'
    + '<div class="sr-claim-label">' + esc(claim.label) + ' <span class="sr-sec">[' + esc(claim.sectionTitle || claim.section) + ']</span></div>'
    + value
    + detail
    + '<div class="sr-ev">' + esc(claim.evidenceLine || evidenceLine(claim)) + '</div>'
    + '</div>'
}

export function renderHtml(receipt, options) {
  const opts = options || {}
  const title = opts.title || ('交付回执 · ' + receipt.project)
  const git = receipt.git
  const head = git
    ? esc(git.branch) + ' @ ' + esc(git.headShort || '') + ' · ' + (git.remoteMatchesHead ? '与本地记录的远端一致' : '与本地记录的远端不一致')
    : '不是一个 git 仓库'

  const zonesHtml = ZONES.map((zone) => {
    const claims = receipt.zones[zone]
    const body = claims.length === 0
      ? '<div class="sr-empty">' + esc(ZONE_EMPTY[zone]) + '</div>'
      : claims.map(claimHtml).join('')
    return '<section class="sr-zone sr-' + zone + '">'
      + '<h2>' + esc(ZONE_LABEL[zone]) + ' <span class="sr-count">' + claims.length + ' 条</span></h2>'
      + '<div class="sr-hint">' + esc(ZONE_HINT[zone]) + '</div>'
      + body
      + '</section>'
  }).join('')

  const rows = receipt.sections
    .filter((s) => s.total > 0)
    .map((s) => '<tr><td>' + esc(s.title) + '</td><td>' + s.total + '</td><td class="sr-ok">' + s.verified
      + '</td><td class="sr-warn">' + s.localOnly + '</td><td class="sr-muted">' + s.unverified + '</td></tr>')
    .join('')

  const notes = receipt.notes.length > 0
    ? '<div class="sr-note"><h3>生成过程中的提示（不是声明，不进任何分区）</h3><ul>'
      + receipt.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>'
    : ''

  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>' + esc(title) + '</title>\n<style>' + HTML_STYLE + '</style>\n</head>\n<body>\n<div class="sr-wrap">\n'
    + '<h1>' + esc(title) + '</h1>\n'
    + '<div class="sr-sub">' + head + ' · 生成于 ' + esc(receipt.generatedAt)
    + ' · 工具 ' + esc(receipt.tool.name) + ' ' + esc(receipt.tool.version)
    + ' · node ' + esc(receipt.environment.node) + ' / ' + esc(receipt.environment.platform) + '</div>\n'
    + '<div class="sr-grid">\n' + zonesHtml + '\n</div>\n'
    + (rows ? '<table class="sr-table"><thead><tr><th>板块</th><th>合计</th><th>已验证</th><th>仅本地</th><th>未验证</th></tr></thead><tbody>' + rows + '</tbody></table>\n' : '')
    + '<div class="sr-note"><h3>怎么读这张回执</h3><ul>'
    + '<li>三区分的是<strong>证据强度</strong>，不是成败：测试失败、密钥扫描命中都是"已验证"的事实，只是不好看。</li>'
    + '<li>"仅本地"里的东西（未提交改动、未推送提交、未入仓的交付物哈希）在别处复现不出来，别当作已经交付。</li>'
    + '<li>"未验证"里只有被声称、没有被验证的东西；空着就是空着，本页不会替它补一句话。</li>'
    + '<li>本页不含凭据：密钥命中只记录文件名、行号与规则名，匹配到的内容已被丢弃。</li>'
    + '</ul></div>\n'
    + notes
    + '<div class="sr-foot">' + TOOL_NAME + ' · schema ' + SCHEMA + ' · 本页自包含（无外链脚本、无 CDN、无追踪）</div>\n'
    + '</div>\n</body>\n</html>\n'
}

export function renderMarkdown(receipt) {
  const out = []
  out.push('# 交付回执 · ' + receipt.project)
  out.push('')
  const git = receipt.git
  out.push('- 代码状态：' + (git
    ? git.branch + ' @ ' + (git.headShort || '') + (git.remoteMatchesHead ? '（与本地记录的远端一致）' : '（与本地记录的远端不一致）')
    : '不是 git 仓库'))
  out.push('- 生成时间：' + receipt.generatedAt)
  out.push('- 工具：' + receipt.tool.name + ' ' + receipt.tool.version + '（node ' + receipt.environment.node + ' / ' + receipt.environment.platform + '）')
  out.push('- 计数：已验证 ' + receipt.counts.verified + ' · 仅本地 ' + receipt.counts.localOnly + ' · 未验证 ' + receipt.counts.unverified)
  out.push('')
  for (const zone of ZONES) {
    const claims = receipt.zones[zone]
    out.push('## ' + ZONE_LABEL[zone] + '（' + claims.length + '）')
    out.push('')
    if (claims.length === 0) {
      out.push('_' + ZONE_EMPTY[zone] + '_')
      out.push('')
      continue
    }
    for (const claim of claims) {
      const value = claim.value ? '：' + claim.value : ''
      out.push('- **' + claim.label + '**' + value + ' `[' + (claim.sectionTitle || claim.section) + ']`')
      if (claim.detail) out.push('  - ' + claim.detail)
      out.push('  - ' + (claim.evidenceLine || evidenceLine(claim)))
    }
    out.push('')
  }
  if (receipt.notes.length > 0) {
    out.push('## 生成过程中的提示')
    out.push('')
    for (const note of receipt.notes) out.push('- ' + note)
    out.push('')
  }
  out.push('> 三区分的是证据强度，不是成败；「未验证」为空表示没有被声称却缺证据的东西。')
  out.push('')
  return out.join('\n')
}

const EMPTY_STYLE = 'body{margin:0;padding:48px 20px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1c1c1e;background:#f5f5f7}'
  + '.sr-wrap{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e3e3e6;border-radius:10px;padding:20px 24px}'
  + 'h1{font-size:17px;margin:0 0 8px}p{color:#4b4b50}code{font-size:12.5px}'

// 还没有回执时的页面：说清"没有"，而不是渲染一张看起来像有内容的空表。
export function renderEmptyHtml(project, reason) {
  const why = reason || '还没有生成过回执。'
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>交付回执 · 尚未生成</title>\n<style>' + EMPTY_STYLE + '</style>\n</head>\n<body>\n<div class="sr-wrap">\n'
    + '<h1>' + esc(project || '交付回执') + '：还没有回执</h1>\n'
    + '<p>' + esc(why) + '</p>\n'
    + '<p>在面板里点「生成回执」，或对 <code>/dsh-delivery-receipt/generate</code> 发一个 POST。</p>\n'
    + '<p>这张页面此时<strong>不包含任何分区内容</strong>——三区为空时不会渲染成"看起来像有"的表。</p>\n'
    + '</div>\n</body>\n</html>\n'
}
