# [0.5.0](https://github.com/TMYTiMidlY/agent-session-manager/compare/v0.4.2...v0.5.0) (2026-10-04)


### Features

* make session discovery and indexed search recent-first ([b1c8588](https://github.com/TMYTiMidlY/agent-session-manager/commit/b1c858855a809150e4277aa4b3ba37bd5c2ba2f8))

## [0.4.2](https://github.com/TMYTiMidlY/agent-session-manager/compare/v0.4.1...v0.4.2) (2026-10-04)


### Bug Fixes

* read DSH archives without pinning runtime codecs ([0936b7e](https://github.com/TMYTiMidlY/agent-session-manager/commit/0936b7eaf6c8711db9080a82ba4e8cabf3f44b0d))

## [0.4.1](https://github.com/TMYTiMidlY/agent-session-manager/compare/v0.4.0...v0.4.1) (2026-09-30)


### Bug Fixes

* keep cross-session search usable around unreadable archives ([722a520](https://github.com/TMYTiMidlY/agent-session-manager/commit/722a5200a91290dbcdf5dec84a9a296e628d29fb))

# [0.4.0](https://github.com/TMYTiMidlY/agent-session-manager/compare/v0.3.0...v0.4.0) (2026-09-30)


### Features

* read DSH v4 session archives ([6af9d73](https://github.com/TMYTiMidlY/agent-session-manager/commit/6af9d73e983ea7da95ba366030dba9eefde04723))

# [0.3.0](https://github.com/TMYTiMidlY/agent-session-manager/compare/v0.2.0...v0.3.0) (2026-09-10)


### Bug Fixes

* stream large JSONL sessions without full-file buffering [skip ci] ([270ba5d](https://github.com/TMYTiMidlY/agent-session-manager/commit/270ba5d5ce13a906fb4b7495ead979350a1080c9))


### Features

* support DSH session archives and dialogue questions ([621ed5d](https://github.com/TMYTiMidlY/agent-session-manager/commit/621ed5df64b2156945b5842da3ce5605c6fd337d))

# [0.2.0](https://github.com/TMYTiMidlY/agent-session-manager/compare/v0.1.0...v0.2.0) (2026-08-18)


### Features

* support public ChatGPT share archives ([1107a0e](https://github.com/TMYTiMidlY/agent-session-manager/commit/1107a0e181c670bf6ed39d6ed9a8edd414b67878))

# Changelog

All notable changes to this project will be documented in this file. Versions and
sections are generated from [Conventional Commits](https://www.conventionalcommits.org)
by [semantic-release](https://github.com/semantic-release/semantic-release).

## 0.1.0 (2026-07-24)

首个公开版本。`asmgr`（Agent Session ManaGeR）把 GitHub Copilot CLI、Claude Code 和
OpenAI Codex CLI 的本地会话历史统一成可搜索、可导出的离线时间线。

### 主要功能

- 发现并列出三种 agent 的本地会话，可按 agent 或项目分组。
- 跨会话全文搜索，或用 `--session` 限定到单个会话。
- `show` 提供完整 text、对话主干 dialogue 与 JSON 三种视图。
- 导出遵循 Copilot `/share file` 结构的 Markdown。
- 导出自包含单文件 HTML：Primer 明暗主题、搜索与筛选、侧栏目录、折叠、用户消息跳转、
  Shiki 代码高亮、KaTeX 数学渲染与 24 小时制时间戳。
- 把 `ask_user` 回答抽成一等「用户决策」条目，并支持 reasoning、subagent、skill、plan、
  compaction、task completion 等结构化事件。
- Copilot `events.jsonl` 解析提供 handled / ignored / unknown 诊断；事件文件缺失时可从
  `session-store.db` 的 turns 表进行有损回退并显式警告。
- 所有读命令支持 `--file` / `--events`，可直接读取单个 JSONL 或 restic 恢复目录。
- `asmgr backup run` 封装 restic 加密增量备份；`asmgr backup cache` 把快照恢复到隔离缓存，
  明确拒绝写入 live 的 `.copilot`、`.claude`、`.codex`。

### 安装与分发

- 单一无 scope 的 npm 包与同名命令：`npm i -g asmgr`。
- `npm i -g github:TMYTiMidlY/agent-session-manager` 免 registry 安装。
- GitHub Releases 提供 Linux x64、macOS Intel、macOS Apple Silicon、Windows x64
  四个平台的 Bun 单文件二进制，以及 Node bundle 与 SHA-256 校验和。

### 已知限制

- Bun 尚不支持 `node:sqlite`：原生二进制会跳过 Copilot live SQLite 数据源；Copilot
  `events.jsonl`、Claude / Codex JSONL 与 `--file` 路径不受影响。需要 live SQLite
  数据源时使用 Node 安装。
- HTML / Markdown 是有损只读归档，不可反推出可 `--resume` 的原生会话状态。
