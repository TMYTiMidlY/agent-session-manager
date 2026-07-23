# ADR 0002：单一 `asmgr` 包、能力而非产品、分发与发布

## 状态

已接受。取代 [ADR 0001](0001-scope-archive-and-restore.md) 中关于**命名与包结构**的部分：命令现为 `asmgr`，pnpm workspace（`packages/*`）已收敛为单一无 scope 的 npm 包 + `src/*` 内部模块。

## 背景

早期是 pnpm workspace + 四个 scoped 包（`@agent-session-manager/{core,html,markdown,cli}`）、命令叫 `chronicle`。两点与之相悖：

- **分发**：唯一可发布的入口就是一个 CLI。从 tarball 或 `github:` 安装会被 `workspace:*` 协议卡住（npm 不解析它）；目标是低摩擦的 `npm i -g` 加一个免 Node 的原生二进制。四个 scoped 包只增加仪式——没人单独 import `core`。
- **产品身份**：HTML / Markdown 是这个 CLI 的**导出能力**，不是各自发布的产品；未来的本地 Web UI 也是同一个故事——一个工具、多个输出面。

## 决策

- **一个包**：发布单一、无 scope 的公开 npm 包 **`asmgr`**（Agent Session ManaGeR），命令也叫 `asmgr`。`core / html / markdown / cli` 只是 `src/*` 下的内部模块，用相对 import 串联，不再有 `@…/*` 子包——从根上消掉 `workspace:*` 解析问题。
- **HTML / Markdown 是能力而非产品**：随 `asmgr` 一起发布，经 `asmgr html` / `asmgr md` 使用。
- **未来的 `asmgr web` 只面向本地**：一个查看自己会话的浏览器界面，随同一个包分发，默认只绑 `127.0.0.1`——个人本地查看器，不是服务器。
- **分发渠道**：`npm i -g asmgr`（发布后）；每平台 `bun build --compile` 的单文件原生二进制，挂到 GitHub Release；`npm i -g github:…` 作为免 registry 的 Node 安装（`prepare` 钩子用 esbuild 把 `src/cli/index.ts` 打成自包含的 `dist/asmgr.mjs`）。
- **用 semantic-release 自动发版**：Conventional Commits 定版本，git tag 是真相源；发版把 `package.json` + `CHANGELOG.md` 提交回 `main`，`asmgr --version` 即读这个 `package.json`。release workflow 手动触发——**跑它本身就是发版批准**。

## 取舍与后果

- 命令 = 包名 `asmgr`，一个身份：装完即跑，消掉旧的"包叫 `agent-session-manager`、命令却叫 `chronicle`"的错配（`chronicle` 和 `agent-session-manager` 在 npm 上都已被占，才选了未被占用的 `asmgr`）。仓库 / 项目名仍是 `agent-session-manager`（描述性全名），与短命令 `asmgr` 并存，属正常。
- Bun 未实现 `node:sqlite`，故原生二进制会**静默跳过 Copilot 实时 SQLite** 这一个数据源；所有 JSONL 源与 Node 安装均不受影响。
- `pnpm` 仍是开发期包管理器，但只剩一个 `package.json` / `tsconfig.json` / 测试运行。
- 首次 `semantic-release` 默认从 `1.0.0` 起（除非先打种子 tag）——这是留给人的发版动作。
