# asmgr

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.x-f69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

**把编码 agent 的 CLI 会话导出成 Markdown 或单文件 HTML。** `asmgr`（Agent Session ManaGeR）只读地读取 GitHub Copilot CLI、Claude Code、OpenAI Codex CLI 写在本地的会话历史，再把选定的会话导出成一份忠实、自包含的报告。它是**一个**无 scope 的公开 npm 包，命令也叫 `asmgr`；HTML 与 Markdown 是它的导出能力，而非独立发布的产品。

HTML 产物高度复刻 Copilot CLI 内置 `/share html` 的排版（Primer 主题、sticky header、类型筛选 pill、侧栏目录、上一条/下一条用户消息跳转、搜索），差异见 [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md)。Markdown 产物遵循 Copilot CLI `/share file` 的结构与约定（`### 💬/👤/🔧/✅` 标题、`<sub>⏱️</sub>` 耗时戳、`<details>` 折叠、diff 围栏、`[!NOTE]` 头块）。

它对 agent 状态目录**只读**：不写 `.copilot`、`.claude`、`.codex`。读命令（`list` / `search` / `show` / `html` / `md`）都严格本地——从不联系任何云端或会话同步后端、从不通过网络拉取会话历史。（唯一走网络的是 `backup`：它按你配置的 restic 远端做备份 / 恢复。）

> **归档 ≠ 恢复。** 导出的报告是有损、只读、给人看的产物，**不能**反推回可 `--resume` 的原生会话。把会话忠实恢复到"另一台机器能续聊"是一条**规划中**的独立能力（来源 = 备份快照 ∪ 另一台机器），与只读归档严格分层——理念见 [ADR 0001](docs/adr/0001-scope-archive-and-restore.md) 与 [ADR 0004](docs/adr/0004-restore-fidelity-and-safety.md)。

## 功能

| 目标 | 命令 |
|---|---|
| 列出已知会话 | `asmgr list --agent all` |
| 搜索本地历史 | `asmgr search "关键词" --agent all` |
| 在单个会话内搜索 | `asmgr search "关键词" --session <session-id>` |
| 打印一个会话 | `asmgr show <session-id> --agent claude` |
| 只看对话主干（跳过工具调用） | `asmgr show <session-id> --format dialogue` |
| 导出 Markdown（Copilot `/share file` 风格） | `asmgr md <session-id> -o session.md` |
| 导出 HTML（高度复刻 `/share html`） | `asmgr html <session-id> -o session.html` |
| 读取任意位置的会话文件（scp 来的 / 恢复出来的） | `asmgr html --file /path/to/events.jsonl -o session.html` |
| 搜索恢复出来的备份缓存目录 | `asmgr search "关键词" --file /path/to/restored-cache` |
| 运行备份（restic 封装） | `asmgr backup run --dry-run` |

## 支持的 agent 与数据来源

- **Copilot CLI**：读取 `~/.copilot/session-state/*/events.jsonl`；同时用 `~/.copilot/session-store.db` 列出会话与元信息。events.jsonl 缺失（老会话被 prune、或只迁移了 DB）时回退到 DB 的 `turns` 表（lossy：只有 user/assistant 文本，工具与用户决策不可恢复）。所有读命令可用 `--copilot-db <path>` 覆盖 DB 路径。
- **Claude Code**：读取 `~/.claude/projects/**/*.jsonl`
- **Codex CLI**：读取 `~/.codex/sessions/**/*.jsonl`

每个读命令（`list` / `search` / `show` / `html` / `md`）都接受 `--file <path>`（别名 `--events <path>`），读一个显式的 `*.jsonl` 文件——或一个会被遍历出这些文件的目录——而不是 live agent 主目录。每个文件的 agent 格式自动探测（用 `--agent` 覆盖）。这就是渲染从别的机器拷来的会话、或搜索 restic 恢复出来的备份缓存（无需先放回 `~/.copilot`）的方式。

## <a id="install"></a>安装

四种方式，按摩擦从低到高。`asmgr` 是单一、无 scope 的公开 npm 包。

### npm（发布到 registry 后）

```bash
npm i -g asmgr
asmgr list --agent all
```

> 发布由手动触发的 CI（semantic-release）驱动。registry 上线前，请用下面任一方式。

### 原生二进制（无需 Node）

从 [Releases](https://github.com/TMYTiMidlY/agent-session-manager/releases) 下载对应平台的单文件二进制，内置 Bun 运行时、零依赖：

```bash
# Linux x64（macOS 换成 asmgr-darwin-arm64 或 asmgr-darwin-x64）
curl -fsSL https://github.com/TMYTiMidlY/agent-session-manager/releases/latest/download/asmgr-linux-x64 \
  -o ~/.local/bin/asmgr && chmod +x ~/.local/bin/asmgr
asmgr list --agent all
```

Windows 下载 `asmgr-windows-x64.exe`。每个 Release 附带 `SHA256SUMS.txt` 可校验完整性。

> **一处限制：** 二进制基于 Bun，而 Bun 目前未实现 `node:sqlite`，因此**读取 Copilot 实时 SQLite 库**这一个数据源在二进制里会静默跳过（其余数据源——各家 `*.jsonl`、`--file` 指向的任意文件/目录——都正常）。需要该数据源请改用 Node 安装。

### `npm i -g github:`（需 Node ≥ 22，免 registry）

安装时 `prepare` 钩子会用 esbuild 把 CLI 打包成单个自包含文件，无需预先构建：

```bash
npm i -g github:TMYTiMidlY/agent-session-manager
asmgr list --agent all
```

卸载：`npm uninstall -g asmgr`。

### 从源码构建

```bash
git clone https://github.com/TMYTiMidlY/agent-session-manager.git
cd agent-session-manager
pnpm install          # 触发 prepare 钩子，打出 dist/asmgr.mjs
```

装成全局 `asmgr`（软链回本仓库；卸载用 `npm rm -g asmgr`）：

```bash
npm link
asmgr list --agent all
```

开发时直接跑源码：`pnpm dev list --agent all`（经 tsx）。自行编译原生二进制（需要 [Bun](https://bun.sh)）：`pnpm run binaries`，四平台产物落在 `dist/asmgr-*`。

## 首次运行

1. 按上面任一方式装好 `asmgr`。
2. 列出某个 agent 的会话：

   ```bash
   asmgr list --agent copilot
   ```

3. 从第二列复制一个 session id。
4. 生成 HTML：

   ```bash
   asmgr html <session-id> --agent copilot -o report.html
   ```

5. 用浏览器打开 `report.html`。

HTML 文件是自包含的：搜索、筛选、可折叠条目、侧栏目录、紧凑模式、主题切换、Markdown 表格、数学渲染都离线可用。

## CLI 命令

### `asmgr list`

以 tab 分隔的行打印发现的会话：

```bash
asmgr list --agent all
asmgr list --agent claude --claude-root /path/to/claude/projects
```

用 `--by project` 或 `--by agent` 分组（默认平铺）。project 取会话记录 cwd 最近的、含 `.git/` 的祖先目录（仅当该 cwd 在本机存在时才探测文件系统）；cwd 存在但找不到 `.git` 祖先、或该路径不在本机时，按记录的 cwd 原样分组；只有完全没有 cwd 的会话才归入 `(unscoped)` 桶：

```bash
asmgr list --by project     # 按仓库聚类会话
asmgr list --by agent       # 按 copilot / claude / codex 分组
```

分组模式每组打印一个 `# <组> (<数量>)` 头（组间排序，组内按最后活动时间从新到旧），随后是 `组`、`agent`、`session-id`、`最后活动`、`条目数` 的 tab 分隔行。

### `asmgr search`

搜索 user、assistant、reasoning、tool、system、event 文本：

```bash
asmgr search "database migration" --agent all --limit 20
asmgr search "database migration" --session <session-id>   # 只在一个会话里搜
```

每条命中是一行 tab 分隔、以 `project` 列（cwd 最近的含 `.git` 祖先目录；找不到 `.git` 祖先时为 cwd 原值，无 cwd 时为 `(unscoped)`）开头：`project`、`agent`、`session-id`、`#条目`、`role/kind`、`摘录`。

`--session <id>` 把搜索限定到一个会话（先精确匹配 id，否则按前缀匹配）——用来在**当前这个会话**里按关键词找模型回复，不必先用 `--file` 指路径。

### `asmgr show`

以 text、dialogue 或 JSON 打印一个会话：

```bash
asmgr show <session-id> --agent codex
asmgr show <session-id> --agent copilot --format dialogue
asmgr show <session-id> --agent codex --format json
```

`--format dialogue` 只保留**用户消息 / 用户决策（`ask_user` 的回答）/ 压缩摘要 / 助手回复**，跳过工具调用与 reasoning。工具噪音被剔掉后，每条用户 prompt 直接紧跟回答它的助手回复，prompt↔回复的对应关系一目了然——适合会话复盘、交接和收尾盘点等需要通读对话主干的场景。`--format text` 则含完整工具参数+结果、子代理/技能/计划/压缩统计。

### `asmgr html`

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
- **只存在于 live 内存的条目离线无法重建**，包括吉祥物启动横幅、临时重试提示、`/share` 成功回执。见 [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md) 与下文[「Copilot 时间线与离线映射」](#timeline-ref)。

```bash
asmgr html <session-id> --agent copilot -o report.html
asmgr html <session-id> -s agent-summary.html -o report.html   # 顶部钉一份 HTML 总结
```

### `asmgr md`

导出遵循 Copilot CLI `/share file` 约定的 Markdown（`### 💬/👤/🔧/✅` 标题、`<sub>⏱️</sub>` 耗时戳、长工具输出 `<details>` 折叠、diff 围栏、`[!NOTE]` 头块）：

```bash
asmgr md <session-id> --agent copilot -o report.md
asmgr md <session-id> --no-reasoning -o report.md             # 去掉 reasoning 条目
asmgr md <session-id> -s summary.md -o report.md              # 注入一份 markdown 总结
```

### `asmgr backup`

`backup` 是一个命令组：

```bash
asmgr backup run --dry-run     # 预览 restic 备份
asmgr backup run               # 运行 restic 备份封装（backup.sh）
asmgr backup                   # `backup run` 的向后兼容别名
asmgr backup cache latest --target ~/.cache/asmgr/restic-cache   # 把一个快照恢复进缓存目录
```

`backup cache` 把 agent 历史从 restic 快照恢复进一个**本地缓存目录**（绝不恢复进 live 的 `~/.copilot`、`~/.claude`、`~/.codex`——那会被拒绝），之后读命令可用 `--file` 在其上工作（未来还有 `--source cache`）。加 `--host <h>` 钉某主机的快照，`--dry-run` 只预览、不实际恢复。

备份是未来检索 / 搜索工作的一个数据源。当前搜索读 live 本地历史；对恢复出来的备份缓存做**持久化**索引单独跟踪（issue #1）。今天要临时用，就恢复一个快照，再用 `--file` 让任意读命令指过去：

```bash
restic restore latest --target /tmp/cache          # 恢复一个快照
asmgr search "关键词" --file /tmp/cache           # 搜索恢复出来的缓存
asmgr html <session-id> --file /tmp/cache -o s.html
```

## 从 live 目录之外读取会话

`--file <path>`（别名 `--events <path>`）让 `list` / `search` / `show` / `html` / `md` 读一个显式路径，而不是 `~/.copilot`、`~/.claude`、`~/.codex`：

```bash
# 从别的机器拷来的单个会话文件（agent 自动探测）
asmgr show --file ~/dl/events.jsonl --format json
asmgr html --file ~/dl/events.jsonl -o report.html

# 整个目录（遍历 *.jsonl；每个文件各自探测 agent）
asmgr list --file /tmp/restored-cache
asmgr search "migration" --file /tmp/restored-cache
```

`--file` 指向单个文件时，`<session-id>` 参数可省。指向的目录若产出多个会话，传一个 `<session-id>` 挑一个（用 `asmgr list --file <dir>` 看 id）。

## 术语

- **会话（Session）**：agent CLI 持久化的一次对话，可由 UUID、JSONL 路径，或某 agent 本地数据库中的一行标识。
- **agent 适配器（Adapter）**：知道如何发现并解析某一家 agent 持久化格式的代码。当前适配 GitHub Copilot CLI、Claude Code、OpenAI Codex CLI。
- **事件（Event）**：agent 持久化流里的一条原始记录。Copilot 的事件存在 `events.jsonl`，是离线时间线重建的输入，而非 live `/share html` 直接渲染的对象。
- **时间线条目（Timeline entry）**：时间线里的一个展示单元（用户消息、助手回复、reasoning 块、工具调用等）。Copilot 把 live 条目放内存里；`asmgr` 从持久化事件重建规范化条目，供搜索与渲染共用。
- **归档（Archive / 只读检索）**：`asmgr` 只读地取回历史会话——搜索、文本显示、JSON 导出、给人看的 HTML/Markdown。归档**从不**把会话恢复回原 agent 的 live 状态。
- **恢复（Restore）**：忠实重建**可 `--resume` 的原生会话状态**（规划中）。**归档 ≠ 恢复**：报告不可反推回可续聊的原生态。
- **归档源（Archive source）**：可读取会话文件的地方——包括 live 本地 agent 目录，以及从 restic 恢复出来的备份缓存。

## 设计文档（ADR）

重要决策的理念记录在 [`docs/adr/`](docs/adr/)：

- [ADR 0001](docs/adr/0001-scope-archive-and-restore.md) —— 范围、双面能力与"归档 ≠ 恢复"。
- [ADR 0002](docs/adr/0002-single-package-asmgr-distribution.md) —— 单一 `asmgr` 包、能力而非产品、分发与发布。
- [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md) —— 归档侧：从 `events.jsonl` 离线重建的保真度模型。
- [ADR 0004](docs/adr/0004-restore-fidelity-and-safety.md) —— 恢复侧：忠实迁移的保真度与破坏性操作安全。

## <a id="timeline-ref"></a>Copilot 时间线与离线映射（参考）

> 为什么这样设计（内存 timeline vs 离线重建、单点映射风险、有意的离线扩展）见 [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md)；这里是具体清单与坑。

**两种表示**：Copilot `/share html` 渲染 live 内存 timeline（`session.getTimelineEntries()`），不直接读 `events.jsonl`；timeline 为空时官方 bundle 只打印 `The session is empty.`。`asmgr` 离线只读 `events.jsonl` 重建。Compaction 可能在某个 event-id 边界截断 / 重写持久化流（确切边界随 Copilot 版本，需复验）。

**官方 12 类筛选**：`user`、`copilot`、`tool`、`reasoning`、`info`、`warning`、`error`、`group`、`notification`、`handoff`、`compaction`、`task_complete`。`asmgr` 另加 `subagent`、`skill`、`plan`，并可在时间线顶部钉一张总结卡片——这些是超出官方集的有意扩展。与官方不同，`asmgr` 默认展开单行 info（模型切换 / 用户取消），多行 info 仍折叠。

**离线不可重建的数据**（只在 live 内存、从不落盘，是硬限制而非 bug）：吉祥物启动横幅、`/share` 成功回执（`Session shared successfully to: …`）、临时重试提示。

**操作坑**：
- 当前 Copilot session id 是 `~/.copilot/session-state/<id>/` 的**目录名**，别因为某个 id 出现在对话正文里就复制它。
- live `session-store.db` 常滞后最新一两轮——最近一轮可能还没进库，对当前会话导出是有损兜底。

**原始事件三态策略**（解析器把每个原始事件归为 handled / 有意忽略 / unknown；计数与 `unknownTypes` 见 `src/core/adapters/copilot.ts`）：
- **handled**：产出条目、更新元数据或与另一事件配对。当前族含 `session.start`、`user.message`、`assistant.message`、`tool.execution_start`、`tool.execution_complete`、`system.notification`、`session.info`、`abort`、error/warning 类、`handoff`、compaction 起止、`task_complete`、subagent 生命周期、`skill.invoked`、`session.plan_changed`。
- **有意忽略**：类型已知但不应生成离线条目。`session.model_change` 让位于面向用户的 `session.info`（`infoType=model`）；其余有意丢弃：`session.resume`、`session.shutdown`、`session.mode_changed`、`session.context_changed`、`session.workspace_file_changed`、`session.binary_asset`、`session.permissions_changed`、`session.schedule_*`、`session.truncation`、`session.usage_checkpoint`、所有 `hook.*` 与 `assistant.turn_*`、`system.message`。
- **unknown**：无映射也无显式忽略规则——unknown 计数是漂移警报，Copilot 变更时应排查。

**置信度**：`getTimelineEntries()` 用法、空会话消息、12 类筛选、`reasoningText` 不对称、上列 live-only 条目——置信度高；compaction 时的文件截断机制置信度较低，需对新版本复验。Copilot 升级后重跑[漂移探针](#drift-oracle)并查 unknown 诊断。

## 备份配置

`asmgr backup`（`backup.sh` 的薄封装）用 [restic](https://restic.net) 对 agent 历史做加密、去重、增量备份。部署相关的值（restic 仓库 URL、凭据、到存储后端的确切网络路径）都放在 `secrets.env`（gitignore、`600`）——不进被跟踪的文件，让仓库里没有内网 IP / 主机名（见下文[「公开前的安全检查」](#safety)）。

### 备份什么

`backup.sh` 读 `BACKUP_AGENT_DIRS`（默认 `~/.copilot:~/.claude:~/.codex`），备份其中存在的 agent 主目录。以 Copilot（`~/.copilot`）为例：

| 路径 | 典型大小 | 是什么 | 是否备份 |
|---|---|---|---|
| `session-state/<id>/events.jsonl` | 大（合计 GB 级） | 持久化的每会话事件流——resume 时回放、并被 `asmgr` 映射成离线条目 | ✅ 核心 |
| `session-state/<id>/{checkpoints,files,research}/` | 中小 | 每会话产物（检查点、附件、research 笔记） | ✅ |
| `session-store.db` | 数十 MB | 全会话的 SQLite 索引（摘要、turns、文件 / 引用索引、FTS） | ✅ —— 先 checkpoint WAL 保证副本自洽 |
| `session-store.db-wal` / `-shm` | 小 | SQLite WAL / 共享内存（热文件） | ❌ 排除（`exclude.txt`） |
| `*.lock`（如 `inuse.<pid>.lock`） | 极小 | 运行时锁文件 | ❌ 排除（`exclude.txt`） |
| `logs/` | 很大（GB 级） | CLI 进程日志 | ❌ 始终排除（`backup.sh` 里）——量大、恢复价值低 |
| `session-state/<id>/rewind-snapshots/` | 大（GB 级） | 支撑 `/rewind` 撤销功能的快照 | ⚠️ 可选——`BACKUP_EXCLUDE_REWIND=1` 时排除 |
| `config.json`、`settings.json`、`mcp-config.json`、`servers/` | 极小 | CLI + MCP 配置 | ✅ |

Claude Code（`~/.claude`）与 Codex（`~/.codex`）主目录存在时整体备份。

**`rewind-snapshots/` 为什么可选**：Copilot 的 `/rewind` 靠 `~/.copilot/session-state/<id>/rewind-snapshots/`（一个 `index.json` 加快照数据）撤销本会话的编辑。设 `BACKUP_EXCLUDE_REWIND=1` 把它们排除——省的空间比任何单项排除都多，且**不影响** `/share html`、`--resume`、`asmgr`（后两者从始终备份的 `events.jsonl` 重建）；唯一失去的是对**恢复出来的**会话执行 `/rewind` 的能力。

### 端到端加密与架构

restic 跑在**客户端**，在数据离开主机前做**端到端 AES-256 加密**，再写入 **S3 兼容端点**（`RESTIC_REPOSITORY=s3:<endpoint>/<bucket>`；任何 restic 后端都行——rustfs / MinIO / SeaweedFS / AWS S3 / B2 / R2 / 本地路径 / sftp / rest）。后端只见密文，存储主机被攻破也不暴露你的历史。

反面：`RESTIC_PASSWORD` 是整个仓库**唯一**的钥匙——丢了它，所有快照永久不可读。`restic init` 后立刻把它抄进密码管理器 / 另一台设备。

到端点可能要过若干网络跳转（如 mesh 覆盖网 → 主机端口代理 → WSL2 端口转发 → 容器端口）；这条跳转链是部署相关、含内网地址的，记在 `secrets.env` 头部注释里而**非**本文件——换机重新部署时只改 `secrets.env`，`backup.sh` / `exclude.txt` / 本文都是通用的。

### 配置与运行

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
asmgr backup run --dry-run
asmgr backup run
```

把 `RESTIC_PASSWORD` 存进密码管理器或另一台设备。丢了它，加密备份就再也读不出来。

### 保留策略

每次运行给快照打 `agent-session-manager` + `$(hostname)` 标签，然后：

```
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

> 迁移注记：快照标签历经 `session-recall` → `agent-session-exporter` → `agent-session-manager`。若把新 checkout 指向已有仓库，先对齐标签（如 `restic tag --set agent-session-manager --tag agent-session-exporter`，或加匹配的 `--keep-tag`），让 `forget` 按预期血缘 prune、而非遗弃旧快照。

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

> 只应有**一台**机器拥有该 timer。若从旧部署迁来（unit 曾指向别的 checkout、或快照打的是旧标签如 `session-recall`），先禁用并删掉旧 unit（`systemctl --user disable --now <old>.timer` 再删文件），以免跑两份备份或把保留血缘劈成两半。

## 目录结构

`asmgr` 是**一个** npm 包；下面的 `src/*` 是它的内部模块（相对 import 串联），不是各自发布的包。

| 路径 | 用途 |
|---|---|
| `src/core` | agent 发现、解析器、规范化时间线模型、搜索 |
| `src/markdown` | 遵循 Copilot `/share file` 约定的 Markdown 渲染器 |
| `src/html` | 基于 React 的单文件 HTML 渲染器，高度复刻 Copilot `/share html` |
| `src/cli` | `asmgr` 命令（commander 程序、各子命令、选项解析） |
| `scripts` | esbuild 单文件打包、bun 原生二进制、构建期资源内联（gen-assets） |
| `fixtures` | 脱敏的解析器与 CLI fixtures |
| [`tools/copilot`](tools/copilot/) | Copilot `/share` bundle 漂移探针（仅逆向研究，非运行时依赖） |
| `backup.sh` | `asmgr backup` 用的 restic 封装 |

### <a id="drift-oracle"></a>漂移探针（`tools/copilot`）

`tools/copilot/extract-share-assets.cjs` 是逆向研究辅助，**不在 `asmgr` 的渲染路径里**。它读取已安装的 `@github/copilot` 的 `app.js` bundle，重建其 JS 模板字符串里的运行时字符串，写出 `share-export.css` / `share-export.js`（**重建**而非逐字节复制——否则会保留双重转义、产出坏 CSS/JS）：

```bash
node tools/copilot/extract-share-assets.cjs [path/to/@github/copilot/app.js] [out-dir]
```

**为什么保留**：它是**漂移探针**。Copilot 升级可能改动时间线条目 / 筛选类、Primer 明暗主题规则、按钮 id 等 DOM 钩子。升级后重跑并 diff 上一次输出，把有意义的变化当作"复核离线事件映射与 React 渲染器"的提示，而不是自动搬进产物。维护中的 HTML 渲染器是 `src/html` 的 React 实现，不 import 也不发布这些抽取资产；仓库里目前没有大小 / 哈希基线，可在下次比较时记录探针打印的长度与本地校验和。

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

### 与同类项目的差异

- **GitHub Copilot CLI 是一等适配器。** 上面的项目目前都不解析 `~/.copilot/session-state/*/events.jsonl`。
- **产物贴近 Copilot CLI `/share file` 与 `/share html` 约定，但不声称完全等价。** 熟悉的 Primer 样式、筛选概念、emoji 前缀的 Markdown 标题、耗时戳、`<details>` 折叠、diff 围栏都延续下来。HTML 渲染器用 React 而非官方 vanilla bundle，额外加了子代理/技能/计划与总结条目，用 Shiki 与 24 小时制，且无法重建只存在于 live 内存的条目。见 [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md)。
- **单文件 HTML 是默认交付物。** ~1 MB，无服务器、无构建，双击即开。（多数同类发 Tauri app、Express/FastAPI web app 或 TUI；唯二的静态 HTML 同类是 Simon 的 `claude-code-transcripts`（仅 Claude）和 `daaain/claude-code-log`（仅 Claude）。）
- **单一自包含产物，安装摩擦低。** 一个无 scope 的 npm 包 `asmgr`（命令同名）：`npm i -g asmgr`、免 Node 的原生二进制、或 `npm i -g github:` 免 registry 一行装。解析器与渲染器是包内模块，不额外发布独立包。
- **不耦合 live agent SDK。** 只读，正常运行不调用任何 Anthropic / OpenAI / GitHub API；没有 `claude-code-viewer` 那样要应对的 ToS 面。

### 从同类项目借鉴

这些灵感项都作为 GitHub issue 跟踪（每条写明 `Inspired by …`），见 [issues](https://github.com/TMYTiMidlY/agent-session-manager/issues)：项目层级索引页（`claude-code-log`）、Token / 成本分析视图（`token-dashboard`）、实时 tail 模式（`claude-code-trace` / `tail-claude`）、按项目分组侧栏（`agent-session-viewer` / `codex-history-viewer`）、VS Code 扩展封装（`codex-history-viewer`）、Pages 静态导出 tarball（`claude-code-transcripts`）。

## <a id="safety"></a>公开前的安全检查

把本仓库推到任何公开位置前，只检查被跟踪的文件：

```bash
git ls-files
git grep -nE 'PRIVATE|SECRET|TOKEN|PASSWORD|AKIA|/(h[o]me|Users)/|10\\.|192\\.168\\.|172\\.|D[E]SKTOP|[Ww]orkstation'
```

`secrets.env`、`backup.log`、`node_modules/`、构建产物都被忽略，应保持未跟踪。

## <a id="roadmap"></a>路线图

待办与灵感项都在 [GitHub issues](https://github.com/TMYTiMidlY/agent-session-manager/issues) 跟踪。两条值得单独点名的方向：

- **忠实恢复 / 迁移**：把会话恢复到"另一台机器能 `--resume`"的原生状态（来源 = 备份快照 ∪ 另一台机器）——理念见 [ADR 0001](docs/adr/0001-scope-archive-and-restore.md) 与 [ADR 0004](docs/adr/0004-restore-fidelity-and-safety.md)。
- **本地 Web 界面 `asmgr web`**：本机启动、仅供自己查看、默认只绑 `127.0.0.1` 的会话浏览界面，随同一个包分发——见 [ADR 0002](docs/adr/0002-single-package-asmgr-distribution.md)。

单文件分发与 npm 发布**已实现**（单一无 scope 包 `asmgr`、四平台原生二进制、semantic-release、`npm i -g github:` 免 registry 安装）——详见[安装](#install)。其余（持久化索引搜索恢复出来的备份、提升适配器保真度、项目层级索引页、Token / 成本视图、实时 tail、VS Code 扩展、Pages 导出 tarball、跨多会话仪表盘）见 issues。
