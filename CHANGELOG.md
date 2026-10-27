# Changelog

## [Unreleased]

### 文档与工程

- 新增 `SECURITY.md`：写清会执行配置里声明的测试/构建命令（请求体不能传命令）、
  `roots` 是精确路径白名单、密钥扫描只覆盖被跟踪文件且是正则黑名单。
- 新增 `.github/workflows/ci.yml`：Windows × Node 22/24，构建 `lib/`、校验 `lib/` 与
  `src/` 一致、跑 `node --test`。**只在 Windows 上跑**：`test/` 里有多处夹具写死了
  `C:\Users\...` 路径，同一套用例在 ubuntu 上必然失败；等夹具改成平台无关后再加 Linux job。
- README 顶部补 CI 与 license badge、star 引导一句。

## 0.1.0

首个版本：

- 三区硬规则：**已验证 / 仅本地 / 未验证**，只看证据的可复现性，不看成败也不看措辞；
  没有证据的板块留空（显示"此区无证据"），不补话。
- 采集：git（分支、HEAD、本地记录的远端一致性、未推送提交、未提交改动、HEAD 标签）、
  配置里声明的测试与构建命令（退出码、通过/失败数、耗时）、交付物（字节数、sha256、图片尺寸、是否入仓）、
  密钥扫描（文件:行号 + 规则名，命中内容一律不落）。
- 三条出口：自包含 HTML 回执页、Markdown（贴 PR/聊天）、JSON 接口；另有 CLI
  `node scripts/receipt.mjs`，不装 DSH 也能出回执。
- 安全边界：要执行的命令只来自配置文件（请求体里塞 `command` 无效，有测试钉住）；
  采集目录只来自配置与 `roots` 白名单，请求里带白名单外的 `cwd` 返回 403；不联网；页面自包含。
- 对话视图「交付回执」面板（order 50），刻意**不轮询** —— 回执是"按一下再拿出去给人看"的东西。
- 64 个测试，四组：evidence / zones / receipt / host。
- 工程骨架复用同作者的 `dsh-warden`（零依赖构建、`cordis.patch.yml`、host/client 双半区、测试结构），实现代码自写。
