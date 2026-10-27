# 安全模型 / Security model

这份文档说明 **dsh-delivery-receipt（交付回执）** 信任什么、读哪些文件、**会执行哪些命令**、
把结果送到哪里。内容从实现（`src/host.js`、`src/collect.js`、`src/evidence.js`、
`src/receipt.js`）读出来；**文档与代码不一致时以代码为准。**

> 一句话：它按**配置里声明的命令**跑测试与构建，读**被跟踪的文件**做密钥扫描，
> 然后把结论渲染成一张不联网的页面。攻击面几乎全在「配置里的命令会以你的权限执行」
> 和「密钥扫描是正则、不是秘密检测器」这两点上。

## 信任边界

插件跑在 DSH 宿主进程里（`src/host.js` 硬 `inject: ['webServer']`），另有 CLI
（`scripts/receipt.mjs`）。两者都走 `collectProject()`。

| 表面 | 谁连进来 | 鉴权 |
| --- | --- | --- |
| DSH web server 上的 `/dsh-delivery-receipt` 前缀路由 | 本机 DSH Web GUI；任何能访问该 web server 的人 | **无**。没有 token、没有 CSRF 校验 |
| CLI | 本机命令行用户 | 由操作系统账户权限决定 |

**不可信输入**：`POST /generate` 的 `cwd`（仅允许白名单内）、被扫描仓库里的
`delivery-receipt.json`、被跟踪文件的内容、git 输出、命令输出。**请求体里没有
`command` 字段**——任何人都无法通过 HTTP 让插件跑一条命令。

## 会执行命令（这是设计）

- `delivery-receipt.json` 的 `tests` / `builds` 会在生成回执时**真的执行**；
  默认 `runCommands: true`，只采集不执行要显式写 `false`；
- 执行器 `defaultRunner()` 用 `spawnSync(command, { shell: true })`——命令本来就是
  一整行命令行，所以**经过 shell**；超时默认 300s，`maxBuffer` 16 MiB；
- 命令来源只有两处：**被采集目录里的配置文件**，或**插件配置里的 `receiptConfig`**；
- 输出只保留结论与最后几行摘要（`tailLines`，≤600 字符），进入回执前统一走
  `redactText()`；返回给 HTTP 的本体只有结构化字段。

**推论**：如果你把 `cwd` 指向一个不可信仓库并生成回执，它的 `delivery-receipt.json`
里的命令就会以你的权限执行。面板会先列出这次要跑的命令（README 的「用法」一节），
但**没有沙箱、没有命令白名单**。

## 读什么

| 读取项 | 来源 | 约束 |
| --- | --- | --- |
| 配置 `delivery-receipt.json` | 采集目录根 | JSON 解析失败则空配置 + 提示，不崩 |
| 版本库文件清单与内容 | `git ls-files` | 只扫被跟踪文件；单文件 >2 MiB 跳过；二进制跳过 |
| git 事实 | `spawnSync('git', ...)`，**不过 shell** | 只读命令：`rev-parse` / `log -1` / `config --get` / `status --porcelain` / `tag` / `rev-list`；超时 20s |
| 交付物 | `artifacts` 里的精确路径或 `目录/*.png` | `join(cwd, rel)` 后 `statSync` + `readFileSync`，跟随符号链接 |
| 命令声明的 cwd | 配置里的 `cwd` | 绝对路径直接用；相对路径按配置文件所在目录解析 |

扫描会跳过 `node_modules/`、`.git/`、`dist/`、`build/`、`coverage/`、`.ship-receipt/`
以及配置里的 `scan.ignore`。

## 写什么

- **插件本身不写任何文件**：回执在内存里，三个出口（HTML / Markdown / JSON）都是响应体；
- **CLI** 在 `--out` 给了路径时 `writeFileSync` 覆盖那个文件（HTML / Markdown / JSON）；
- 不删除任何文件，不改 git 状态，不创建目录（CLI 的 `--out` 父目录需已存在）。

## 密钥扫描：规则明确、边界明确

`SECRET_RULES` / `SENSITIVE_FILENAMES` 是固定正则：GitHub token/PAT、npm token、
`sk-` key、AWS key id、Google API key、Slack token、私钥块、Bearer、赋值形式的口令，
以及被跟踪的 `.env` / 私钥文件 / `credentials*` / `.npmrc`。

- 命中记录**只有文件名、行号、规则名**，不含匹配文本、长度或摘要——回执页是拿去公开的；
- 行内写 `delivery-receipt:allow` 可逐行豁免，豁免行数会原样出现在回执里
  （不是静默放过）；
- 它是**正则黑名单，不是秘密检测器**：自造格式、短口令、图片/压缩包里的密钥都可能漏过；
  扫描范围只有被 git 跟踪的文件，未跟踪文件不扫。

## 分区是证据规则，不是安全判定

「已验证 / 仅本地 / 未验证」由 `src/zones.js` 按证据可复现性计算：
**已验证不等于「是好消息」**——测试失败、扫描命中同样是有证据的事实。
远端状态读的是本地 `refs/remotes/origin/*`，回执里明确标注为「本地记录」，
不会把离线缓存说成实时事实。

## 输出安全

- `src/receipt.js` 的 `esc()` 对 `& < > " '` 全部转义，所有声明/路径/命令输出都经过它；
- HTML 自包含：内联 `<style>`，没有外链脚本、样式表、字体或 CDN；
- 路径统一过 `sanitizePath()`（家目录 → `~`，用户名/盘符去掉），自由文本过 `redactText()`；
- 不发起任何网络请求。

## 已知限制

1. **会执行配置里的命令**：见上。信任模型是「你信任被采集的仓库」，不是「插件保证安全」。
2. **目录白名单是精确路径比较**：`roots` 为空时只允许配置的那一个目录；比较时转小写，
   在大小写敏感的文件系统上会把两个只差大小写的目录当成同一个（更宽松的方向不存在，
   因为它只做相等比较）。
3. **符号链接没有 `realpath` 校验**：白名单比较和 `join(cwd, rel)` 都是字面路径；
   配置里的 `../` 或符号链接可以让 `artifacts` 读到采集目录之外的文件。
4. **扫描有天花板**：只扫被跟踪文件、单文件 ≤2 MiB、跳过二进制与大目录；
   漏报是可能的，豁免标记也可能被用来藏真凭据——但豁免数量会写在回执里。
5. **命令输出被截断**：只保留最后几行、≤600 字符；回执不是完整日志。
6. **无鉴权、无 CSRF**：能访问 DSH 端口的人可以触发一次采集（跑命令、读文件）。
   边界依赖宿主只监听本机回环地址。
7. **不持久化**：插件重启后上一张回执就没了；CLI 的 `--out` 是唯一的落盘方式。

## 明确不算漏洞

- 执行 `delivery-receipt.json` 里声明的测试/构建命令（这是插件的全部意义）；
- 测试失败或扫描命中被写进「已验证」区（分区看证据强度，不看成败）；
- README 里写「已内部评审」而没有证据时进「未验证」区（设计）；
- 在被采集仓库里写 `delivery-receipt:allow` 豁免某一行（可见的豁免，不是静默）；
- 用 CLI/面板对任意仓库生成回执（这是功能；风险见「已知限制 1」）；
- 回执里出现 commit SHA、文件哈希、命令退出码（都是本地事实）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-delivery-receipt/security/advisories/new>

个人项目，**不承诺响应时限**；修完会写进 `CHANGELOG.md`。请不要把仍在生效的问题先发到公开 issue。

## 支持范围

只维护最新版（当前 `0.1.0`，见 `package.json`）。旧版本不回补。
