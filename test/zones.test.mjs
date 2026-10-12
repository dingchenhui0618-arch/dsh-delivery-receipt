// 判定层测试：三区规则是这个插件的全部主张，所以逐条钉死。
//
// 两个容易写错、也最要紧的点：
//   1. 分区看的是**证据强度**，不是成败 —— 测试失败同样是"已验证"的事实。
//   2. 没有证据的东西一律进未验证区，绝不被"补"成事实；空就是空。

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  artifactClaims,
  classifyClaim,
  commandClaims,
  declarationClaims,
  gitClaims,
  groupClaims,
  scanClaims,
} from '../src/zones.js'

test('classifyClaim：git 证据按"是否只能在本机成立"分区', () => {
  assert.equal(classifyClaim({ evidence: { kind: 'git', resolved: true, local: false } }), 'verified')
  assert.equal(classifyClaim({ evidence: { kind: 'git', resolved: true, local: true } }), 'localOnly')
  assert.equal(classifyClaim({ evidence: { kind: 'git', resolved: false, local: false } }), 'unverified')
})

test('classifyClaim：命令跑了就是已验证，超时/没跑是未验证', () => {
  assert.equal(classifyClaim({ evidence: { kind: 'command', ran: true, exitCode: 0 } }), 'verified')
  assert.equal(classifyClaim({ evidence: { kind: 'command', ran: true, exitCode: 1 } }), 'verified', '失败也是有证据的事实')
  assert.equal(classifyClaim({ evidence: { kind: 'command', ran: true, timedOut: true } }), 'unverified')
  assert.equal(classifyClaim({ evidence: { kind: 'command', ran: false } }), 'unverified')
})

test('classifyClaim：文件哈希入仓才算已验证，未入仓是仅本地，没文件是未验证', () => {
  assert.equal(classifyClaim({ evidence: { kind: 'file', matched: true, sha256: 'abc', tracked: true } }), 'verified')
  assert.equal(classifyClaim({ evidence: { kind: 'file', matched: true, sha256: 'abc', tracked: false } }), 'localOnly')
  assert.equal(classifyClaim({ evidence: { kind: 'file', matched: false } }), 'unverified')
  assert.equal(classifyClaim({ evidence: { kind: 'file', matched: true, tracked: true } }), 'unverified', '没有哈希就不算证据')
})

test('classifyClaim：扫描 0 个文件时连 clean 也不作数', () => {
  assert.equal(classifyClaim({ evidence: { kind: 'scan', filesScanned: 3, hits: 0 } }), 'verified')
  assert.equal(classifyClaim({ evidence: { kind: 'scan', filesScanned: 0, hits: 0 } }), 'unverified')
})

test('classifyClaim：人写的话与缺失证据一律未验证', () => {
  assert.equal(classifyClaim({ evidence: { kind: 'declaration' } }), 'unverified')
  assert.equal(classifyClaim({ evidence: { kind: 'unknown-kind' } }), 'unverified')
  assert.equal(classifyClaim({}), 'unverified')
  assert.equal(classifyClaim(null), 'unverified')
})

test('gitClaims：远端一致时 HEAD 是已验证，脏工作区只能是仅本地', () => {
  const claims = gitClaims({
    isRepo: true,
    branch: 'main',
    headSha: 'a'.repeat(40),
    headShort: 'aaaaaaa',
    subject: 'feat: x',
    remoteUrl: 'git@github.com:example/repo.git',
    remoteRef: 'a'.repeat(40),
    remoteRefName: 'origin/main',
    remoteMatchesHead: true,
    ahead: 0,
    clean: false,
    dirty: ['src/a.js'],
    untracked: [],
    tagsAtHead: [],
  })
  const byLabel = Object.fromEntries(claims.map((c) => [c.label, c]))
  assert.equal(classifyClaim(byLabel['HEAD 提交']), 'verified')
  assert.equal(classifyClaim(byLabel['未提交改动']), 'localOnly', '工作区脏天生只在本机成立')
  assert.equal(classifyClaim(byLabel['未推送提交']), 'verified', 'ahead=0 是有证据的好消息')
  assert.equal(byLabel['未提交改动'].tone, 'warn')
})

test('gitClaims：未推送提交与标签都落在仅本地', () => {
  const claims = gitClaims({
    isRepo: true,
    branch: 'main',
    headSha: 'b'.repeat(40),
    headShort: 'bbbbbbb',
    subject: 'wip',
    remoteUrl: '',
    remoteRef: 'a'.repeat(40),
    remoteRefName: 'origin/main',
    remoteMatchesHead: false,
    ahead: 3,
    clean: true,
    dirty: [],
    untracked: [],
    tagsAtHead: ['v9'],
  })
  const byLabel = Object.fromEntries(claims.map((c) => [c.label, c]))
  assert.equal(classifyClaim(byLabel['未推送提交']), 'localOnly')
  assert.equal(classifyClaim(byLabel['HEAD 提交']), 'localOnly')
  assert.equal(classifyClaim(byLabel['HEAD 上的标签']), 'localOnly', '标签是否推到远端离线读不到，不能声称已验证')
})

test('gitClaims：不是仓库时只留一条声明，且归仅本地', () => {
  const claims = gitClaims({ isRepo: false, error: '不是一个 git 仓库' })
  assert.equal(claims.length, 1)
  assert.equal(classifyClaim(claims[0]), 'localOnly')
  assert.match(claims[0].value, /不是一个 git 仓库/)
})

test('commandClaims：声明了但没运行 → 未验证（这就是"声称有测试"的样子）', () => {
  const claims = commandClaims('tests', [{ name: '单元测试', command: 'node --test' }], [])
  assert.equal(claims.length, 1)
  assert.equal(classifyClaim(claims[0]), 'unverified')
  assert.match(claims[0].value, /没有运行/)
})

test('commandClaims：跑出结果就是已验证，并带上退出码、计数与耗时', () => {
  const claims = commandClaims('tests', [{ name: '单元测试', command: 'node --test' }], [
    { name: '单元测试', exitCode: 0, timedOut: false, ms: 1234, counts: { pass: 40, fail: 0, total: 40 }, summary: '' },
  ])
  assert.equal(classifyClaim(claims[0]), 'verified')
  assert.match(claims[0].value, /exit 0/)
  assert.match(claims[0].value, /通过 40/)
  assert.match(claims[0].value, /1234 ms/)
  assert.equal(claims[0].tone, 'ok')
})

test('commandClaims：失败会带 bad 色调但仍然是已验证', () => {
  const claims = commandClaims('tests', [{ name: 't', command: 'node --test' }], [
    { name: 't', exitCode: 1, timedOut: false, ms: 10, counts: { pass: 2, fail: 1, total: 3 }, summary: 'boom' },
  ])
  assert.equal(claims[0].tone, 'bad')
  assert.equal(classifyClaim(claims[0]), 'verified')
  assert.equal(claims[0].detail, 'boom')
})

test('artifactClaims：入仓的交付物已验证，未入仓的仅本地，缺席的未验证', () => {
  const claims = artifactClaims([
    { pattern: 'docs/a.png', path: 'docs/a.png', matched: true, bytes: 10, sha256: 'f'.repeat(64), tracked: true, image: { format: 'png', width: 1, height: 1 } },
    { pattern: 'docs/b.png', path: 'docs/b.png', matched: true, bytes: 20, sha256: 'e'.repeat(64), tracked: false, image: null },
    { pattern: 'docs/c.png', matched: false },
  ])
  assert.equal(classifyClaim(claims[0]), 'verified')
  assert.equal(classifyClaim(claims[1]), 'localOnly')
  assert.equal(classifyClaim(claims[2]), 'unverified')
  assert.match(claims[0].value, /sha256 ffffffffffffffff/)
  assert.match(claims[1].detail, /未被 git 跟踪/)
  assert.match(claims[2].value, /没有匹配到任何文件/)
})

test('scanClaims：命中只带文件名、行号与规则名，不带内容', () => {
  const claims = scanClaims({
    enabled: true,
    filesConsidered: 5,
    filesScanned: 4,
    skipped: { binary: 1, oversized: 0, ignored: 0, unreadable: 0 },
    hits: [{ file: 'src/leak.js', line: 2, rule: 'github-token', label: 'GitHub token', severity: 'high' }],
    clean: false,
  })
  const hit = claims.filter((c) => c.section === 'scan' && c.label === 'src/leak.js:2')[0]
  assert.ok(hit, '命中有单独一条声明')
  assert.equal(classifyClaim(hit), 'verified', '命中本身是有证据的事实')
  assert.match(hit.value, /github-token/)
  assert.equal(JSON.stringify(claims).includes('ghp_'), false)
  const conclusion = claims.filter((c) => c.label === '扫描结论')[0]
  assert.equal(conclusion.tone, 'bad')
  assert.match(conclusion.value, /命中 1 处/)
})

test('scanClaims：关掉扫描时明确写未启用，而不是写"干净"', () => {
  const claims = scanClaims({ enabled: false })
  assert.equal(claims.length, 1)
  assert.equal(classifyClaim(claims[0]), 'unverified')
  assert.match(claims[0].value, /未启用/)
})

test('declarationClaims：作者自述永远是未验证', () => {
  const claims = declarationClaims([{ label: '已发布到 npm', value: '0.1.0' }], 'author-claims')
  assert.equal(classifyClaim(claims[0]), 'unverified')
  assert.equal(claims[0].section, 'author-claims')
  assert.equal(claims[0].tone, 'muted')
})

test('groupClaims：每条声明恰好落在一个区，且分区合计等于总数', () => {
  const claims = []
    .concat(gitClaims({
      isRepo: true, branch: 'main', headSha: 'a'.repeat(40), headShort: 'aaaaaaa', subject: 's',
      remoteUrl: '', remoteRef: 'a'.repeat(40), remoteRefName: 'origin/main', remoteMatchesHead: true,
      ahead: 0, clean: true, dirty: [], untracked: [], tagsAtHead: [],
    }))
    .concat(declarationClaims([{ label: '自述' }]))
  const groups = groupClaims(claims)
  const total = groups.verified.length + groups.localOnly.length + groups.unverified.length
  assert.equal(total, claims.length)
  assert.equal(groups.unverified.length, 1)
  const ids = new Set(claims.map((c) => c.id))
  assert.equal(ids.size, claims.length, 'id 必须唯一')
})
