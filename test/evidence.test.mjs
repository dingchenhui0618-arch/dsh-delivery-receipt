// 采集层测试：git 解析、图片尺寸、哈希、密钥扫描、配置读取。
//
// 这里最重要的一条是「命中记录里不能出现密钥本身」—— 回执页是要拿出去给人看的，
// 所以扫描结果只允许携带 文件名 / 行号 / 规则名。

import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  artifactFacts,
  expandPattern,
  gitFacts,
  imageSize,
  loadConfig,
  normalizeConfig,
  parseTestCounts,
  redactText,
  sanitizePath,
  scanForSecrets,
  sha256,
  trackedFiles,
} from '../src/evidence.js'
import { gitExec, makeDir, writeFiles } from './helpers.mjs'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

function pngBuffer(width, height) {
  const buf = Buffer.alloc(24)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

test('imageSize 认 PNG 的 IHDR 尺寸', () => {
  const size = imageSize(pngBuffer(390, 844))
  assert.deepEqual(size, { format: 'png', width: 390, height: 844 })
})

test('imageSize 认真实的 1×1 PNG', () => {
  assert.deepEqual(imageSize(PNG_1x1), { format: 'png', width: 1, height: 1 })
})

test('imageSize 认 GIF 头', () => {
  const buf = Buffer.alloc(12)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(320, 6)
  buf.writeUInt16LE(200, 8)
  assert.deepEqual(imageSize(buf), { format: 'gif', width: 320, height: 200 })
})

test('imageSize 认 JPEG 的 SOF0，未知格式返回 null', () => {
  const buf = Buffer.alloc(20)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xc0
  buf.writeUInt16BE(11, 4)
  buf[6] = 8
  buf.writeUInt16BE(1080, 7)
  buf.writeUInt16BE(1920, 9)
  assert.deepEqual(imageSize(buf), { format: 'jpeg', width: 1920, height: 1080 })
  assert.equal(imageSize(Buffer.from('not an image at all')), null)
  assert.equal(imageSize(Buffer.alloc(0)), null)
})

test('sha256 是稳定的小写十六进制', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('redactText 隐去各类凭据，普通文本不动', () => {
  const gh = 'ghp_' + 'A'.repeat(36)
  const sk = 'sk-' + 'b'.repeat(30)
  assert.match(redactText('token=' + gh), /<已隐去:github-token>/)
  assert.doesNotMatch(redactText('token=' + gh), /ghp_/)
  assert.match(redactText(sk), /<已隐去:openai-style-key>/)
  assert.match(redactText('-----BEGIN RSA PRIVATE KEY-----'), /<已隐去:private-key-block>/)
  assert.match(redactText('Authorization: Bearer ' + 'x'.repeat(40)), /<已隐去:bearer-header>/)
  assert.match(redactText('password = "hunter2hunter2"'), /<已隐去:assigned-secret>/)
  assert.equal(redactText('普通的提交信息，没有凭据'), '普通的提交信息，没有凭据')
})

test('sanitizePath 把家目录与用户名归一成 ~', () => {
  assert.equal(sanitizePath('C:\\Users\\123\\Projects\\x', 'C:\\Users\\123'), '~/Projects/x')
  assert.equal(sanitizePath('/home/anna/work', '/home/anna'), '~/work')
  assert.equal(sanitizePath('D:\\Projects\\x', 'C:\\Users\\123'), 'D:/Projects/x')
  assert.equal(sanitizePath('src/a.js', 'C:\\Users\\123'), 'src/a.js')
})

test('parseTestCounts 认 node --test 的 TAP 汇总，也认 jest 的汇总', () => {
  assert.deepEqual(parseTestCounts('# tests 30\n# pass 29\n# fail 1\n'), { pass: 29, fail: 1, total: 30 })
  assert.deepEqual(parseTestCounts('# pass 5\n'), { pass: 5, fail: null, total: 5 })
  assert.deepEqual(parseTestCounts('Tests:       2 failed, 10 passed, 12 total'), { pass: 10, fail: 2, total: 12 })
  assert.equal(parseTestCounts('没有任何计数'), null)
})

test('expandPattern 支持精确路径与目录通配', () => {
  const dir = writeFiles(makeDir(), { 'docs/a.png': 'x', 'docs/b.png': 'y', 'docs/c.txt': 'z' })
  assert.deepEqual(expandPattern(dir, 'docs/a.png'), ['docs/a.png'])
  assert.deepEqual(expandPattern(dir, 'docs/*.png'), ['docs/a.png', 'docs/b.png'])
  assert.deepEqual(expandPattern(dir, 'docs/missing.png'), [])
  assert.deepEqual(expandPattern(dir, 'nope/*.png'), [])
})

test('artifactFacts 给出字节数、sha256、尺寸与是否入仓', () => {
  const dir = writeFiles(makeDir(), { 'docs/shot.png': PNG_1x1 })
  const tracked = trackedFiles(dir, gitExec({ tracked: 'docs/shot.png' }))
  assert.equal(tracked.ok, true)
  assert.deepEqual(tracked.files, ['docs/shot.png'])
  const facts = artifactFacts(dir, ['docs/shot.png', 'docs/missing.png'], { tracked: tracked.files })
  assert.equal(facts.length, 2)
  assert.equal(facts[0].matched, true)
  assert.equal(facts[0].tracked, true)
  assert.equal(facts[0].bytes, PNG_1x1.length)
  assert.equal(facts[0].sha256, sha256(PNG_1x1))
  assert.deepEqual(facts[0].image, { format: 'png', width: 1, height: 1 })
  assert.equal(facts[1].matched, false)
  assert.equal(facts[1].path, null)
})

test('scanForSecrets 干净时 clean=true，并给出扫描规模', () => {
  const dir = writeFiles(makeDir(), { 'a.js': 'const x = 1\n', 'b.md': '# hello\n' })
  const result = scanForSecrets(dir, { files: ['a.js', 'b.md'] })
  assert.equal(result.clean, true)
  assert.equal(result.filesScanned, 2)
  assert.equal(result.hits.length, 0)
})

test('scanForSecrets 命中时只记录 文件/行号/规则名，绝不带密钥本身', () => {
  const secret = 'ghp_' + 'Z'.repeat(36)
  const dir = writeFiles(makeDir(), { 'src/leak.js': 'const a = 1\nconst token = "' + secret + '"\n' })
  const result = scanForSecrets(dir, { files: ['src/leak.js'] })
  assert.equal(result.clean, false)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].file, 'src/leak.js')
  assert.equal(result.hits[0].line, 2)
  assert.equal(result.hits[0].rule, 'github-token')
  // 关键断言：序列化后的结果里既没有密钥，也没有它的片段。
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes(secret.slice(0, 12)), false)
})

test('scanForSecrets 会把被跟踪的凭据文件本身当命中（内容再干净也一样）', () => {
  const dir = writeFiles(makeDir(), { '.env': 'PLAIN=1\n' })
  const result = scanForSecrets(dir, { files: ['.env'] })
  assert.equal(result.hits.some((h) => h.rule === 'dotenv-file'), true)
})

test('scanForSecrets 跳过二进制、超大文件与被忽略的前缀', () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]))
  writeFiles(dir, { 'big.txt': 'x'.repeat(4096), 'node_modules/dep/index.js': 'ghp_' + 'Q'.repeat(36) })
  const result = scanForSecrets(dir, {
    files: ['bin.dat', 'big.txt', 'node_modules/dep/index.js'],
    maxBytes: 1024,
  })
  assert.equal(result.skipped.binary, 1)
  assert.equal(result.skipped.oversized, 1)
  assert.equal(result.skipped.ignored, 1)
  assert.equal(result.filesScanned, 0)
  assert.equal(result.clean, true)
})

test('gitFacts：不是仓库时明确返回 isRepo=false', () => {
  const facts = gitFacts('/nowhere', gitExec({ notRepo: true }))
  assert.equal(facts.isRepo, false)
  assert.match(facts.error, /not a git repository/)
})

test('gitFacts：解析分支、提交、远端一致性与脏工作区', () => {
  const exec = gitExec({
    branch: 'main',
    head: 'b'.repeat(40),
    remoteRef: 'b'.repeat(40),
    porcelain: ' M src/a.js\n?? new.txt\n',
    tagsAtHead: 'v0.1.0',
    ahead: '2',
  })
  const facts = gitFacts('/repo', exec)
  assert.equal(facts.isRepo, true)
  assert.equal(facts.branch, 'main')
  assert.equal(facts.headShort, 'bbbbbbb')
  assert.equal(facts.remoteMatchesHead, true)
  assert.equal(facts.ahead, 2)
  assert.equal(facts.clean, false)
  assert.deepEqual(facts.dirty, ['src/a.js', 'new.txt'])
  assert.deepEqual(facts.untracked, ['new.txt'])
  assert.deepEqual(facts.tagsAtHead, ['v0.1.0'])
})

test('gitFacts：远端不一致 + 读不到上游时 ahead 为 null', () => {
  const exec = gitExec({ remoteRef: 'c'.repeat(40), ahead: null })
  const facts = gitFacts('/repo', exec)
  assert.equal(facts.remoteMatchesHead, false)
  assert.equal(facts.ahead, null)
  assert.equal(facts.clean, true)
})

test('loadConfig：没有文件时 source=none，项目名取目录名', () => {
  const dir = makeDir('receipt-cfg-')
  const info = loadConfig(dir)
  assert.equal(info.source, 'none')
  assert.equal(info.config.tests.length, 0)
  assert.equal(info.config.runCommands, true)
  assert.ok(info.config.project.length > 0)
})

test('loadConfig：读文件、把字符串与对象两种写法归一，并标注无效项', () => {
  const dir = writeFiles(makeDir('receipt-cfg-'), {
    'delivery-receipt.json': JSON.stringify({
      project: 'demo',
      tests: ['node --test', { name: '构建', command: 'node scripts/build.mjs' }, { nope: 1 }],
      artifacts: ['docs/*.png', 42],
      claims: [{ label: '已发布', value: 'npm' }, '一句话自述', 7],
      scan: { ignore: ['docs/demo.html'] },
    }),
  })
  const info = loadConfig(dir)
  assert.equal(info.source, 'file')
  assert.equal(info.config.project, 'demo')
  assert.equal(info.config.tests.length, 2)
  assert.deepEqual(info.config.tests[1], { name: '构建', command: 'node scripts/build.mjs' })
  assert.deepEqual(info.config.artifacts, ['docs/*.png'])
  assert.equal(info.config.claims.length, 2)
  assert.equal(info.config.claims[1].label, '一句话自述')
  assert.deepEqual(info.config.scan.ignore, ['docs/demo.html'])
  assert.equal(info.notes.some((n) => n.includes('tests')), true)
  assert.equal(info.notes.some((n) => n.includes('claims')), true)
})

test('loadConfig：JSON 坏了要报错，而不是假装没有配置', () => {
  const dir = writeFiles(makeDir('receipt-cfg-'), { 'delivery-receipt.json': '{ 坏掉的 json' })
  const info = loadConfig(dir)
  assert.equal(info.source, 'error')
  assert.equal(info.notes.length, 1)
  assert.match(info.notes[0], /读取 delivery-receipt\.json 失败/)
})

test('normalizeConfig：cwd 缺省为当前目录，runCommands 默认执行', () => {
  const cfg = normalizeConfig({}, '/tmp/x')
  assert.equal(cfg.cwd, '/tmp/x')
  assert.equal(cfg.runCommands, true)
  assert.equal(normalizeConfig({ runCommands: false }, '/tmp/x').runCommands, false)
})
