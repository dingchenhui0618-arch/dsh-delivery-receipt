#!/usr/bin/env node
// 命令行入口：不装 DSH 也能出一张交付回执。
//
// 用法：
//   node scripts/receipt.mjs [--cwd <目录>] [--out <文件>] [--md|--json] [--no-run] [--quiet]
//
// 默认把人类可读的摘要打到 stdout；--out 落盘（HTML 或 Markdown），
// --md/--json 则直接打到 stdout。命令只来自 <cwd>/delivery-receipt.json，
// --no-run 可以只采集不执行。

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectProject } from '../lib/collect.js'
import { buildReceipt, renderHtml, renderMarkdown } from '../lib/receipt.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

function parseArgs(argv) {
  const out = { cwd: process.cwd(), out: '', format: 'summary', run: true, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cwd') out.cwd = argv[++i]
    else if (arg === '--out') out.out = argv[++i]
    else if (arg === '--md' || arg === '--markdown') out.format = 'markdown'
    else if (arg === '--json') out.format = 'json'
    else if (arg === '--html') out.format = 'html'
    else if (arg === '--no-run') out.run = false
    else if (arg === '--quiet') out.quiet = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else {
      console.error('未知参数：' + arg)
      out.help = true
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法：node scripts/receipt.mjs [--cwd <目录>] [--out <文件>] [--md|--json|--html] [--no-run] [--quiet]')
  process.exit(0)
}

const cwd = isAbsolute(args.cwd) ? args.cwd : resolve(args.cwd)
const collected = collectProject(cwd, { runCommands: args.run })
const receipt = buildReceipt({
  project: collected.cfg.project,
  cwd: cwd,
  version: pkg.version,
  home: homedir(),
  git: collected.git,
  testSteps: collected.cfg.tests,
  testResults: collected.testResults,
  buildSteps: collected.cfg.builds,
  buildResults: collected.buildResults,
  artifacts: collected.artifacts,
  scan: collected.scan,
  claims: collected.cfg.claims,
  notes: collected.notes,
})

const asJson = args.format === 'json' || (args.out.length > 0 && args.out.endsWith('.json'))
const asMarkdown = args.format === 'markdown' || (args.out.length > 0 && args.out.endsWith('.md'))
const body = asJson ? JSON.stringify(receipt, null, 2) + '\n' : asMarkdown ? renderMarkdown(receipt) : renderHtml(receipt)

if (args.out.length > 0) {
  writeFileSync(isAbsolute(args.out) ? args.out : resolve(args.out), body)
  if (!args.quiet) console.log('已写出 ' + args.out)
}

if (args.out.length === 0 || args.format === 'summary') {
  const g = receipt.git
  console.log('交付回执 · ' + receipt.project)
  console.log('  代码状态：' + (g ? g.branch + ' @ ' + g.headShort + (g.remoteMatchesHead ? '（与本地记录的远端一致）' : '（与本地记录的远端不一致）') : '不是 git 仓库'))
  console.log('  计数：已验证 ' + receipt.counts.verified + ' · 仅本地 ' + receipt.counts.localOnly + ' · 未验证 ' + receipt.counts.unverified)
  for (const zone of ['verified', 'localOnly', 'unverified']) {
    const claims = receipt.zones[zone]
    console.log('')
    console.log('  [' + zone + '] ' + claims.length + ' 条')
    if (claims.length === 0) {
      console.log('    （空）')
      continue
    }
    for (const claim of claims) {
      console.log('    - ' + claim.label + (claim.value ? '：' + claim.value : ''))
      console.log('      ' + (claim.evidenceLine || ''))
    }
  }
  if (receipt.notes.length > 0) {
    console.log('')
    console.log('  提示：')
    for (const note of receipt.notes) console.log('    · ' + note)
  }
}

if (args.format === 'markdown' && args.out.length === 0) console.log(body)
else if (args.format === 'json' && args.out.length === 0) console.log(body)
else if (args.format === 'html' && args.out.length === 0) console.log(body)
