// 测试辅助：假 git、假命令执行器、假 Cordis ctx。
//
// 全部测试都不碰真实 git 仓库状态、不真的执行用户命令 —— 除了两处刻意的例外：
// 交付物与密钥扫描会在 mkdtemp 出来的临时目录里读写真实文件（那正是要测的部分）。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), (prefix || 'receipt-test-') ))
}

export function writeFiles(root, files) {
  for (const rel of Object.keys(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, files[rel])
  }
  return root
}

// 假的 child_process.execFileSync 替身：按 git 子命令返回预置 stdout。
export function gitExec(overrides) {
  const cfg = Object.assign({
    root: '/repo',
    branch: 'main',
    head: 'a'.repeat(40),
    subject: 'test commit',
    remoteUrl: 'git@github.com:example/repo.git',
    porcelain: '',
    tagsAtHead: '',
    allTags: '',
    remoteRef: 'a'.repeat(40),
    ahead: '0',
    tracked: 'a.js\nb.js',
    notRepo: false,
  }, overrides || {})

  const calls = []
  const exec = function (file, args) {
    const key = args.join(' ')
    calls.push(key)
    const reply = function (status, stdout) {
      return { status: status, stdout: stdout, stderr: status === 0 ? '' : 'fatal: not a git repository', error: '' }
    }
    if (key === 'rev-parse --show-toplevel') return cfg.notRepo ? reply(128, '') : reply(0, cfg.root)
    if (cfg.notRepo) return reply(128, '')
    if (key === 'rev-parse --abbrev-ref HEAD') return reply(0, cfg.branch)
    if (key === 'rev-parse HEAD') return reply(0, cfg.head)
    if (key === 'log -1 --pretty=%s') return reply(0, cfg.subject)
    if (key === 'config --get remote.origin.url') return reply(cfg.remoteUrl ? 0 : 1, cfg.remoteUrl)
    if (key === 'status --porcelain') return reply(0, cfg.porcelain)
    if (key === 'tag --points-at HEAD') return reply(0, cfg.tagsAtHead)
    if (key === 'tag --list') return reply(0, cfg.allTags)
    if (key === 'rev-parse refs/remotes/origin/' + cfg.branch) return reply(cfg.remoteRef ? 0 : 1, cfg.remoteRef)
    if (key === 'rev-list --count origin/' + cfg.branch + '..HEAD') return reply(cfg.ahead === null ? 1 : 0, cfg.ahead === null ? '' : cfg.ahead)
    if (key === 'ls-files') return reply(0, cfg.tracked)
    return reply(1, '')
  }
  exec.calls = calls
  return exec
}

// 假的命令执行器：记录每一次调用，返回预置结果 —— 用来证明"命令只来自配置"。
export function recordingRunner(results) {
  const calls = []
  const runner = function (spec) {
    calls.push(spec.command)
    const canned = (results || {})[spec.command]
    return Object.assign({
      command: spec.command,
      ran: true,
      exitCode: 0,
      timedOut: false,
      stdout: '# tests 3\n# pass 3\n# fail 0\n',
      stderr: '',
      ms: 12,
      error: '',
    }, canned || {})
  }
  runner.calls = calls
  return runner
}

// 假的 Cordis ctx：只提供 apply() 真正用到的东西，并像 Cordis 一样回收 disposer。
export function stubCtx(options) {
  const settings = options || {}
  const routes = []
  const disposers = []

  const webServer = {
    register(route) {
      if (settings.registerThrows === true) throw new Error('webServer.register 不可用')
      routes.push(route)
      if (settings.registerReturnsUndefined === true) return undefined
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const ctx = {
    webServer: webServer,
    get(name) { return name === 'webServer' ? webServer : undefined },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }

  return {
    ctx: ctx,
    routes: routes,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
  }
}

// 直接驱动路由 handler，不经过 HTTP：够用来钉住方法/状态码/载荷契约。
export function callRoute(route, method, url, body) {
  const req = {
    method: method,
    url: url,
    on(event, listener) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(JSON.stringify(body)))
      if (event === 'end') listener()
      return req
    },
  }
  return new Promise(function (resolve) {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(payload) {
        resolve({ status: this.statusCode, headers: this.headers, body: String(payload === undefined ? '' : payload) })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(function (error) {
      resolve({ status: 500, headers: {}, body: String(error && error.message) })
    })
  })
}
