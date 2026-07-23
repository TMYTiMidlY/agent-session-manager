# agent-session-manager

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

**把编码 agent 的 CLI 会话导出成 Markdown 或单文件 HTML。** `agent-session-manager` 只读地读取 GitHub Copilot CLI、Claude Code、OpenAI Codex CLI 写在本地的会话历史，再把选定的会话导出成一份忠实、自包含的报告。CLI 二进制名为 `chronicle`。

HTML 产物高度复刻 Copilot CLI 内置 `/share html` 的排版（Primer 主题、sticky header、类型筛选 pill、侧栏目录、上一条/下一条用户消息跳转、搜索），差异[有专门文档记录](docs/copilot-timeline.md)。Markdown 产物遵循 Copilot CLI `/share file` 的结构与约定（`### 💬/👤/🔧/✅` 标题、`<sub>⏱️</sub>` 耗时戳、`<details>` 折叠、diff 围栏、`[!NOTE]` 头块）。

它对 agent 状态目录**只读**：不写 `.copilot`、`.claude`、`.codex`，也不尝试把会话恢复回原 CLI。读命令（`list` / `search` / `show` / `html` / `md`）都严格本地——从不联系任何云端或会话同步后端、从不通过网络拉取会话历史。（唯一走网络的是 `backup`：它按你配置的 restic 远端做备份 / 恢复。）

## 能做什么

| 目标 | 命令 |
|---|---|
| 列出已知会话 | `chronicle list --agent all` |
| 搜索本地历史 | `chronicle search "关键词" --agent all` |
| 在单个会话内搜索 | `chronicle search "关键词" --session <session-id>` |
| 打印一个会话 | `chronicle show <session-id> --agent claude` |
| 只看对话主干（跳过工具调用） | `chronicle show <session-id> --format dialogue` |
| 导出 Markdown（Copilot `/share file` 风格） | `chronicle md <session-id> -o session.md` |
| 导出 HTML（高度复刻 `/share html`） | `chronicle html <session-id> -o session.html` |
| 读取任意位置的会话文件（scp 来的 / 恢复出来的） | `chronicle html --file /path/to/events.jsonl -o session.html` |
| 搜索恢复出来的备份缓存目录 | `chronicle search "关键词" --file /path/to/restored-cache` |
| 运行备份（restic 封装） | `chronicle backup run --dry-run` |

## 支持的 agent 与数据来源

- **Copilot CLI**：读取 `~/.copilot/session-state/*/events.jsonl`；同时用 `~/.copilot/session-store.db` 列出会话与元信息。events.jsonl 缺失（老会话被 prune、或只迁移了 DB）时回退到 DB 的 `turns` 表（lossy：只有 user/assistant 文本，工具与用户决策不可恢复）。所有读命令可用 `--copilot-db <path>` 覆盖 DB 路径。
- **Claude Code**：读取 `~/.claude/projects/**/*.jsonl`
- **Codex CLI**：读取 `~/.codex/sessions/**/*.jsonl`

每个读命令（`list` / `search` / `show` / `html` / `md`）都接受 `--file <path>`（别名 `--events <path>`），读一个显式的 `*.jsonl` 文件——或一个会被遍历出这些文件的目录——而不是 live agent 主目录。每个文件的 agent 格式自动探测（用 `--agent` 覆盖）。这就是渲染从别的机器拷来的会话、或搜索 restic 恢复出来的备份缓存（无需先放回 `~/.copilot`）的方式。

## 安装

尚未发布到 npm。克隆后本地 link——在单二进制发布落地前，这是受支持的路径。

### 全局命令

```bash
git clone https://github.com/TMYTiMidlY/agent-session-manager.git
cd agent-session-manager
pnpm install
pnpm build
pnpm --filter @agent-session-manager/cli exec npm link    # 装出全局 `chronicle`
chronicle list --agent all
```

卸载：

```bash
pnpm --filter @agent-session-manager/cli exec npm unlink -g
```

单二进制发布（`bun build --compile`，覆盖 macOS / Linux / Windows）与 `npm i -g github:...` 一行安装，见[路线图](#roadmap)。

### 开发环境

```bash
pnpm install
pnpm build
```

直接运行构建产物：

```bash
node packages/cli/dist/index.js list --agent all
```

本地开发也可用 workspace 脚本：

```bash
pnpm chronicle search "关键词" --agent all
```

## 首次运行

1. 构建项目。
2. 列出某个 agent 的会话：

   ```bash
   node packages/cli/dist/index.js list --agent copilot
   ```

3. 从第二列复制一个 session id。
4. 生成 HTML：

   ```bash
   node packages/cli/dist/index.js html <session-id> --agent copilot -o report.html
   ```

5. 用浏览器打开 `report.html`。

HTML 文件是自包含的：搜索、筛选、可折叠条目、侧栏目录、紧凑模式、主题切换、Markdown 表格、数学渲染都离线可用。

## CLI 命令

### `chronicle list`

以 tab 分隔的行打印发现的会话：

```bash
chronicle list --agent all
chronicle list --agent claude --claude-root /path/to/claude/projects
```

用 `--by project` 或 `--by agent` 分组（默认平铺）。project 取会话记录 cwd 最近的、含 `.git/` 的祖先目录（仅当该 cwd 在本机存在时才探测文件系统）；cwd 存在但找不到 `.git` 祖先、或该路径不在本机时，按记录的 cwd 原样分组；只有完全没有 cwd 的会话才归入 `(unscoped)` 桶：

```bash
chronicle list --by project     # 按仓库聚类会话
chronicle list --by agent       # 按 copilot / claude / codex 分组
```

分组模式每组打印一个 `# <组> (<数量>)` 头（组间排序，组内按最后活动时间从新到旧），随后是 `组`、`agent`、`session-id`、`最后活动`、`条目数` 的 tab 分隔行。

### `chronicle search`

搜索 user、assistant、reasoning、tool、system、event 文本：

```bash
chronicle search "database migration" --agent all --limit 20
chronicle search "database migration" --session <session-id>   # 只在一个会话里搜
```

每条命中是一行 tab 分隔、以 `project` 列（cwd 最近的含 `.git` 祖先目录；找不到 `.git` 祖先时为 cwd 原值，无 cwd 时为 `(unscoped)`）开头：`project`、`agent`、`session-id`、`#条目`、`role/kind`、`摘录`。

`--session <id>` 把搜索限定到一个会话（先精确匹配 id，否则按前缀匹配）——用来在**当前这个会话**里按关键词找模型回复，不必先用 `--file` 指路径。

### `chronicle show`

以 text、dialogue 或 JSON 打印一个会话：

```bash
chronicle show <session-id> --agent codex
chronicle show <session-id> --agent copilot --format dialogue
chronicle show <session-id> --agent codex --format json
```

`--format dialogue` 只保留**用户消息 / 用户决策（`ask_user` 的回答）/ 压缩摘要 / 助手回复**，跳过工具调用与 reasoning。工具噪音被剔掉后，每条用户 prompt 直接紧跟回答它的助手回复，prompt↔回复的对应关系一目了然——适合会话复盘、交接和收尾盘点等需要通读对话主干的场景。`--format text` 则含完整工具参数+结果、子代理/技能/计划/压缩统计。

### `chronicle html`

写出一份自包含 HTML 报告。它高度贴合 Copilot CLI `/share html`（sticky header、筛选 pill、侧栏目录、搜索、展开/折叠、上一条/下一条用户消息跳转、主题切换、紧凑模式、Markdown 表格、KaTeX 数学），但不是逐像素/逐字节一致。有意为之的差异：

- **用 React 渲染，而非官方 vanilla bundle 资产。** 抽取的上游 CSS/JS 只当逆向参照，不随运行时产物发布。
- **Shiki 语法高亮**，覆盖 markdown 代码围栏与 diff 风格的工具输出，双 light+dark 主题，页面切主题时代码无需重载即重新着色。
- **24 小时制时间戳**（会话起点 `YYYY-MM-DD HH:MM:SS`；同日条目 `HH:MM:SS`，跨日 `MM-DD HH:MM:SS`）——en-US 默认的 12 小时制（`PM/AM`）太容易读错。
- **耗时 pill**，由 `startedAt` → 最后一条条目算出，显示在 header。
- **agent 总结卡片**，用 `--summary <file.html>` 钉在时间线顶部（原样渲染受信任 HTML；`data-index="summary"`，真实第 1 条仍是第 1 条）。
- **合并的工具卡片**，五种结果态（success / failure / rejected / denied / pending），配对应的边框色与状态图标。
- **`ask_user` 的回答被抽成一等「用户决策」条目**（`user/decision`）：既保留原始工具卡片，又让用户的选择/回答在时间线里单独、显眼地出现——复盘或交接时不会把决策埋没在成百上千次工具调用里。
- **子代理 / 技能 / 计划条目**，从 `events.jsonl` 解析、各自成卡片 + 筛选 pill。子代理卡片在可得时显示记录到的身份、模型、描述、失败详情。这些超出 Copilot 自身 `/share html` 的筛选集。
- **数据源回退警告 pill**，当解析器不得不读 `events.jsonl` 之外的东西时显示在 header；回退到 `db.turns` 时进一步说明「交互式用户决策与工具条目在此模式下不可恢复」。
- **默认展开策略在其余方面沿用 Copilot bundle**：`user / assistant / error / task_complete` 展开，其它折叠。
- **单行 info 条目**（模型切换 / 取消）默认展开而非折叠——与官方 bundle 不同，让「Model changed from X to Y」「Operation cancelled by user」这类一行信息一眼可见；多行 info 仍折叠。
- **只存在于 live 内存的条目离线无法重建**，包括吉祥物启动横幅、临时重试提示、`/share` 成功回执。见 [`docs/copilot-timeline.md`](docs/copilot-timeline.md)。

```bash
chronicle html <session-id> --agent copilot -o report.html
chronicle html <session-id> -s agent-summary.html -o report.html   # 顶部钉一份 HTML 总结
```

### `chronicle md`

导出遵循 Copilot CLI `/share file` 约定的 Markdown（`### 💬/👤/🔧/✅` 标题、`<sub>⏱️</sub>` 耗时戳、长工具输出 `<details>` 折叠、diff 围栏、`[!NOTE]` 头块）：

```bash
chronicle md <session-id> --agent copilot -o report.md
chronicle md <session-id> --no-reasoning -o report.md             # 去掉 reasoning 条目
chronicle md <session-id> -s summary.md -o report.md              # 注入一份 markdown 总结
```

### `chronicle backup`

`backup` 是一个命令组：

```bash
chronicle backup run --dry-run     # 预览 restic 备份
chronicle backup run               # 运行 restic 备份封装（backup.sh）
chronicle backup                   # `backup run` 的向后兼容别名
chronicle backup cache latest --target ~/.cache/chronicle/restic-cache   # 把一个快照恢复进缓存目录
```

`backup cache` 把 agent 历史从 restic 快照恢复进一个**本地缓存目录**（绝不恢复进 live 的 `~/.copilot`、`~/.claude`、`~/.codex`——那会被拒绝），之后读命令可用 `--file` 在其上工作（未来还有 `--source cache`）。加 `--host <h>` 钉某主机的快照，`--dry-run` 只预览、不实际恢复。

备份是未来 chronicle/搜索工作的一个数据源。当前搜索读 live 本地历史；对恢复出来的备份缓存做**持久化**索引单独跟踪（issue #1）。今天要临时用，就恢复一个快照，再用 `--file` 让任意读命令指过去：

```bash
restic restore latest --target /tmp/cache          # 恢复一个快照
chronicle search "关键词" --file /tmp/cache           # 搜索恢复出来的缓存
chronicle html <session-id> --file /tmp/cache -o s.html
```

## 从 live 目录之外读取会话

`--file <path>`（别名 `--events <path>`）让 `list` / `search` / `show` / `html` / `md` 读一个显式路径，而不是 `~/.copilot`、`~/.claude`、`~/.codex`：

```bash
# 从别的机器拷来的单个会话文件（agent 自动探测）
chronicle show --file ~/dl/events.jsonl --format json
chronicle html --file ~/dl/events.jsonl -o report.html

# 整个目录（遍历 *.jsonl；每个文件各自探测 agent）
chronicle list --file /tmp/restored-cache
chronicle search "migration" --file /tmp/restored-cache
```

`--file` 指向单个文件时，`<session-id>` 参数可省。指向的目录若产出多个会话，传一个 `<session-id>` 挑一个（用 `chronicle list --file <dir>` 看 id）。

## 文档

- [`docs/copilot-timeline.md`](docs/copilot-timeline.md) —— Copilot 的内存 timeline、持久化事件流、离线映射策略与保真度边界。
- [`docs/backup.md`](docs/backup.md) —— 备份内容、排除项、保留策略、加密、面向恢复的架构。

## 备份配置

> 具体备份哪些内容（逐目录）、`rewind-snapshots` 排除、端到端加密模型、网络架构，见 [`docs/backup.md`](docs/backup.md)。

复制模板、填入你自己的后端：

```bash
cp secrets.env.example secrets.env
chmod 600 secrets.env
```

必填变量：

| 变量 | 含义 |
|---|---|
| `RESTIC_REPOSITORY` | restic 仓库 URL，例如一个 S3 兼容桶 |
| `RESTIC_PASSWORD` | restic 仓库的加密口令 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 凭据，仅 S3 兼容后端需要 |

可选变量：

| 变量 | 默认值 |
|---|---|
| `RESTIC_BIN` | `$HOME/.local/bin/restic` |
| `BACKUP_AGENT_DIRS` | `$HOME/.copilot:$HOME/.claude:$HOME/.codex` |
| `BACKUP_EXCLUDE_REWIND` | 未设置；设为 `1` 跳过 Copilot rewind 快照 |

首次初始化一个新的 restic 仓库：

```bash
set -a; source secrets.env; set +a
restic init
```

然后运行：

```bash
chronicle backup run --dry-run
chronicle backup run
```

把 `RESTIC_PASSWORD` 存进密码管理器或另一台设备。丢了它，加密备份就再也读不出来。

## 用 systemd 自动备份

示例 unit 文件在 `systemd/`：

```bash
mkdir -p ~/.config/systemd/user
cp systemd/agent-session-manager.service.example ~/.config/systemd/user/agent-session-manager.service
cp systemd/agent-session-manager.timer.example ~/.config/systemd/user/agent-session-manager.timer
```

编辑 `agent-session-manager.service`，把路径指向你的 checkout，然后：

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-session-manager.timer
systemctl --user list-timers agent-session-manager.timer
```

若希望登出后 timer 仍运行，请用你的系统管理员账户开启 user lingering。

## 目录结构

| 路径 | 用途 |
|---|---|
| `packages/core` | agent 发现、解析器、规范化时间线模型、搜索 |
| `packages/markdown` | 遵循 Copilot `/share file` 约定的 Markdown 渲染器 |
| `packages/html` | 基于 React 的单文件 HTML 渲染器，高度复刻 Copilot `/share html` |
| `packages/cli` | `chronicle` 命令 |
| `fixtures` | 脱敏的解析器与 CLI fixtures |
| [`tools/copilot`](tools/copilot/) | Copilot `/share` bundle 漂移探针（仅逆向研究，非运行时依赖） |
| `backup.sh` | `chronicle backup` 用的 restic 封装 |

## 同类项目对比

这个问题空间很拥挤——至少 14 个 OSS 项目瞄准相近方向，其中几个 star 数可观，至少一个出自知名开源作者。设计本工具前我们调研过它们，并在本地 `readonly-repos/<name>/` 各留一份只读镜像备查。

| 仓库 | Stars | 语言 | 形态 | 覆盖 agent | 备注 |
|---|---:|---|---|---|---|
| [simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) | 1586 | Python | CLI → 分页静态 HTML | Claude | Simon Willison 出品；移动端友好的多页输出 |
| [d-kimuson/claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer) | 1233 | TS (web) | 完整 web 客户端（live + 历史） | Claude | 不只是查看器；能经 Agent SDK 驱动新会话 |
| [daaain/claude-code-log](https://github.com/daaain/claude-code-log) | 1121 | Python | CLI → HTML/Markdown + Textual TUI | Claude | `uvx claude-code-log` 零安装；项目层级索引页 |
| [specstoryai/getspecstory](https://github.com/specstoryai/getspecstory) | 1260 | 混合 | 商业产品（CLI 部分开源） | 多种 IDE/CLI | “Intent is the new source code”——捕获 + 索引 + skill forge |
| [nateherkai/token-dashboard](https://github.com/nateherkai/token-dashboard) | 605 | Python | 本地 web 仪表盘 | Claude | 成本 / token 用量分析视角 |
| [vibe-log/vibe-log-cli](https://github.com/vibe-log/vibe-log-cli) | 332 | TS | npm CLI（`vibe-log`） | Claude + Codex | 生产力报告 + Claude 状态栏 |
| [delexw/claude-code-trace](https://github.com/delexw/claude-code-trace) | 327 | TS+Rust (Tauri) + Python | 原生 GUI + Web + TUI | Claude | Tauri 桌面，`cctrace` CLI；丰富的实时 tail UI |
| [kylesnowschwartz/tail-claude](https://github.com/kylesnowschwartz/tail-claude) | 146 | Go | Bubble Tea TUI | Claude | 单二进制，需 Nerd Font |
| [wesm/archived-agent-session-viewer](https://github.com/wesm/archived-agent-session-viewer) | 88 | Python | 本地 web app (FastAPI) | Claude + Codex | Wes McKinney（pandas/Arrow）出品；**已归档**，转向 AgentsView |
| [shayne-snap/waylog-cli](https://github.com/shayne-snap/waylog-cli) | 84 | Rust | 自动同步到 `.waylog/` markdown 文件 | Claude + Codex + Gemini | Cargo / Homebrew / Scoop 分发 |
| [PixelPaw-Labs/codex-trace](https://github.com/PixelPaw-Labs/codex-trace) | 56 | TS+Rust (Tauri) | 原生 GUI + Web | Codex | claude-code-trace 的姊妹项目 |
| [monk1337/clicodelog](https://github.com/monk1337/clicodelog) | 47 | Python (FastAPI) | 本地 web app | Claude + Codex + Gemini | 现有最接近的多 agent 本地查看器 |
| [HizTam/codex-history-viewer](https://github.com/HizTam/codex-history-viewer) | 19 | TS | VS Code 扩展 | Claude + Codex | 在 VS Code 内浏览 + 恢复 |
| [dotneet/agent-session-view](https://github.com/dotneet/agent-session-view) | 10 | TS (Bun) | Web + Ink TUI | Claude + Codex | 多种导出格式（text + HTML） |

### 与它们的差异

- **GitHub Copilot CLI 是一等适配器。** 上面的项目目前都不解析 `~/.copilot/session-state/*/events.jsonl`。
- **产物贴近 Copilot CLI `/share file` 与 `/share html` 约定，但不声称完全等价。** 熟悉的 Primer 样式、筛选概念、emoji 前缀的 Markdown 标题、耗时戳、`<details>` 折叠、diff 围栏都延续下来。HTML 渲染器用 React 而非官方 vanilla bundle，额外加了子代理/技能/计划与总结条目，用 Shiki 与 24 小时制，且无法重建只存在于 live 内存的条目。见 [`docs/copilot-timeline.md`](docs/copilot-timeline.md)。
- **单文件 HTML 是默认交付物。** ~1 MB，无服务器、无构建，双击即开。（多数同类发 Tauri app、Express/FastAPI web app 或 TUI；唯二的静态 HTML 同类是 Simon 的 `claude-code-transcripts`（仅 Claude）和 `daaain/claude-code-log`（仅 Claude）。）
- **库 + CLI，不只是一个 app。** `@agent-session-manager/core`、`/markdown`、`/html` 可独立 import，供想要解析器或渲染器而不要 CLI 的下游工具使用。
- **不耦合 live agent SDK。** 只读，正常运行不调用任何 Anthropic / OpenAI / GitHub API；没有 `claude-code-viewer` 那样要应对的 ToS 面。

### 从同类项目借鉴（待做）

这些都作为 GitHub issue 跟踪，每条都写明 `Inspired by …`：

- **项目层级索引页**，链接到每个会话 HTML（à la `claude-code-log`）。
- **Token / 成本分析视图**（à la `token-dashboard`）。
- **实时 tail 模式**，跟随打开中的会话（à la `claude-code-trace` / `tail-claude`）。
- **按项目分组的侧栏**，用于 `chronicle list`（à la `agent-session-viewer`、`codex-history-viewer`）。
- **VS Code 扩展封装**，作为独立包（à la `codex-history-viewer`）。
- **用于 Pages 托管的静态导出 tarball**（à la `claude-code-transcripts`）。

## 公开前的安全检查

把本仓库推到任何公开位置前，只检查被跟踪的文件：

```bash
git ls-files
git grep -nE 'PRIVATE|SECRET|TOKEN|PASSWORD|AKIA|/(h[o]me|Users)/|10\\.|192\\.168\\.|172\\.|D[E]SKTOP|[Ww]orkstation'
```

`secrets.env`、`backup.log`、`node_modules/`、构建产物都被忽略，应保持未跟踪。

## <a id="roadmap"></a>路线图

- **单文件分发。** 用 `bun build --compile` 打包 CLI，把原生二进制附加到 GitHub Releases；workspace 打包配好后再加 `npm i -g github:...` 一行安装。
- **对 restic 恢复出来的备份快照做持久化索引/缓存搜索**（最初在前身 `session-trace` 仓库里记为 issue #1——见 `docs/issues/search-restic-backups.md`）。对恢复出来的缓存目录做临时搜索已能用 `chronicle search --file <dir>` 做到，`chronicle backup cache` 恢复助手也已实现；剩下的是一个持久化的 SQLite/FTS 索引。
- **提升每种 agent 格式的适配器保真度。**
- **项目层级索引页**（灵感来自 `daaain/claude-code-log`）。
- **Token / 成本分析视图**（灵感来自 `nateherkai/token-dashboard`）。
- **面向活跃会话的实时 tail 模式**（灵感来自 `delexw/claude-code-trace`、`kylesnowschwartz/tail-claude`）。
- **VS Code 扩展封装**（灵感来自 `HizTam/codex-history-viewer`）。
- **用于 GitHub Pages 的静态导出 tarball**（灵感来自 `simonw/claude-code-transcripts`）。
- **跨多会话的仪表盘视图。**
