// 渲染层测试：自包含、可公开、空区留空。
//
// 这几条是"可公开的页面"的底线：不能有外链、必须转义、命中过的密钥不能出现在
// 任何一条出口里、家目录要归一，以及三区为空时必须显示"此区无证据"。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildReceipt, evidenceLine, renderEmptyHtml, renderHtml, renderMarkdown, summarize } from '../src/receipt.js'

const HOME = 'C:\\Users\\example'

function baseInput(extra) {
  return Object.assign({
    project: 'demo',
    cwd: 'C:\\Users\\example\\Projects\\demo',
    home: HOME,
    version: '0.1.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    git: {
      isRepo: true,
      branch: 'main',
      headSha: 'a'.repeat(40),
      headShort: 'aaaaaaa',
      subject: 'feat: 交付回执',
      remoteUrl: 'git@github.com:example/demo.git',
      remoteRef: 'a'.repeat(40),
      remoteRefName: 'origin/main',
      remoteMatchesHead: true,
      ahead: 0,
      clean: true,
      dirty: [],
      untracked: [],
      tagsAtHead: [],
    },
    testSteps: [],
    testResults: [],
    buildSteps: [],
    buildResults: [],
    artifacts: [],
    scan: { enabled: true, filesConsidered: 2, filesScanned: 2, skipped: {}, hits: [], clean: true, rules: [] },
    claims: [],
    notes: [],
  }, extra || {})
}

test('buildReceipt：计数与板块合计自洽，且每条声明都带分区归属与证据行', () => {
  const receipt = buildReceipt(baseInput({
    testSteps: [{ name: '单元测试', command: 'node --test' }],
    testResults: [{ name: '单元测试', exitCode: 0, timedOut: false, ms: 20, counts: { pass: 30, fail: 0, total: 30 }, summary: '' }],
  }))
  assert.equal(receipt.counts.total, receipt.counts.verified + receipt.counts.localOnly + receipt.counts.unverified)
  assert.equal(receipt.counts.verified >= 1, true)
  const all = [].concat(receipt.zones.verified, receipt.zones.localOnly, receipt.zones.unverified)
  assert.equal(all.length, receipt.counts.total)
  for (const claim of all) {
    assert.equal(typeof claim.sectionTitle, 'string')
    assert.match(claim.evidenceLine, /^证据：/)
  }
  const testSection = receipt.sections.filter((s) => s.id === 'tests')[0]
  assert.equal(testSection.verified, 1)
})

test('buildReceipt：没有标签就不发标签声明，空区真的空', () => {
  const receipt = buildReceipt(baseInput({ git: { isRepo: false, error: '不是一个 git 仓库' } }))
  const total = receipt.counts.total
  assert.equal(total, 3, '不是仓库(仅本地) + 扫描范围 + 扫描结论')
  assert.equal(receipt.zones.verified.length, 2)
  assert.equal(receipt.zones.localOnly.length, 1)
  assert.equal(receipt.zones.unverified.length, 0)
  assert.equal(receipt.zones.verified.some((c) => c.value === '（无）'), false, '空标签列表不产生声明')
})

test('buildReceipt：声明的测试没跑就落在未验证区，且不补任何结论', () => {
  const receipt = buildReceipt(baseInput({ testSteps: [{ name: '单元测试', command: 'node --test' }] }))
  assert.equal(receipt.zones.unverified.length, 1)
  assert.match(receipt.zones.unverified[0].value, /没有运行/)
  assert.equal(receipt.zones.verified.some((c) => c.section === 'tests'), false)
})

test('renderHtml：三区标签与空区说明都在，且没有外部依赖', () => {
  const receipt = buildReceipt(baseInput())
  const html = renderHtml(receipt)
  assert.match(html, /已验证/)
  assert.match(html, /仅本地/)
  assert.match(html, /未验证/)
  assert.match(html, /<!doctype html>/)
  assert.match(html, /lang="zh-CN"/)
  // 自包含：没有 <link>、没有 <script>、没有外链 src/href。
  assert.equal(/<link/i.test(html), false)
  assert.equal(/<script/i.test(html), false)
  assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(html), false)
})

test('renderHtml：空区显示"此区无证据"这类明确说明，而不是编内容', () => {
  const receipt = buildReceipt(baseInput())
  const html = renderHtml(receipt)
  assert.equal(receipt.zones.unverified.length, 0)
  assert.match(html, /没有被声称却缺少证据的东西。/)
  assert.equal(receipt.zones.localOnly.length, 0)
  assert.match(html, /没有只在本机成立的事实。/)
})

test('renderHtml：标题与值都转义，XSS 进不来', () => {
  const receipt = buildReceipt(baseInput({
    claims: [{ label: '<script>alert(1)</script>', value: '"><img src=x onerror=alert(2)>' }],
  }))
  const html = renderHtml(receipt)
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /&quot;&gt;&lt;img/)
})

test('renderHtml / renderMarkdown：疑似凭据与家目录都不会漏出去', () => {
  const secret = 'ghp_' + 'K'.repeat(36)
  const receipt = buildReceipt(baseInput({
    claims: [{ label: '本地路径', value: HOME + '\\secret.txt 里有 ' + secret }],
  }))
  const html = renderHtml(receipt)
  const md = renderMarkdown(receipt)
  for (const out of [html, md, JSON.stringify(receipt)]) {
    assert.equal(out.includes(secret), false)
    assert.equal(out.includes('C:\\Users\\example'), false)
  }
  assert.match(md, /<已隐去:github-token>/)
  assert.match(md, /~\/secret\.txt/)
})

test('renderMarkdown：三区标题、计数与空区斜体说明齐全', () => {
  const receipt = buildReceipt(baseInput())
  const md = renderMarkdown(receipt)
  assert.match(md, /# 交付回执 · demo/)
  assert.match(md, /## 已验证（/)
  assert.match(md, /## 仅本地（0）/)
  assert.match(md, /_没有只在本机成立的事实。_/)
  assert.match(md, /三区分的是证据强度，不是成败/)
})

test('renderEmptyHtml：还没生成时只说明"没有"，不含任何分区内容', () => {
  const html = renderEmptyHtml('demo', '还没有生成过回执。')
  assert.match(html, /还没有回执/)
  assert.equal(html.includes('sr-zone'), false)
  assert.equal(html.includes('sr-claim'), false)
  assert.match(html, /不会渲染成/)
})

test('summarize：只给摘要，不带全部声明', () => {
  const receipt = buildReceipt(baseInput())
  const summary = summarize(receipt)
  assert.equal(summary.project, 'demo')
  assert.deepEqual(Object.keys(summary.counts).sort(), ['localOnly', 'total', 'unverified', 'verified'])
  assert.equal(summary.git.branch, 'main')
  assert.equal(summarize(null), null)
})

test('evidenceLine：五种证据形态各有一句人话', () => {
  assert.match(evidenceLine({ evidence: { kind: 'git', ref: 'HEAD', local: true } }), /本地记录，未推送/)
  assert.match(evidenceLine({ evidence: { kind: 'command', ran: false } }), /没有运行/)
  assert.match(evidenceLine({ evidence: { kind: 'command', ran: true, command: 'node --test', exitCode: 0, ms: 5 } }), /退出码 0/)
  assert.match(evidenceLine({ evidence: { kind: 'file', matched: false } }), /不存在/)
  assert.match(evidenceLine({ evidence: { kind: 'file', matched: true, sha256: 'ab', bytes: 3, tracked: true } }), /已入版本库/)
  assert.match(evidenceLine({ evidence: { kind: 'scan', filesScanned: 7 } }), /扫描 7 个文件/)
  assert.match(evidenceLine({ evidence: { kind: 'declaration' } }), /人写的声明/)
  assert.equal(evidenceLine({}), '证据：无')
})
