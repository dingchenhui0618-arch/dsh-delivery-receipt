// 采集层（evidence）：只负责"把事实拿到手"，不做任何分区判断、不写任何结论。
//
// 设计上刻意分成两半：
//   evidence.js 拿到的东西都带「原始证据」（命令退出码、文件哈希、git 引用），
//   zones.js 再按证据的**可复现性**决定一条声明该落在哪个区。
// 这样"三区"不是文案技巧，而是可被测试钉死的判定规则。
//
// 这一层不联网：远端状态读的是本地 remote-tracking ref（refs/remotes/origin/*），
// 并在回执里显式标注为「本地记录的远端状态」，避免把离线读到的缓存说成实时事实。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

const MAX_SCAN_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT = 4000

// ---------------------------------------------------------------------------
// 密钥扫描规则
//
// 命中记录里**只有文件名、行号和规则名**，绝不包含匹配到的文本、长度或摘要 ——
// 这是"可公开的页面"这个前提的硬要求，不是谨慎：回执页会被贴到聊天、PR、截图里。
// 内容里出现 {SECRET} 时会被替换成 <已隐去>（见 redactText），双保险。
// ---------------------------------------------------------------------------

export const SECRET_RULES = [
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'github-pat', label: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'npm-token', label: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { id: 'openai-style-key', label: 'sk- 前缀的 API key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'private-key-block', label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'bearer-header', label: '内联 Bearer 凭据', re: /Authorization:\s*Bearer\s+\S{20,}/i },
  {
    id: 'assigned-secret',
    label: '赋值形式的口令/密钥',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
]

// 文件级规则：真正的凭据文件出现在版本库里本身就是命中（内容再看不出问题也一样）。
export const SENSITIVE_FILENAMES = [
  { id: 'dotenv-file', label: '被跟踪的 .env', re: /(^|\/)\.env(\.[^/]*)?$/ },
  { id: 'private-key-file', label: '私钥文件', re: /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx))$/i },
  { id: 'credentials-file', label: '凭据文件', re: /(^|\/)(credentials|credentials\.json|\.credentials\.ya?ml|auth\.json)$/i },
  { id: 'npmrc-file', label: '带认证的 .npmrc', re: /(^|\/)\.npmrc$/ },
]

const SCAN_SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/', 'coverage/', '.ship-receipt/']

export function defaultExec(file, args, options) {
  const out = spawnSync(file, args, {
    cwd: options && options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: (options && options.timeoutMs) || 20000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return {
    status: out.status === null ? -1 : out.status,
    stdout: out.stdout || '',
    stderr: out.stderr || '',
    error: out.error ? String(out.error.code || out.error.message) : '',
  }
}

export function tail(text, max) {
  const limit = typeof max === 'number' ? max : MAX_OUTPUT
  const s = String(text === undefined || text === null ? '' : text)
  return s.length > limit ? s.slice(0, limit) + '\n…（输出已截断，共 ' + s.length + ' 字符）' : s
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// 只认 PNG / JPEG / GIF / WebP 四种（回执页里会写尺寸的也就这些），零依赖手解文件头。
export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue }
      const marker = buf[off + 1]
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue }
      const len = buf.readUInt16BE(off + 2)
      if (len < 2) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
      }
      off += 2 + len
    }
    return { format: 'jpeg', width: null, height: null }
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16)
    if (fourcc === 'VP8X') {
      return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    }
    if (fourcc === 'VP8 ') {
      return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (fourcc === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

// 把任何看起来像凭据的片段隐去；用于所有进入回执页的自由文本（配置里的声明、命令输出）。
export function redactText(text) {
  let out = String(text === undefined || text === null ? '' : text)
  for (const rule of SECRET_RULES) {
    out = out.replace(new RegExp(rule.re.source, rule.re.flags.includes('i') ? 'gi' : 'g'), '<已隐去:' + rule.id + '>')
  }
  return out
}

// 家目录 → ~；两种分隔符都归一成 POSIX，避免回执页里出现用户名或盘符。
export function sanitizePath(value, home) {
  const base = typeof home === 'string' && home.length > 0 ? home : homedir()
  if (typeof value !== 'string' || value.length === 0) return value
  let out = value.split(sep).join('/')
  const homePosix = base.split(sep).join('/')
  if (out === homePosix) return '~'
  if (out.startsWith(homePosix + '/')) out = '~' + out.slice(homePosix.length)
  out = out.replace(/[A-Za-z]:\/Users\/[^/]+/g, '~').replace(/\/home\/[^/]+/g, '~').replace(/\/Users\/[^/]+/g, '~')
  return out
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitRead(exec, cwd, args) {
  const out = exec('git', args, { cwd, timeoutMs: 20000 })
  return { ok: out.status === 0, value: String(out.stdout || '').trim(), stderr: String(out.stderr || '').trim() }
}

export function gitFacts(cwd, exec) {
  const run = typeof exec === 'function' ? exec : defaultExec
  const root = gitRead(run, cwd, ['rev-parse', '--show-toplevel'])
  if (!root.ok || root.value.length === 0) {
    return { isRepo: false, error: root.stderr || '不是一个 git 仓库' }
  }
  const branch = gitRead(run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const headSha = gitRead(run, cwd, ['rev-parse', 'HEAD'])
  const subject = gitRead(run, cwd, ['log', '-1', '--pretty=%s'])
  const remoteUrl = gitRead(run, cwd, ['config', '--get', 'remote.origin.url'])
  // porcelain 每行是 "XY 路径"：**首行的前导空格有意义**，所以这里不走 gitRead
  // 的 trim，直接读原始 stdout，否则第一行会被切掉一个字符。
  const porcelainRaw = run('git', ['status', '--porcelain'], { cwd: cwd, timeoutMs: 20000 })
  const tagsRaw = gitRead(run, cwd, ['tag', '--points-at', 'HEAD'])
  const allTags = gitRead(run, cwd, ['tag', '--list'])
  const name = branch.ok ? branch.value : ''
  const remoteRef = name ? gitRead(run, cwd, ['rev-parse', 'refs/remotes/origin/' + name]) : { ok: false, value: '' }
  const aheadRaw = name && remoteRef.ok
    ? gitRead(run, cwd, ['rev-list', '--count', 'origin/' + name + '..HEAD'])
    : { ok: false, value: '' }

  const lines = String(porcelainRaw.stdout || '').replace(/\r/g, '').split('\n').filter((l) => l.length > 0)
  const dirty = lines.map((l) => l.slice(3).trim()).filter((l) => l.length > 0)
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim())

  return {
    isRepo: true,
    root: root.value,
    branch: name,
    detached: name === 'HEAD',
    headSha: headSha.ok ? headSha.value : '',
    headShort: headSha.ok ? headSha.value.slice(0, 7) : '',
    subject: subject.ok ? subject.value : '',
    remoteUrl: remoteUrl.ok ? remoteUrl.value : '',
    remoteRef: remoteRef.ok ? remoteRef.value : '',
    remoteRefName: name ? 'origin/' + name : '',
    // 本地记录的远端状态（不联网），所以措辞与分区判断都按"本地记录"来。
    remoteMatchesHead: remoteRef.ok && headSha.ok && remoteRef.value === headSha.value,
    ahead: aheadRaw.ok ? Number(aheadRaw.value) : null,
    dirty: dirty,
    untracked: untracked,
    clean: dirty.length === 0,
    tagsAtHead: tagsRaw.ok && tagsRaw.value.length > 0 ? tagsRaw.value.split('\n') : [],
    tags: allTags.ok && allTags.value.length > 0 ? allTags.value.split('\n') : [],
  }
}

export function trackedFiles(cwd, exec) {
  const run = typeof exec === 'function' ? exec : defaultExec
  const out = run('git', ['ls-files'], { cwd, timeoutMs: 20000 })
  if (out.status !== 0) return { ok: false, files: [], error: String(out.stderr || '').trim() }
  const files = String(out.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  return { ok: true, files: files }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export function runCommand(command, options) {
  const opts = options || {}
  const run = typeof opts.runner === 'function' ? opts.runner : defaultRunner
  return run({ command: command, cwd: opts.cwd, timeoutMs: opts.timeoutMs || 300000 })
}

// 默认执行器：整条命令交给 shell，因为配置里写的本来就该是一个完整命令行。
// 安全性来自**命令只能来自配置文件或插件配置**，永远不能来自 HTTP 请求（见 host.js）。
export function defaultRunner(spec) {
  const started = Date.now()
  const out = spawnSync(spec.command, {
    cwd: spec.cwd,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: spec.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    command: spec.command,
    ran: true,
    exitCode: out.status === null ? -1 : out.status,
    timedOut: Boolean(out.error && out.error.code === 'ETIMEDOUT'),
    stdout: tail(out.stdout || ''),
    stderr: tail(out.stderr || ''),
    ms: Date.now() - started,
    error: out.error ? String(out.error.code || out.error.message) : '',
  }
}

// 从常见测试输出里数通过/失败条数。数不到就返回 null —— 宁可空着，也不猜。
export function parseTestCounts(text) {
  const s = String(text || '')
  const counts = { pass: null, fail: null, total: null }
  const tap = s.match(/^#\s*pass\s+(\d+)/m)
  const tapFail = s.match(/^#\s*fail\s+(\d+)/m)
  const tapTests = s.match(/^#\s*tests\s+(\d+)/m)
  const jest = s.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/)
  if (tap) counts.pass = Number(tap[1])
  if (tapFail) counts.fail = Number(tapFail[1])
  if (tapTests) counts.total = Number(tapTests[1])
  else if (counts.pass !== null) counts.total = counts.pass + (counts.fail || 0)
  if (counts.pass === null && jest) {
    counts.fail = jest[1] ? Number(jest[1]) : 0
    counts.pass = jest[2] ? Number(jest[2]) : null
    counts.total = Number(jest[3])
  }
  return counts.pass === null && counts.fail === null && counts.total === null ? null : counts
}

// ---------------------------------------------------------------------------
// 交付物（截图等）
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 支持精确路径与「目录/*.png」这一种通配（够用，且不需要引入 glob 依赖）。
export function expandPattern(cwd, pattern) {
  const posix = String(pattern || '').split(sep).join('/')
  if (!posix.includes('*')) {
    const abs = join(cwd, posix)
    return existsSync(abs) && statSync(abs).isFile() ? [posix] : []
  }
  const dir = posix.slice(0, posix.lastIndexOf('/'))
  const namePattern = posix.slice(posix.lastIndexOf('/') + 1)
  const absDir = join(cwd, dir)
  if (!existsSync(absDir)) return []
  const re = new RegExp('^' + escapeRegExp(namePattern).replace(/\\\*/g, '[^/]*') + '$')
  let names = []
  try {
    names = readdirSync(absDir)
  } catch (error) {
    return []
  }
  return names.filter((n) => re.test(n)).map((n) => (dir.length > 0 ? dir + '/' + n : n)).sort()
}

export function artifactFacts(cwd, patterns, options) {
  const opts = options || {}
  const tracked = opts.tracked instanceof Set ? opts.tracked : new Set(Array.isArray(opts.tracked) ? opts.tracked : [])
  const out = []
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const matches = expandPattern(cwd, pattern)
    if (matches.length === 0) {
      out.push({ pattern: String(pattern), path: null, matched: false })
      continue
    }
    for (const rel of matches) {
      const abs = join(cwd, rel)
      let bytes = null
      let buf = null
      try {
        bytes = statSync(abs).size
        buf = readFileSync(abs)
      } catch (error) {
        out.push({ pattern: String(pattern), path: rel, matched: true, error: String((error && error.message) || error) })
        continue
      }
      const size = imageSize(buf)
      out.push({
        pattern: String(pattern),
        path: rel,
        matched: true,
        bytes: bytes,
        sha256: sha256(buf),
        image: size,
        tracked: tracked.has(rel),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 密钥扫描
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOW_MARKER = 'delivery-receipt:allow'

export function scanForSecrets(cwd, options) {
  const opts = options || {}
  const files = Array.isArray(opts.files) ? opts.files : []
  const ignore = Array.isArray(opts.ignore) ? opts.ignore : []
  const maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : MAX_SCAN_BYTES
  const allowMarker = typeof opts.allowMarker === 'string' && opts.allowMarker.length > 0
    ? opts.allowMarker
    : DEFAULT_ALLOW_MARKER
  const skip = SCAN_SKIP_DIRS.concat(ignore)
  const skipped = { ignored: 0, binary: 0, oversized: 0, unreadable: 0, allowlisted: 0 }
  const hits = []
  let scanned = 0

  for (const rel of files) {
    const posix = rel.split(sep).join('/')
    if (skip.some((prefix) => posix === prefix.replace(/\/$/, '') || posix.startsWith(prefix))) {
      skipped.ignored += 1
      continue
    }
    for (const rule of SENSITIVE_FILENAMES) {
      if (rule.re.test(posix)) hits.push({ file: posix, line: 0, rule: rule.id, label: rule.label, severity: 'high' })
    }
    const abs = join(cwd, rel)
    let buf
    try {
      const info = statSync(abs)
      if (!info.isFile()) { skipped.unreadable += 1; continue }
      if (info.size > maxBytes) { skipped.oversized += 1; continue }
      buf = readFileSync(abs)
    } catch (error) {
      skipped.unreadable += 1
      continue
    }
    if (looksBinary(buf)) { skipped.binary += 1; continue }
    scanned += 1
    const text = buf.toString('utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const matched = SECRET_RULES.filter((rule) => rule.re.test(lines[i]))
      if (matched.length === 0) continue
      // 逐行豁免：测试夹具、文档示例这类"像凭据但不是凭据"的行，在行内写上标记即可豁免。
      // 只有**本来会命中**的行才计入 allowlisted —— 所以回执里"按标记豁免 N 行"读起来
      // 就是"N 行本该报警、被显式放过了"，而不是"文件里出现过这个字符串"。
      if (lines[i].includes(allowMarker)) {
        skipped.allowlisted += 1
        continue
      }
      for (const rule of matched) {
        // 只记规则名与行号：连匹配长度都不写，避免旁路泄漏。
        hits.push({ file: posix, line: i + 1, rule: rule.id, label: rule.label, severity: 'high' })
      }
    }
  }

  return {
    filesConsidered: files.length,
    filesScanned: scanned,
    skipped: skipped,
    hits: hits,
    clean: hits.length === 0,
    rules: SECRET_RULES.map((r) => r.id).concat(SENSITIVE_FILENAMES.map((r) => r.id)),
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const CONFIG_FILENAME = 'delivery-receipt.json'

export function loadConfig(cwd, override) {
  const fromObject = override && typeof override === 'object' && Object.keys(override).length > 0
  const path = join(cwd, CONFIG_FILENAME)
  if (!fromObject && !existsSync(path)) {
    return { config: normalizeConfig({}, cwd), source: 'none', path: path, notes: [] }
  }
  if (fromObject) {
    const notes = []
    const normalized = normalizeConfig(override, cwd, notes)
    return { config: normalized, source: 'inline', path: path, notes: notes }
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      config: normalizeConfig({}, cwd),
      source: 'error',
      path: path,
      notes: ['读取 ' + CONFIG_FILENAME + ' 失败：' + String((error && error.message) || error)],
    }
  }
  const notes = []
  const normalized = normalizeConfig(raw, cwd, notes)
  return { config: normalized, source: 'file', path: path, notes: notes }
}

function normalizeSteps(list, notes, kind) {
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      out.push({ name: entry.trim(), command: entry.trim() })
      continue
    }
    if (entry && typeof entry === 'object' && typeof entry.command === 'string' && entry.command.trim().length > 0) {
      out.push({
        name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : entry.command.trim(),
        command: entry.command.trim(),
      })
      continue
    }
    if (notes) notes.push(kind + ' 里有一条无效项，已忽略（需要字符串或 {name, command}）')
  }
  return out
}

export function normalizeConfig(raw, cwd, notes) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const claims = []
  for (const entry of Array.isArray(src.claims) ? src.claims : []) {
    if (entry && typeof entry === 'object' && typeof entry.label === 'string') {
      claims.push({
        label: entry.label,
        value: typeof entry.value === 'string' ? entry.value : '',
        section: typeof entry.section === 'string' ? entry.section : 'author-claims',
      })
      continue
    }
    if (typeof entry === 'string' && entry.trim().length > 0) {
      claims.push({ label: entry.trim(), value: '', section: 'author-claims' })
      continue
    }
    if (notes) notes.push('claims 里有一条无效项，已忽略')
  }
  const scan = src.scan && typeof src.scan === 'object' ? src.scan : {}
  return {
    project: typeof src.project === 'string' && src.project.trim().length > 0
      ? src.project.trim()
      : basename(cwd),
    cwd: typeof src.cwd === 'string' && src.cwd.trim().length > 0 ? src.cwd.trim() : cwd,
    tests: normalizeSteps(src.tests, notes, 'tests'),
    builds: normalizeSteps(src.builds, notes, 'builds'),
    artifacts: (Array.isArray(src.artifacts) ? src.artifacts : []).filter((p) => typeof p === 'string' && p.trim().length > 0),
    scan: {
      enabled: scan.enabled !== false,
      ignore: (Array.isArray(scan.ignore) ? scan.ignore : []).filter((p) => typeof p === 'string' && p.trim().length > 0),
      maxBytes: typeof scan.maxBytes === 'number' && scan.maxBytes > 0 ? scan.maxBytes : MAX_SCAN_BYTES,
      allowMarker: typeof scan.allowMarker === 'string' && scan.allowMarker.length > 0
        ? scan.allowMarker
        : DEFAULT_ALLOW_MARKER,
    },
    claims: claims,
    notes: (Array.isArray(src.notes) ? src.notes : []).filter((n) => typeof n === 'string' && n.trim().length > 0),
    // 配置里声明的命令**默认会执行**（生成回执时就该拿到这次的真实结果）；
    // 只想收集、不想执行就显式写 runCommands:false。
    runCommands: src.runCommands !== false,
  }
}
