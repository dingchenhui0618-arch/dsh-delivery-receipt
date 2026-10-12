// 采集编排：把「一个目录 → 一份事实」这件事收在一处。
//
// 宿主半区和 CLI 都调用这里，避免出现"面板算出来的回执"和"命令行算出来的回执"
// 两份实现漂移 —— 那正好是这张回执要消灭的问题。

import {
  CONFIG_FILENAME,
  artifactFacts,
  defaultExec,
  defaultRunner,
  gitFacts,
  loadConfig,
  parseTestCounts,
  runCommand,
  scanForSecrets,
  trackedFiles,
} from './evidence.js'

// 只留结论，不留整段输出；失败时给最后几行（脱敏统一在 buildReceipt 里做）。
export function tailLines(text, lines) {
  const all = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const joined = all.slice(-(lines || 4)).join('\n')
  return joined.length > 600 ? joined.slice(0, 600) + ' …' : joined
}

export function runSteps(steps, options) {
  const opts = options || {}
  const out = []
  for (const step of steps) {
    const result = runCommand(step.command, {
      cwd: opts.cwd,
      runner: opts.runner,
      timeoutMs: opts.timeoutMs,
    })
    out.push({
      name: step.name,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      ms: result.ms,
      counts: parseTestCounts(String(result.stdout || '') + '\n' + String(result.stderr || '')),
      summary: result.exitCode === 0 ? '' : tailLines(result.stderr || result.stdout, 4),
    })
  }
  return out
}

// 一次采集的全部事实。任何一步失败都不抛：缺什么就在回执里留空/标未验证。
export function collectProject(cwd, options) {
  const opts = options || {}
  const exec = typeof opts.exec === 'function' ? opts.exec : defaultExec
  const runner = typeof opts.runner === 'function' ? opts.runner : defaultRunner
  const info = loadConfig(cwd, opts.inlineConfig)
  const cfg = info.config
  const notes = info.notes.slice().concat(cfg.notes)
  if (info.source === 'none') {
    notes.push('没有找到 ' + CONFIG_FILENAME + '：只采集了 git 与密钥扫描；测试、构建、交付物需要在配置里声明。')
  }

  const tracked = trackedFiles(cwd, exec)
  if (!tracked.ok) notes.push('读不到版本库文件清单（git ls-files）：' + (tracked.error || '未知原因'))

  const artifacts = artifactFacts(cwd, cfg.artifacts, { tracked: tracked.files })
  const scan = cfg.scan.enabled
    ? Object.assign(scanForSecrets(cwd, {
      files: tracked.files,
      ignore: cfg.scan.ignore,
      maxBytes: cfg.scan.maxBytes,
    }), { enabled: true })
    : { enabled: false }

  const declared = cfg.tests.length + cfg.builds.length
  const shouldRun = opts.runCommands !== false && cfg.runCommands !== false
  if (!shouldRun && declared > 0) {
    notes.push('配置里声明了 ' + declared + ' 条命令，但本次按设置没有执行（runCommands:false）。')
  }

  return {
    cfg: cfg,
    info: info,
    notes: notes,
    git: gitFacts(cwd, exec),
    artifacts: artifacts,
    scan: scan,
    testResults: shouldRun ? runSteps(cfg.tests, { cwd: cwd, runner: runner, timeoutMs: opts.timeoutMs }) : [],
    buildResults: shouldRun ? runSteps(cfg.builds, { cwd: cwd, runner: runner, timeoutMs: opts.timeoutMs }) : [],
  }
}
