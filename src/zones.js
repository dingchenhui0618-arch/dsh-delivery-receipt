// 判定层（zones）：一条声明落在哪个区，只看它的**证据**，不看它写在哪个板块、
// 也不看措辞好不好听。这是这个插件的全部主张，所以规则写得尽量死：
//
//   已验证 verified   —— 证据来自本次采集，且能在别处复现：
//                        命令确实跑了（退出码就是事实）、文件哈希且文件已入版本库、
//                        扫描确实扫到了文件、git 引用在本地记录的远端里。
//   仅本地 localOnly  —— 事实只在本机成立：工作区有未提交改动、有未推送提交、
//                        交付物未被 git 跟踪（别人拿到仓库看不到这个哈希）。
//   未验证 unverified —— 没有证据，或证据不足：命令没运行/超时、声明的文件不存在、
//                        扫描 0 个文件、以及**人写的任何一句话**。
//
// 注意「已验证」不等于「是好消息」：测试失败、密钥扫描命中都是**有证据的事实**，
// 它们同样进已验证区，只是带 bad 色调。三区分的是证据强度，不是成败。

export const ZONES = ['verified', 'localOnly', 'unverified']

export const ZONE_LABEL = {
  verified: '已验证',
  localOnly: '仅本地',
  unverified: '未验证',
}

export const ZONE_HINT = {
  verified: '有可复现证据：命令跑了、文件哈希对得上且已入仓、扫描确实扫到了东西。',
  localOnly: '只在这台机器上成立：未提交、未推送、文件没入仓。别人拿到仓库复现不出来。',
  unverified: '没有证据，或证据不足。这里只有"被声称"，没有"被验证"。',
}

// 分区为空时页面显示什么。三类空各有各的说法——空就是空，不补话。
export const ZONE_EMPTY = {
  verified: '没有任何一条声明带上了可复现证据。',
  localOnly: '没有只在本机成立的事实。',
  unverified: '没有被声称却缺少证据的东西。',
}

export function classifyClaim(claim) {
  const ev = claim && claim.evidence
  if (!ev || typeof ev.kind !== 'string') return 'unverified'
  switch (ev.kind) {
    case 'git':
      if (ev.resolved !== true) return 'unverified'
      return ev.local === true ? 'localOnly' : 'verified'
    case 'command':
      if (ev.ran !== true) return 'unverified'
      if (ev.timedOut === true) return 'unverified'
      return 'verified'
    case 'file':
      if (ev.matched === false || ev.matched === undefined) return 'unverified'
      if (typeof ev.sha256 !== 'string' || ev.sha256.length === 0) return 'unverified'
      return ev.tracked === true ? 'verified' : 'localOnly'
    case 'scan':
      if (typeof ev.filesScanned !== 'number' || ev.filesScanned <= 0) return 'unverified'
      return 'verified'
    case 'declaration':
      return 'unverified'
    default:
      return 'unverified'
  }
}

export function withZone(claim) {
  return Object.assign({}, claim, { zone: classifyClaim(claim) })
}

export function groupClaims(claims) {
  const groups = { verified: [], localOnly: [], unverified: [] }
  for (const claim of Array.isArray(claims) ? claims : []) {
    const zoned = withZone(claim)
    groups[zoned.zone].push(zoned)
  }
  return groups
}

// ---------------------------------------------------------------------------
// 声明工厂：把采集到的证据变成"声明 + 证据"，不在这里下结论。
// ---------------------------------------------------------------------------

let seq = 0
function nextId(prefix) {
  seq += 1
  return prefix + '-' + seq
}

export function resetIds() {
  seq = 0
}

export function gitClaims(git) {
  if (!git || git.isRepo !== false) {
    // 正常路径
  }
  if (!git || git.isRepo !== true) {
    return [{
      id: nextId('git'),
      section: 'git',
      label: '仓库状态',
      value: '不是一个 git 仓库（' + String((git && git.error) || '未知原因') + '）',
      tone: 'muted',
      // 这是"在这台机器上跑 git 得到的结论"，换台机器可能就不是 —— 归仅本地。
      evidence: { kind: 'git', ref: 'rev-parse --show-toplevel', resolved: true, local: true },
    }]
  }
  const out = []
  out.push({
    id: nextId('git'),
    section: 'git',
    label: 'HEAD 提交',
    value: git.headShort + ' ' + git.subject,
    tone: git.remoteMatchesHead ? 'ok' : 'warn',
    evidence: { kind: 'git', ref: 'HEAD', resolved: git.headSha.length > 0, local: !git.remoteMatchesHead },
  })
  out.push({
    id: nextId('git'),
    section: 'git',
    label: '分支',
    value: git.detached ? '（分离头指针 HEAD）' : git.branch,
    tone: 'muted',
    evidence: { kind: 'git', ref: 'HEAD', resolved: git.branch.length > 0, local: git.remoteMatchesHead !== true },
  })
  out.push({
    id: nextId('git'),
    section: 'git',
    label: '远端（本地记录）',
    value: git.remoteRefName
      ? git.remoteRefName + ' = ' + (git.remoteRef ? git.remoteRef.slice(0, 7) : '（读不到）')
      : '没有配置远端跟踪分支',
    tone: git.remoteMatchesHead ? 'ok' : 'warn',
    evidence: { kind: 'git', ref: git.remoteRefName || 'origin', resolved: git.remoteRef.length > 0, local: false },
  })
  out.push({
    id: nextId('git'),
    section: 'git',
    label: '未推送提交',
    value: git.ahead === null ? '无法判断（没有上游分支）' : git.ahead + ' 个',
    tone: git.ahead === 0 ? 'ok' : 'warn',
    evidence: { kind: 'git', ref: 'origin..HEAD', resolved: git.ahead !== null, local: git.ahead === null ? true : git.ahead > 0 },
  })
  out.push({
    id: nextId('git'),
    section: 'git',
    label: '未提交改动',
    value: git.clean
      ? '工作区干净'
      : git.dirty.length + ' 个文件' + (git.untracked.length > 0 ? '（其中 ' + git.untracked.length + ' 个未跟踪）' : ''),
    tone: git.clean ? 'ok' : 'warn',
    // 工作区脏这件事**天生只能在本机成立**：它是"尚未进入版本库"的定义。
    evidence: { kind: 'git', ref: 'worktree', resolved: true, local: !git.clean },
  })
  // 没有标签时**不发这条声明**：一个空标签列表不是交付声明，塞进分区只是噪音。
  if (git.tagsAtHead.length > 0) {
    out.push({
      id: nextId('git'),
      section: 'git',
      label: 'HEAD 上的标签',
      value: git.tagsAtHead.join('、'),
      tone: 'ok',
      // 标签是否已推到远端，离线读不到 —— 所以只声称"本地仓库里 HEAD 带这个标签"。
      evidence: { kind: 'git', ref: 'tag', resolved: true, local: true },
    })
  }
  if (git.remoteUrl) {
    out.push({
      id: nextId('git'),
      section: 'git',
      label: '远端地址',
      value: git.remoteUrl,
      tone: 'muted',
      evidence: { kind: 'git', ref: 'remote.origin.url', resolved: true, local: false },
    })
  }
  return out
}

export function commandClaims(section, steps, results) {
  const out = []
  const list = Array.isArray(steps) ? steps : []
  const byName = new Map()
  for (const result of Array.isArray(results) ? results : []) byName.set(result.name, result)
  if (list.length === 0) return out
  for (const step of list) {
    const result = byName.get(step.name)
    if (!result) {
      out.push({
        id: nextId(section),
        section: section,
        label: step.name,
        value: '配置里声明了这条命令，本次没有运行',
        tone: 'warn',
        evidence: { kind: 'command', ran: false, command: step.command },
      })
      continue
    }
    const counts = result.counts || null
    const parts = []
    parts.push('exit ' + result.exitCode)
    if (counts && counts.pass !== null) parts.push('通过 ' + counts.pass)
    if (counts && counts.fail !== null) parts.push('失败 ' + counts.fail)
    if (counts && counts.total !== null) parts.push('共 ' + counts.total)
    parts.push(Math.round(result.ms) + ' ms')
    if (result.timedOut) parts.push('超时')
    out.push({
      id: nextId(section),
      section: section,
      label: step.name,
      value: parts.join(' · '),
      detail: result.summary || '',
      tone: result.timedOut ? 'bad' : (result.exitCode === 0 ? 'ok' : 'bad'),
      evidence: {
        kind: 'command',
        ran: true,
        timedOut: Boolean(result.timedOut),
        exitCode: result.exitCode,
        ms: result.ms,
        command: step.command,
      },
    })
  }
  return out
}

export function artifactClaims(facts) {
  const out = []
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (fact.matched === false) {
      out.push({
        id: nextId('artifact'),
        section: 'artifacts',
        label: fact.pattern,
        value: '这个模式没有匹配到任何文件',
        tone: 'warn',
        evidence: { kind: 'file', matched: false, pattern: fact.pattern },
      })
      continue
    }
    const size = fact.image && fact.image.width
      ? fact.image.format + ' ' + fact.image.width + '×' + fact.image.height
      : '未知格式'
    out.push({
      id: nextId('artifact'),
      section: 'artifacts',
      label: fact.path,
      value: fact.bytes + ' B · sha256 ' + String(fact.sha256).slice(0, 16) + '… · ' + size,
      detail: fact.tracked ? '已入版本库' : '未被 git 跟踪：这个哈希别人复现不出来',
      tone: fact.tracked ? 'ok' : 'warn',
      evidence: { kind: 'file', matched: true, sha256: fact.sha256, bytes: fact.bytes, tracked: fact.tracked, path: fact.path },
    })
  }
  return out
}

export function scanClaims(scan) {
  const out = []
  if (!scan || scan.enabled === false) {
    out.push({
      id: nextId('scan'),
      section: 'scan',
      label: '密钥扫描',
      value: '未启用（配置里关掉了）',
      tone: 'warn',
      evidence: { kind: 'declaration' },
    })
    return out
  }
  const skipped = scan.skipped || {}
  const skipText = '跳过：二进制 ' + (skipped.binary || 0) + ' · 超大 ' + (skipped.oversized || 0)
    + ' · 忽略 ' + (skipped.ignored || 0) + ' · 读不到 ' + (skipped.unreadable || 0)
    + ' · 按标记豁免 ' + (skipped.allowlisted || 0) + ' 行'
  out.push({
    id: nextId('scan'),
    section: 'scan',
    label: '扫描范围',
    value: scan.filesScanned + ' 个入库文件被扫描（共 ' + scan.filesConsidered + ' 个候选）',
    detail: skipText,
    tone: scan.filesScanned > 0 ? 'ok' : 'warn',
    evidence: { kind: 'scan', filesScanned: scan.filesScanned, filesConsidered: scan.filesConsidered },
  })
  out.push({
    id: nextId('scan'),
    section: 'scan',
    label: '扫描结论',
    value: scan.clean ? '未命中任何密钥模式' : '命中 ' + scan.hits.length + ' 处（见下）',
    tone: scan.clean ? 'ok' : 'bad',
    evidence: { kind: 'scan', filesScanned: scan.filesScanned, hits: scan.hits.length },
  })
  for (const hit of scan.hits) {
    out.push({
      id: nextId('scan-hit'),
      section: 'scan',
      label: hit.file + (hit.line > 0 ? ':' + hit.line : ''),
      // 只有规则名与位置：命中内容本身绝不进回执。
      value: hit.label + '（' + hit.rule + '）',
      tone: 'bad',
      evidence: { kind: 'scan', filesScanned: scan.filesScanned },
    })
  }
  return out
}

export function declarationClaims(list, section) {
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    out.push({
      id: nextId('claim'),
      section: section || entry.section || 'author-claims',
      label: entry.label,
      value: entry.value || '（只有标题，没有内容）',
      tone: 'muted',
      // 人写的话永远是未验证：能附证据的东西应该走上面那些工厂。
      evidence: { kind: 'declaration' },
    })
  }
  return out
}
