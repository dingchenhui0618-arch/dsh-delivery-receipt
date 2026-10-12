// Host half of dsh-delivery-receipt.
//
// 安全边界写在这里，因为它决定了整个插件的攻击面：
//   * **要执行的命令只能来自配置文件**（`delivery-receipt.json` 或插件配置里的
//     receiptConfig），永远不能来自 HTTP 请求。任何页面都无法让这个插件跑一条命令。
//   * **能采集的目录只能来自插件配置**：cwd 与 roots 白名单。请求里带的 cwd 只在
//     白名单内被接受，其余一律 403。
//   * 不联网：远端状态读本地的 remote-tracking ref，并在回执里标注为「本地记录」。
//
// 与同骨架的插件一样，HTTP 路由是「可丢弃的那一半」：注册失败只丢面板，不伤宿主。

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { collectProject } from './collect.js'
import { defaultExec, defaultRunner, loadConfig, sanitizePath } from './evidence.js'
import { buildReceipt, renderEmptyHtml, renderHtml, renderMarkdown, summarize } from './receipt.js'

export const name = 'dsh-delivery-receipt'
export const inject = ['webServer']

const ROUTE = '/dsh-delivery-receipt'
const MAX_BODY = 64 * 1024

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendText(res, status, type, body) {
  res.statusCode = status
  res.setHeader('content-type', type + '; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise(function (resolveBody) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > MAX_BODY) req.destroy()
    })
    req.on('end', function () {
      try {
        resolveBody(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolveBody({})
      }
    })
    req.on('error', function () {
      resolveBody({})
    })
  })
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const exec = typeof settings.exec === 'function' ? settings.exec : defaultExec
  const runner = typeof settings.runner === 'function' ? settings.runner : defaultRunner
  const home = typeof settings.home === 'string' && settings.home.length > 0 ? settings.home : homedir()
  const version = typeof settings.version === 'string' && settings.version.length > 0 ? settings.version : '0.1.0'
  const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : 300000
  const runCommandsEnabled = settings.runCommands !== false
  const configuredCwd = typeof settings.cwd === 'string' && settings.cwd.length > 0 ? resolve(settings.cwd) : process.cwd()
  const roots = (Array.isArray(settings.roots) ? settings.roots : [])
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => resolve(entry))
  const inlineConfig = settings.receiptConfig && typeof settings.receiptConfig === 'object' ? settings.receiptConfig : undefined

  const state = { last: null, generating: false, lastError: '', generatedCount: 0, lastCwd: '' }

  // 目录白名单：roots 为空时只允许配置里的那一个目录。
  function resolveTargetCwd(requested) {
    if (typeof requested !== 'string' || requested.trim().length === 0) {
      return { ok: true, cwd: projectCwd() }
    }
    const target = resolve(requested.trim())
    const allowed = [configuredCwd].concat(roots)
    const hit = allowed.some((entry) => entry.toLowerCase() === target.toLowerCase())
    if (!hit) {
      return { ok: false, error: '这个目录不在 roots 白名单里，已拒绝：' + sanitizePath(requested, home) }
    }
    return { ok: true, cwd: target }
  }

  // 配置里可以再指定一个 cwd；相对路径按配置目录解析。
  function projectCwd() {
    const info = loadConfig(configuredCwd, inlineConfig)
    const fromFile = info.config && typeof info.config.cwd === 'string' ? info.config.cwd : ''
    if (fromFile.length === 0) return configuredCwd
    return isAbsolute(fromFile) ? resolve(fromFile) : resolve(join(configuredCwd, fromFile))
  }

  function collect(cwd) {
    return collectProject(cwd, {
      exec: exec,
      runner: runner,
      runCommands: runCommandsEnabled,
      timeoutMs: timeoutMs,
      inlineConfig: inlineConfig,
    })
  }

  function generate(cwd) {
    const collected = collect(cwd)
    const receipt = buildReceipt({
      project: collected.cfg.project,
      cwd: cwd,
      version: version,
      home: home,
      generatedAt: new Date().toISOString(),
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
    state.last = receipt
    state.generatedCount += 1
    state.lastError = ''
    state.lastCwd = cwd
    return receipt
  }

  function configView() {
    const cwd = projectCwd()
    const info = loadConfig(configuredCwd, inlineConfig)
    return {
      cwd: sanitizePath(cwd, home),
      project: info.config.project,
      source: info.source,
      path: sanitizePath(info.path, home),
      roots: roots.map((entry) => sanitizePath(entry, home)),
      runCommands: runCommandsEnabled && info.config.runCommands !== false,
      tests: info.config.tests.map((step) => ({ name: step.name, command: step.command })),
      builds: info.config.builds.map((step) => ({ name: step.name, command: step.command })),
      artifacts: info.config.artifacts,
      claims: info.config.claims.map((claim) => claim.label),
      scanIgnore: info.config.scan.ignore,
      configNotes: info.notes,
    }
  }

  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async function (req, res) {
          const path = String(req.url || '').split('?')[0]
          const rest = path.slice(ROUTE.length).replace(/^\/+/, '').replace(/\/+$/, '')
          const method = String(req.method || 'GET').toUpperCase()
          try {
            if (rest === '' || rest === 'state') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
              return sendJson(res, 200, {
                ok: true,
                config: configView(),
                hasReceipt: state.last !== null,
                receipt: summarize(state.last),
                generating: state.generating,
                lastError: state.lastError,
                generatedCount: state.generatedCount,
                lastCwd: state.lastCwd ? sanitizePath(state.lastCwd, home) : '',
              })
            }
            if (rest === 'generate') {
              if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
              const body = await readBody(req)
              const target = resolveTargetCwd(body.cwd)
              if (!target.ok) return sendJson(res, 403, { error: target.error })
              if (state.generating) return sendJson(res, 409, { error: '上一次生成还没结束，请稍后重试' })
              state.generating = true
              try {
                return sendJson(res, 200, { ok: true, receipt: generate(target.cwd) })
              } catch (error) {
                state.lastError = String((error && error.message) || error)
                return sendJson(res, 500, { error: state.lastError })
              } finally {
                state.generating = false
              }
            }
            if (rest === 'receipt.html') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
              if (!state.last) {
                return sendText(res, 200, 'text/html', renderEmptyHtml(configView().project, '还没有生成过回执。'))
              }
              return sendText(res, 200, 'text/html', renderHtml(state.last))
            }
            if (rest === 'receipt.md') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
              if (!state.last) {
                return sendText(res, 200, 'text/markdown',
                  '# 交付回执\n\n_还没有生成过回执：三区此时都是空的，这里不会补任何一句话。_\n')
              }
              return sendText(res, 200, 'text/markdown', renderMarkdown(state.last))
            }
            if (rest === 'receipt.json') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
              if (!state.last) return sendJson(res, 404, { error: '还没有生成过回执' })
              return sendJson(res, 200, state.last)
            }
            return sendJson(res, 404, { error: 'unknown method' })
          } catch (error) {
            return sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      // 路由是这一半的全部产出：注册不上就没有面板，但宿主要照常跑。
      disposeRoute = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-delivery-receipt] 路由注册失败，面板不可用：', error)
      }
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}
