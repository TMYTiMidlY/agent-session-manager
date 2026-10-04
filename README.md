# asmgr

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.x-f69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

**把编码 agent 的 CLI 会话与公开 ChatGPT 分享导出成 Markdown 或单文件 HTML。** `asmgr`（Agent Session ManaGeR）读取 GitHub Copilot CLI、Claude Code、OpenAI Codex CLI、DeepSeek Harness（DSH）写在本地的会话历史，也可捕获公开 ChatGPT `/share/` 页面，再把选定的会话导出成自包含报告；来源无法完整保留的内容会显式标记。它是**一个**无 scope 的公开 npm 包，命令也叫 `asmgr`；HTML 与 Markdown 是它的导出能力，而非独立发布的产品。

HTML 产物高度复刻 Copilot CLI 内置 `/share html` 的排版（Primer 主题、sticky header、类型筛选 pill、侧栏目录、上一条/下一条用户消息跳转、搜索），差异见 [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md)。Markdown 产物遵循 Copilot CLI `/share file` 的结构与约定（`### 💬/👤/🔧/✅` 标题、`<sub>⏱️</sub>` 耗时戳、`<details>` 折叠、diff 围栏、`[!NOTE]` 头块）。

它对 agent 状态目录**只读**：不写 `.copilot`、`.claude`、`.codex`、`.dsh`。传本地 session id 或 `--file` 时，`list` / `search` / `show` / `html` / `md` 都严格本地。只有显式导入或直接读取 ChatGPT 分享 URL，以及按配置访问 restic 仓库的 `backup` 命令会联网。

> **归档 ≠ 恢复。** 导出的报告是有损、只读、给人看的产物，**不能**反推回可 `--resume` 的原生会话。把会话忠实恢复到"另一台机器能续聊"是一条**规划中**的独立能力（来源 = 备份快照 ∪ 另一台机器），与只读归档严格分层——理念见 [ADR 0001](docs/adr/0001-scope-archive-and-restore.md)。

## 功能

| 目标 | 命令 |
|---|---|
| 列出已知会话 | `asmgr list --agent all` |
| 搜索本地历史 | `asmgr search "关键词" --agent all` |
| 在单个会话内搜索 | `asmgr search "关键词" --session <session-id>` |
| 打印一个会话 | `asmgr show <session-id> --agent claude` |
| 只看对话主干（跳过工具调用） | `asmgr show <session-id> --format dialogue` |
| 导入公开 ChatGPT 分享 | `asmgr import 'https://chatgpt.com/share/<id>'` |
| 直接读取 ChatGPT 分享主干 | `asmgr show 'https://chatgpt.com/share/<id>' --format dialogue` |
| 导出 Markdown（Copilot `/share file` 风格） | `asmgr md <session-id> -o session.md` |
| 导出 HTML（高度复刻 `/share html`） | `asmgr html <session-id> -o session.html` |
| 直接把 ChatGPT 分享导出 HTML | `asmgr html 'https://chatgpt.com/share/<id>' -o session.html` |
| 读取任意位置的会话文件（scp 来的 / 恢复出来的） | `asmgr html --file /path/to/events.jsonl -o session.html` |
| 搜索任意位置的会话目录 | `asmgr search "关键词" --file /path/to/sessions` |
| 运行加密增量备份 | `asmgr backup run --dry-run` |
| 把备份快照恢复到隔离缓存 | `asmgr backup cache latest --target ~/.cache/asmgr/restic-cache` |

## 支持的 agent 与数据来源

- **Copilot CLI**：读取 `~/.copilot/session-state/*/events.jsonl`；同时用 `~/.copilot/session-store.db` 列出会话与元信息。events.jsonl 缺失（老会话被 prune、或只迁移了 DB）时回退到 DB 的 `turns` 表（lossy：只有 user/assistant 文本，工具与用户决策不可恢复）。所有读命令可用 `--copilot-db <path>` 覆盖 DB 路径。
- **Claude Code**：读取 `~/.claude/projects/**/*.jsonl`
- **Codex CLI**：读取 `~/.codex/sessions/**/*.jsonl`
- **DeepSeek Harness（DSH）**：读取 `${DSH_HOME:-~/.dsh}/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`；用 `--dsh-root <path>` 覆盖会话根目录。目录发现选择每个会话的最高版本文件；`--file` 指向单个文件时读取指定版本。
- **ChatGPT 公共分享**：`asmgr import <url>` 从 `/share/<id>` 页面的 React Router 水合数据读取
  `linear_conversation`。默认托管目录中的快照会自动进入 `list/search/show/html/md`；
  也可把 URL 直接传给 `show/html/md`，不落盘使用。

每个读命令（`list` / `search` / `show` / `html` / `md`）都接受 `--file <path>`（别名 `--events <path>`），读一个显式的 `*.jsonl` / DSH `*.jsonl.zstd` / `*.chatgpt-share.json` 文件——或一个会被遍历出这些文件的目录——而不是 live agent 主目录。每个文件的 agent 格式自动探测（用 `--agent` 覆盖）。未知 JSON 会明确报错，不再静默显示成空会话。

### DSH 读取与主干

**默认自动使用 DSH home，无需传 `--dsh-root`。** 会话目录优先级为：显式 `--dsh-root` → 环境变量 `DSH_HOME` 下的 `sessions/` → 当前用户的 `~/.dsh/sessions/`。`--dsh-root` 仅用于覆盖会话日志根目录，例如读取备份；它不是 DSH 源码目录，也不是项目工作目录。

```bash
asmgr list --agent dsh
asmgr show <session-id> --agent dsh --format dialogue
asmgr show --file /path/to/session.jsonl.zstd --format dialogue
asmgr html <session-id> --agent dsh -o dsh-session.html
```

DSH 读取采用**独立的只读转录解析器**，不再把归档恢复成可运行的 DSH Session，也不依赖或打包 DSH 的 codec/runtime 包。解析器区分字节与压缩、JSONL 事件信封、可见消息投影三个边界；保留 v0–v4 的已知布局，包括旧版平铺消息、packed 流片段、steering/compact/code-dispatch 别名、v3 工具结果包装与 v4 一等 tool-role 结果。子代理描述、团队状态等非转录元数据按事件名有意忽略，**descriptor 子格式升级不会阻止读取对话**；不检查这些 payload 的私有版本，不改写源日志，不加载本机 DSH 或启动插件。

主干包含直接用户输入、助手正文，以及原生或 PTC 调用中 `ask_user_question` 的题目、全部选项与匹配的回答；普通工具的参数和结果完全不显示。回答须有可验证的调用关联与完整问答格式：显式来源失效、重复标识或序号造成歧义、PTC 开始/结束的身份或参数不一致时不推断用户决策。

范围保持有限：不递归提取未知插件事件、注入上下文、失败模型尝试或任意 `meta` 的正文；所有具名非 `user` 来源都保持 model-only，不因 `role: user` 就当成人类输入。只显示最终追加消息，packed/embedded 流片段不会重复变成正文；不把压缩 replacement 当成新对话，不重复拼接 fork 的父会话，也不在 `session/end-seed` 处截断后续历史。只显示已知 compact checkpoint 对应的摘要。图片/文件只显示占位符并提示损失；完整工具仍在 text/HTML/Markdown 中保留。HTML/Markdown 暂无独立的主干导出开关。

**兼容策略不是“版本号超出上限就拒读”。** 新版本 header 仍满足已知 JSONL 信封时，继续读取可识别的消息，并标记尚未验证新版本语义；未知事件、内容块、surface 操作和畸形记录产生局部诊断，不丢弃后续可读消息。`show --format json` 的 `diagnostics` 包含 `formatVersion`、处理/忽略/未知计数、未知类型样本及 `issues`（代码、首个非空记录序号、存储 seq、次数；不包含原始 payload）。诊断样本和类型名称有大小上限，省略会明确标记。缺失/未解释内容通过 `source.lossy` 与具体 `source.warning` 暴露：text、dialogue、HTML、Markdown 都显示警告，search 即使没有命中也在 stderr 报出路径与警告。

这不保证任意未来格式都无需维护：如果压缩算法、信封或实际消息布局发生不兼容变化，仍须扩展读取能力；不把新布局猜成旧布局或声称转录完整。新增无关元数据或 descriptor 版本不要求手动升级 pin。压缩日志需要运行时提供 Zstandard API（Node.js ≥ 22.15）；无法解压、无效 session 文件头、文件名/header 版本不符或同一代存在多种编码时仍明确报错。目录发现始终选最高一代，不自动回退到过期前代；`--file` 单文件始终读取指定归档。

## <a id="install"></a>安装

`asmgr` 已发布为单一、无 scope 的公开 npm 包。以下是安装已发布版本的方法；维护者推送代码前请先看[版本与发布](#release)，**普通推送 `main` 可能自动发版**。

### npm

```bash
npm i -g asmgr
asmgr list --agent all
```

各安装方式当前能力如下：

| 安装方式 | 读取、搜索、导入与导出 | `asmgr backup` |
|---|---|---|
| npm / `npm i -g github:` | ✅ | ❌ 暂未包含备份运行时 |
| 原生二进制 | ✅，但不读取 Copilot live SQLite | ❌ 暂未包含备份运行时 |
| 源码 checkout | ✅ | ✅ |

<details>
<summary>其他安装方式与运行时差异</summary>

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

</details>

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
asmgr list --by agent       # 按 copilot / claude / codex / chatgpt 分组
```

分组模式每组打印一个 `# <组> (<数量>)` 头（组间排序，组内按最后活动时间从新到旧），随后是 `组`、`agent`、`session-id`、`最后活动`、`条目数` 的 tab 分隔行。

### `asmgr search`

搜索 user、assistant、reasoning、tool、system、event 文本：

```bash
asmgr search "database migration" --agent all --limit 20
asmgr search "database migration" --session <session-id>   # 只在一个会话里搜
```

每条命中是一行 tab 分隔、以 `project` 列（cwd 最近的含 `.git` 祖先目录；找不到 `.git` 祖先时为 cwd 原值，无 cwd 时为 `(unscoped)`）开头：`project`、`agent`、`session-id`、`#条目`、`role/kind`、`摘录`。

`--session <id>` 把搜索限定到一个会话（先精确匹配 id，否则按前缀匹配；DSH 的 id 是 `session-<uuid>`，直接给裸 uuid 也可以）——用来在**当前这个会话**里按关键词找模型回复，不必先用 `--file` 指路径。

跨会话搜索对每个会话独立解析：遇到官方迁移器拒绝或损坏的存档时，在 stderr 逐条报出路径与原因后跳过，不中断其余会话的检索；stdout 的命中行不受影响。

### `asmgr import`

导入公开 ChatGPT 分享页：

```bash
asmgr import 'https://chatgpt.com/share/<conversation-id>'
```

默认写入 asmgr 托管目录，随后可直接用 session id 执行 `list/search/show/html/md`。
也可以把分享 URL 直接传给 `show/html/md`，跳过本地保存。

<details>
<summary>ChatGPT 存储路径、输出方式与保真限制</summary>

托管目录优先使用 `ASMGR_DATA_HOME`，其次使用 `XDG_DATA_HOME`；都未设置时按平台选择：

| 平台 | 默认目录 |
|---|---|
| Linux | `~/.local/share/asmgr/imports/chatgpt` |
| macOS | `~/Library/Application Support/asmgr/imports/chatgpt` |
| Windows | `%LOCALAPPDATA%\asmgr\imports\chatgpt` |

三种写入方式的后续读取不同：

| 导入方式 | 后续读取 |
|---|---|
| 默认目录 | 自动进入 `list/search/show/html/md` |
| `--chatgpt-root <dir>` | 后续读命令继续传相同的 `--chatgpt-root` |
| `-o <path>` | 用 `--file <path>` 显式读取；若改为扫描目录，文件名需以 `.chatgpt-share.json` 结尾 |

新快照权限为 `0600`；目标已存在时拒绝覆盖，确认要刷新才加 `--force`。普通 ChatGPT 页面、私有
`/c/...`、`/g/.../c/...` 地址栏会话及其它网站 URL 都不会发起抓取：检测到地址栏私有
会话链接时，会用中文明确提示先在 ChatGPT 中点击“分享”，再复制 `/share/` 链接。

捕获不启动浏览器：直接解码页面 HTML 内的 turbo-stream 水合数据。快照保留完整公开
`linear_conversation`，便于未来适配器改进后重新解析。公开页隐藏的工具结果无法恢复；
图片或附件若只有资源指针而没有内容，会显示占位符并把来源标记为 lossy。工具调用与结果
只有在同一用户轮次内存在唯一匹配时才合并，关联不明确时保留独立结果或 pending 状态。

</details>

### `asmgr show`

以 text、dialogue 或 JSON 打印一个会话：

```bash
asmgr show <session-id> --agent codex
asmgr show <session-id> --agent copilot --format dialogue
asmgr show <session-id> --agent codex --format json
asmgr show 'https://chatgpt.com/share/<id>' --format dialogue
```

`--format dialogue` 只保留**用户消息 / 交互式提问与选项 / 用户决策或回答 / 压缩摘要 / 助手回复**，跳过普通工具调用的全部内容与 reasoning。DSH 的 `ask_user_question` 保留题目、全部选项、单/多选信息、选中项和自由回答；Copilot 的 `ask_user` 保留题目、全部候选项及回答。工具噪音被剔掉后，每条用户 prompt 直接紧跟回答它的助手回复，prompt↔回复的对应关系一目了然——适合会话复盘、交接和收尾盘点等需要通读对话主干的场景。`--format text` 则含完整工具参数+结果、子代理/技能/计划/压缩统计。

### `asmgr html`

写出一份自包含 HTML 报告，支持搜索、筛选、侧栏目录、主题切换、Markdown 表格与 KaTeX 数学：

```bash
asmgr html <session-id> --agent copilot -o report.html
asmgr html <session-id> -s agent-summary.html -o report.html   # 顶部钉一份 HTML 总结
asmgr html 'https://chatgpt.com/share/<id>' -o report.html
```

<details>
<summary>HTML 与 Copilot CLI `/share html` 的差异</summary>

- **用 React 渲染，而非官方 vanilla bundle 资产。** 抽取的上游 CSS/JS 只当逆向参照，不随运行时产物发布。
- **Shiki 语法高亮**，覆盖 markdown 代码围栏与 diff 风格的工具输出，双 light+dark 主题，页面切主题时代码无需重载即重新着色。
- **24 小时制时间戳**（会话起点 `YYYY-MM-DD HH:MM:SS`；同日条目 `HH:MM:SS`，跨日 `MM-DD HH:MM:SS`）——en-US 默认的 12 小时制（`PM/AM`）太容易读错。
- **耗时 pill**，由 `startedAt` → 最后一条条目算出，显示在 header。
- **agent 总结卡片**，用 `--summary <file.html>` 钉在时间线顶部（原样渲染受信任 HTML；`data-index="summary"`，真实第 1 条仍是第 1 条）。
- **合并的工具卡片**，六种结果态（success / failure / rejected / denied / pending / redacted），配对应的边框色与状态图标。
- **`ask_user` 的回答被抽成一等「用户决策」条目**（`user/decision`）：既保留原始工具卡片，又让用户的选择/回答在时间线里单独、显眼地出现——复盘或交接时不会把决策埋没在成百上千次工具调用里。
- **子代理 / 技能 / 计划条目**，从 `events.jsonl` 解析、各自成卡片 + 筛选 pill。子代理卡片在可得时显示记录到的身份、模型、描述、失败详情。这些超出 Copilot 自身 `/share html` 的筛选集。
- **数据源回退警告 pill**，当解析器不得不读 `events.jsonl` 之外的东西时显示在 header；回退到 `db.turns` 时进一步说明「交互式用户决策与工具条目在此模式下不可恢复」。
- **默认展开策略在其余方面沿用 Copilot bundle**：`user / assistant / error / task_complete` 展开，其它折叠。
- **单行 info 条目**（模型切换 / 取消）默认展开而非折叠——与官方 bundle 不同，让「Model changed from X to Y」「Operation cancelled by user」这类一行信息一眼可见；多行 info 仍折叠。
- **只存在于 live 内存的条目离线无法重建**，包括吉祥物启动横幅、临时重试提示、`/share` 成功回执。见 [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md) 与下文[「Copilot 时间线与离线映射」](#timeline-ref)。

</details>

### `asmgr md`

导出遵循 Copilot CLI `/share file` 约定的 Markdown（`### 💬/👤/🔧/✅` 标题、`<sub>⏱️</sub>` 耗时戳、长工具输出 `<details>` 折叠、diff 围栏、`[!NOTE]` 头块）：

```bash
asmgr md <session-id> --agent copilot -o report.md
asmgr md <session-id> --no-reasoning -o report.md             # 去掉 reasoning 条目
asmgr md <session-id> -s summary.md -o report.md              # 注入一份 markdown 总结
asmgr md 'https://chatgpt.com/share/<id>' -o report.md
```

### `asmgr backup`

`backup` 是正式的 restic 备份命令组：

```bash
asmgr backup run --dry-run
asmgr backup run
asmgr backup cache latest --target ~/.cache/asmgr/restic-cache
```

`backup run` 默认备份 `~/.copilot`、`~/.claude`、`~/.codex` 与 asmgr 托管的 ChatGPT
导入目录，只处理实际存在的路径。运行时会先尽力把 Copilot 的 SQLite WAL 合入主库，
再执行加密、去重、增量备份；SQLite 热文件、锁文件和 Copilot 进程日志不会进入快照。
每次快照带 `agent-session-manager` 与当前主机标签，并应用 daily / weekly / monthly
保留策略。

`backup cache` 把指定快照恢复到独立缓存，明确拒绝 home 目录及 live 的
`~/.copilot`、`~/.claude`、`~/.codex`，也拒绝 asmgr 托管的 ChatGPT 导入目录。
缓存用于 `list/search/show/html/md --file`，不等于把会话恢复成原 agent 可以
`--resume` 的状态。

> 当前备份命令需要从源码 checkout 运行；npm 包和原生二进制尚未包含备份运行时。

<details>
<summary>备份配置与 systemd 自动运行</summary>

#### 配置

复制配置模板并限制权限：

```bash
cp secrets.env.example secrets.env
chmod 600 secrets.env
```

必填项是 `RESTIC_REPOSITORY` 与 `RESTIC_PASSWORD`；S3 兼容后端还需要
`AWS_ACCESS_KEY_ID` 和 `AWS_SECRET_ACCESS_KEY`。可用 `RESTIC_BIN` 覆盖 restic
位置、用 `BACKUP_AGENT_DIRS` 调整数据源、用 `BACKUP_EXCLUDE_REWIND=1` 排除
Copilot rewind 快照。通过 `--chatgpt-root` 或 `-o` 放到其它位置的 ChatGPT 快照不会
自动进入备份，需要显式加入 `BACKUP_AGENT_DIRS`。

新仓库先加载配置并初始化，再运行备份：

```bash
set -a; source secrets.env; set +a
restic init
asmgr backup run --dry-run
asmgr backup run
```

`RESTIC_PASSWORD` 是读取所有快照的唯一密钥，初始化后必须保存到密码管理器或另一台设备。

#### 自动运行

`systemd/` 提供 user service 与 timer 示例，每天运行一次，并用随机延迟避免整点拥塞；
`Persistent=true` 会在机器重新启动后补跑错过的任务。复制示例后按源码 checkout 和日志
位置调整 service，再启用 timer：

```bash
mkdir -p ~/.config/systemd/user
cp systemd/agent-session-manager.service.example ~/.config/systemd/user/agent-session-manager.service
cp systemd/agent-session-manager.timer.example ~/.config/systemd/user/agent-session-manager.timer
systemctl --user daemon-reload
systemctl --user enable --now agent-session-manager.timer
```

同一个 restic 仓库只应由一台机器负责定时运行。需要在登出后继续执行时，为该用户启用
systemd lingering。

</details>

## 从 live 目录之外读取会话

`--file <path>`（别名 `--events <path>`）让 `list` / `search` / `show` / `html` / `md` 读一个显式路径，而不是 live agent / import 主目录：

```bash
# 从别的机器拷来的单个会话文件（agent 自动探测）
asmgr show --file ~/dl/events.jsonl --format json
asmgr html --file ~/dl/events.jsonl -o report.html
asmgr show --file ~/dl/conversation.chatgpt-share.json --format dialogue

# 整个目录（遍历 *.jsonl / *.chatgpt-share.json；每个文件各自探测 agent）
asmgr list --file /tmp/session-archive
asmgr search "migration" --file /tmp/session-archive
```

`--file` 指向单个文件时，`<session-id>` 参数可省。指向的目录若产出多个会话，传一个 `<session-id>` 挑一个（用 `asmgr list --file <dir>` 看 id）。

## 术语

- **会话（Session）**：agent CLI 持久化的一次对话，可由 UUID、JSONL 路径，或某 agent 本地数据库中的一行标识。
- **agent 适配器（Adapter）**：知道如何发现并解析某一家 agent 持久化格式的代码。当前适配 GitHub Copilot CLI、Claude Code、OpenAI Codex CLI 与 ChatGPT 公共分享快照。
- **事件（Event）**：agent 持久化流里的一条原始记录。Copilot 的事件存在 `events.jsonl`，是离线时间线重建的输入，而非 live `/share html` 直接渲染的对象。
- **时间线条目（Timeline entry）**：时间线里的一个展示单元（用户消息、助手回复、reasoning 块、工具调用等）。Copilot 把 live 条目放内存里；`asmgr` 从持久化事件重建规范化条目，供搜索与渲染共用。
- **归档（Archive / 只读检索）**：`asmgr` 只读地取回历史会话——搜索、文本显示、JSON 导出、给人看的 HTML/Markdown。归档**从不**把会话恢复回原 agent 的 live 状态。
- **恢复（Restore）**：忠实重建**可 `--resume` 的原生会话状态**（规划中）。**归档 ≠ 恢复**：报告不可反推回可续聊的原生态。
- **归档源（Archive source）**：可读取会话文件的地方——包括 live 本地 agent 目录，以及通过 `--file` 显式指定的文件或目录。

## 设计文档（ADR）

重要决策的理念记录在 [`docs/adr/`](docs/adr/)：

- [ADR 0001](docs/adr/0001-scope-archive-and-restore.md) —— 产品范围与"归档 ≠ 恢复"。
- [ADR 0002](docs/adr/0002-single-package-asmgr-distribution.md) —— 单一 `asmgr` 包与统一命令入口。
- [ADR 0003](docs/adr/0003-archive-reconstruction-fidelity.md) —— 归档数据的规范化与保真度。

<details>
<summary>实现参考：Copilot 时间线、目录结构与漂移探针</summary>

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

### <a id="drift-oracle"></a>漂移探针（`tools/copilot`）

`tools/copilot/extract-share-assets.cjs` 是逆向研究辅助，**不在 `asmgr` 的渲染路径里**。它读取已安装的 `@github/copilot` 的 `app.js` bundle，重建其 JS 模板字符串里的运行时字符串，写出 `share-export.css` / `share-export.js`（**重建**而非逐字节复制——否则会保留双重转义、产出坏 CSS/JS）：

```bash
node tools/copilot/extract-share-assets.cjs [path/to/@github/copilot/app.js] [out-dir]
```

**为什么保留**：它是**漂移探针**。Copilot 升级可能改动时间线条目 / 筛选类、Primer 明暗主题规则、按钮 id 等 DOM 钩子。升级后重跑并 diff 上一次输出，把有意义的变化当作"复核离线事件映射与 React 渲染器"的提示，而不是自动搬进产物。维护中的 HTML 渲染器是 `src/html` 的 React 实现，不 import 也不发布这些抽取资产；仓库里目前没有大小 / 哈希基线，可在下次比较时记录探针打印的长度与本地校验和。

</details>

<details>
<summary>同类项目调研与差异</summary>

## 同类项目对比

这个问题空间已有多种 CLI、TUI、Web 与桌面实现。下表是 2026-07-24 整理文档时的调研快照；
Stars 只反映当时状态，不作为持续更新的排名。

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

</details>

## <a id="release"></a>维护者：版本与发布

> **推送 `main` 不等于“只同步代码”。** 当前使用 **semantic-release** 自动推导并发布版本，
> 不是维护者先运行 `cz bump` 再推 tag。发布前必须检查上次发布以来的**全部提交**，不能只看本次提交的类型。

操作规则以 [`release.yml`](.github/workflows/release.yml)（触发条件、测试与权限）和
[`.releaserc.json`](.releaserc.json)（提交分析、版本写回、构建与发布插件）为准。

### 什么操作会启动发布

| 操作 | 当前行为 |
|---|---|
| 向 `main` 推送，或合并 PR 使 `main` 更新 | 自动运行 `release` 工作流：安装依赖 → `pnpm test` → `semantic-release`；没有按文件路径过滤，纯文档推送也会启动 |
| 在 GitHub Actions 手动运行 `release`，选择 `main` | 运行同一条发布流水线；**不是预演**，也不强制一定产生新版本 |
| 只在本地 commit、推送非 `main` 分支、仅创建 PR，或单独推 tag | 不触发当前发布工作流；semantic-release 的发布分支也仅配置了 `main` |

**启动工作流 ≠ 一定发版。** 测试通过后，semantic-release 分析上个发布 tag 到本次运行提交之间的
提交记录；没有符合发布规则的提交时，不生成新版本。有可发布变更且验证、构建等步骤成功时，就会实际发布。

### 提交如何决定版本

当前未自定义 `releaseRules` 或解析器，使用默认 Angular 风格的提交解析（如 `fix(parser): ...`）：

| 提交内容 | 版本变化（以上一版 `0.2.0` 为例） |
|---|---|
| `fix: ...`、`perf: ...` | patch → `0.2.1` |
| `feat: ...` | minor → `0.3.0` |
| 正文或页脚含 `BREAKING CHANGE: ...` | major → `1.0.0`，不会因仍处于 `0.x` 自动降为 minor |
| 被解析为 revert 的回退提交 | 默认 patch；在分析区间内成功匹配的原提交与回退会被成对过滤 |
| 普通 `docs:`、`chore:`、`ci:`、`test:`、`refactor:` 等，不含破坏性变更说明 | 自身不要求发布 |

同一分析区间按**最高级别**决定一个版本，而非每条提交各发一版。破坏性变更请使用明确的
`BREAKING CHANGE:` 正文或页脚，**不要只写 `feat!:` / `fix!:`**：当前默认解析器不凭标题中的 `!` 识别破坏性变更。

“本次只有 `docs:`”**不保证不发版**：如果此前有尚未发布的 `fix:` / `feat:`，本次运行仍会把它们纳入分析。
发布的是本次运行所检出的完整源码，不是只打包触发版本升级的那几条提交；CHANGELOG 则按提交规则生成摘要。

### 版本、标签和产物由谁生成

日常维护不要用 `cz bump`、`npm version`、手工改 `package.json` 版本或手工打发布 tag 来推动发版。
semantic-release 以 Git 发布历史为依据，在 CI 中自动完成：

1. 推导下个版本并生成 release notes，更新 `CHANGELOG.md` 与 `package.json` 的版本。
2. 构建 Node 单文件 bundle、Linux x64 / macOS Intel / macOS Apple Silicon / Windows x64 四平台二进制及 `SHA256SUMS.txt`。
3. 将 `package.json` 和 `CHANGELOG.md` 以 `chore(release): X.Y.Z [skip ci]` 提交回 `main`，并创建、推送 `vX.Y.Z` tag。
4. 发布公开 npm 包 [`asmgr`](https://www.npmjs.com/package/asmgr)，创建 [GitHub Release](https://github.com/TMYTiMidlY/agent-session-manager/releases)，附上 notes、二进制、Node bundle 和校验和。

npm 发布走 OIDC Trusted Publishing（`npmjs` environment），GitHub 操作使用工作流的 `GITHUB_TOKEN`。
它是直接发布，不是先生成等待人工确认的 npm 暂存版本。

### 只推代码：优先使用非 `main` 分支

不准备发布时，将提交保留在工作分支并只推该分支，例如：

```bash
# 从当前提交创建工作分支；分支名按需替换
git switch -c work/my-change
# 在该分支完成提交后，只推当前分支，不更新 main
git push -u origin HEAD
```

合并该分支到 `main` 仍可能发版，合并前需要重新确认发布范围。

如果确实要把代码推到 `main`，但只想跳过**这次 push** 的工作流，可在提交消息中加 `[skip ci]`
（例如 `fix: handle large sessions [skip ci]`）。注意：

- 它跳过匹配的 `push` / `pull_request` 工作流，**测试也会跳过**；不会取消已启动的运行，也不阻止手动 `workflow_dispatch`。
- 它不是 semantic-release 的“永不发布此提交”标记。该修复仍在上个 tag 之后，下一次未跳过的 `main` 推送或手动发布仍会分析并可能发布它。
- 因而它只适合临时跳过一次触发，不能作为长期发布闸门，也不能防止其他维护者后续推送带出该变更。

### 明确批准一次发布

1. 维护者先核对目标 `main` 提交 SHA、上个发布 tag 之后的全部变更与预期版本，确认这些内容都允许公开发布。
2. 明确批准后，再向 `main` 普通推送 / 合并以启动自动发布；若待发布提交已在 `main`（例如此前用了 `[skip ci]`），
   可在 GitHub Actions → `release` → **Run workflow** 选择 `main`，或执行：

   ```bash
   # 真正启动发布，不是 dry-run；只在明确批准后执行
   gh workflow run release.yml --ref main
   ```

3. 检查运行结果，以及回写的版本 / CHANGELOG、`vX.Y.Z` tag、npm 版本和 GitHub Release 附件。手动运行没有绕过提交分析；无可发布变更时仍不会发新版本。

**“单独提交”只授权本地 commit，不包含 push 或发布；“只推代码”应使用非 `main` 分支。**
自动化助手执行可能发版的 `main` 推送 / 合并或手动运行前，必须说明发布影响并取得维护者明确同意。

当前工作流没有 `publish=true` 一类的二次确认输入；`environment: npmjs` 本身也**不代表已有人工审批**，
是否等待审批取决于仓库 Settings → Environments → `npmjs` 的保护规则。若需要每次都强制人工批准，
应在那里配置 required reviewers（以仓库支持情况为准），或另行修改工作流为仅手动发布；这些都需要单独配置，不能靠 `[skip ci]` 实现。

<details>
<summary>维护者：公开前安全检查</summary>

## <a id="safety"></a>公开前的安全检查

把本仓库推到任何公开位置前，只检查被跟踪的文件：

```bash
git ls-files
git grep -nE 'PRIVATE|SECRET|TOKEN|PASSWORD|AKIA|/(h[o]me|Users)/|10\\.|192\\.168\\.|172\\.|D[E]SKTOP|[Ww]orkstation'
```

`secrets.env`、`backup.log`、`node_modules/` 与构建产物都被忽略，应保持未跟踪。

</details>

## <a id="roadmap"></a>路线图

待办与灵感项都在 [GitHub issues](https://github.com/TMYTiMidlY/agent-session-manager/issues) 跟踪。两条值得单独点名的方向：

- **忠实恢复 / 迁移**：把会话恢复到"另一台机器能 `--resume`"的原生状态（来源 = 备份快照 ∪ 另一台机器）——边界见 [ADR 0001](docs/adr/0001-scope-archive-and-restore.md)。
- **本地 Web 界面 `asmgr web`**：本机启动、仅供自己查看的会话浏览界面。

单文件分发与 npm 发布**已实现**（单一无 scope 包 `asmgr`、四平台原生二进制、semantic-release、`npm i -g github:` 免 registry 安装）——使用方式见[安装](#install)，发布规则见[维护者：版本与发布](#release)。其余（持久化索引外部会话目录、提升适配器保真度、项目层级索引页、Token / 成本视图、实时 tail、VS Code 扩展、Pages 导出 tarball、跨多会话仪表盘）见 issues。
