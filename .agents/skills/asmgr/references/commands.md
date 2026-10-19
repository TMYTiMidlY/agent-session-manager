# asmgr 命令参考

按命令分节列出常用选项与输出格式；完整语义以[已安装版本的 README](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/README.md) 为准。所有读命令（`list` / `search` / `show` / `html` / `md`）共用：

| 选项 | 作用 |
|---|---|
| `-a, --agent <agent>` | 限定来源：`copilot\|claude\|codex\|chatgpt\|dsh\|cursor\|all`（cursor 别名 `cursor-agent`） |
| `--file <path>` / `--events <path>` | 读显式文件或目录（`*.jsonl`、DSH `*.jsonl.zstd`、`*.chatgpt-share.json`、Cursor `store.db`）替代 live 主目录，格式自动探测 |
| `--cwd <path>` | 精确匹配会话记录的工作目录（规范化 `~` 与尾部斜杠，递归包含子目录） |
| 各 root 覆盖 | `--copilot-root` / `--copilot-db` / `--claude-root` / `--codex-root` / `--chatgpt-root` / `--dsh-root` / `--cursor-root` |

## 会话发现：list 与 current

`asmgr list` 默认按源文件 mtime 降序输出 TSV：`agent`、`session-id`、`path`、`mtime`（UTC ISO）、`size`（压缩文件为压缩大小）、`cwd`。

```bash
asmgr list --agent dsh --cwd "$PWD" --limit 20
asmgr list --agent codex --stats --sort peak_ctx --limit 20
asmgr list --by project      # 按仓库聚类；--by agent 按工具分组
```

- `--stats` 追加 `peak_ctx`、`ctx_util%`、`in`、`cached`、`out`、`cache%`、`compact` 列；统计排序先算全集再取 limit，与 `--by` 互斥。
- `--role main|subagent|guardian|unknown` 筛**会话身份**（会话图里的角色），与 show/search 的消息角色是两回事，见[轮次、角色与保真度](turns-and-fidelity.md#role-two-meanings)。
- `--json` 输出 metadata 数组；`--limit 0` 列出零条（不读会话）。
- `asmgr current` 仅在 DSH 运行时注入 `DSH_SESSION_ID` 时打印该 ID；变量缺失时报错，把最新 mtime 当作当前会话。

## 检索：search

```bash
asmgr search "关键词" --agent all --limit 20
asmgr search "关键词" --agent dsh --session <session-id> --role user
```

每条命中一行 tab 分隔：`project`、`agent`、`session-id`、`#条目`、`role/kind`、`摘录`。默认按源文件 mtime 降序检索，同一会话内保持 timeline 顺序。

- `--session <id>` 限定单会话：先精确匹配、再前缀匹配（DSH 裸 uuid 也可）；歧义时拒绝，要求更长前缀或 `--agent`/`--file`。
- `--role user|assistant|tool|reasoning|system|event` 只搜该规范化消息角色。
- `-l/--limit` 达到上限即停止安排下一批；`-j/--concurrency`（1–32）限制并发；`--no-early-exit` 全量扫描用于检查诊断；命中总数也须全扫，属正常行为。
- 只搜可见的规范转录：注入上下文、失败尝试、未知插件 payload 不会误命中。

## 读取与导出：show、html、md

`asmgr show <session-id-or-url>` 的格式与选择器：

| 选项 | 作用 |
|---|---|
| `-f, --format` | `text`（全量含工具参数/结果）、`dialogue`（对话主干）、`plain`（仅正文原样）、`json`（统一文档 + entries） |
| `--turn <n>` | 只选第 n 轮人类输入，先于 `--role`/`--tail` 生效；不合并 guardian 子线程 |
| `--role <role>` | 过滤规范化消息角色（user/assistant/tool/reasoning/system/event），保留原 index |
| `--tail <n>` | role 过滤后取最后 n 条规范化条目，各线程独立 |
| `--summary` | 确定性接续摘要（替代 text/dialogue 渲染；JSON 附 `recoverySummary`），与 `--format plain` 互斥 |
| `--no-guardian` | 关闭 guardian 子线程合并（Codex 默认合并并标注来源） |
| `-o, --out <path>` | 写文件而非 stdout |

导出报告：

```bash
asmgr html <id> -a <agent> -o report.html          # 自包含 HTML：搜索/筛选/目录/主题切换/KaTeX
asmgr md  <id> -a <agent> -o session.md            # Copilot /share file 风格 Markdown
asmgr html <id> -a <agent> -s summary.html -o report.html   # 顶部钉一份 HTML 总结片段（md 用 .md 片段）
asmgr show 'https://chatgpt.com/share/<id>' -f dialogue     # 分享 URL 直接读，不落盘
```

`-s/--summary` 片段按原样嵌入、不做转换；`--summary-format html|markdown` 显式声明片段格式（html 默认 `html`，md 默认 `markdown`），扩展名与实际格式不符时给警告。

## 会话图与额度：tree、quota

```bash
asmgr tree <id> -a codex --json     # 父子与 fork 关系；缺父节点/重复 ID/循环会标明；--max-depth 0–256
asmgr quota -a codex --timezone Asia/Shanghai -f json   # Codex primary/secondary 额度按小时轨迹
```

并发数是记录区间的半开重叠，不代表此刻仍运行；额度仅请求时刻有采样，间隙未知。

## 导入与备份：import、backup

```bash
asmgr import 'https://chatgpt.com/share/<conversation-id>'   # 抓取公开分享到托管目录
asmgr backup run --dry-run                                   # restic 加密增量备份（源码 checkout 安装）
asmgr backup cache latest --host <host> --target ~/.cache/asmgr/restic-cache  # --host 限定快照来源主机
```

导入快照权限 0600，目标已存在时需 `--force`；私有 `/c/...` 地址栏会话拒绝抓取并提示先在 ChatGPT 里点"分享"。npm 安装暂不包含备份运行时，需源码 checkout。

> 各来源的持久化位置与限制（Copilot events.jsonl 缺失时的 db 回退、DSH 压缩与多代目录、Cursor 闭源 store.db）见 [README「支持的 agent 与数据来源」](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/README.md#支持的-agent-与数据来源)。
