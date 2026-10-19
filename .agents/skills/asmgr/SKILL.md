---
name: asmgr
description: 查找、回读、检索、导出 Copilot CLI / Claude Code / Codex / DeepSeek Harness / Cursor / ChatGPT 分享的本地会话时使用。核心思路：先确认来源工具与会话 ID，再用一条 CLI 完成 定位 → 按轮次/角色过滤 → 原样输出或导出 HTML/Markdown，全程对 agent 状态目录只读。
---

# asmgr

asmgr（Agent Session ManaGeR）读取编码 agent 写在本地的会话历史，输出对话文本、结构化 JSON 或自包含 HTML/Markdown 报告。支持的来源：Copilot CLI（`~/.copilot`）、Claude Code（`~/.claude`）、Codex CLI（`~/.codex`）、DeepSeek Harness/DSH（`${DSH_HOME:-~/.dsh}`）、Cursor Agent（`~/.cursor`）、公开 ChatGPT `/share/` 页面（需先导入或直接给 URL）。

对 agent 状态目录**只读**。会话收尾/交接盘点类流程（如 `dredge-up` skill）也消费本 CLI 回读原始对话；本 skill 是工具层，规定何时、怎样调用。

## 何时使用

- 用户要"看看某次会话""第一轮说了什么""找回某段对话原话"——按[确认会话来源](#confirm-source)定位后用 `show` 读取。
- 跨会话找历史："我们之前在哪讨论过 X"——用 `search`。
- 交接、留档、给别人看——导出 `html` / `md`。
- 会话复盘需要工具细节、用量、token 统计、父子线程关系——`show -f text` / `list --stats` / `tree` / `quota`。

取"第 N 轮对话原样内容"直接一条命令，避免先导出全量再手工拆分：

```bash
asmgr show <session-id> --agent <agent> --turn 1 --role user --format plain
```

## 安装与版本

```bash
npm i -g asmgr          # 需要 Node ≥ 22
```

也可从 [Releases](https://github.com/TMYTiMidlY/agent-session-manager/releases) 下载单文件二进制（无需 Node）。`--turn` 与 `--format plain` 需要 ≥ 0.7.0；二进制不读取 Copilot 实时 SQLite 库（该数据源改用 Node 安装）。DSH 压缩日志需要运行时支持 Zstandard（Node ≥ 22.15）。

## <a id="confirm-source"></a>确认会话来源

用户只给会话 ID、未说明来源工具时，先向用户提问并等待回答（Copilot CLI、Claude Code、Codex、DSH、Cursor 还是导入的 ChatGPT 快照），确认后再读取；这一步**不**按 ID 形状、当前运行环境或默认搜索结果猜测——猜错来源会读错会话。确认后，所有按 ID 读取或检索的命令都带 `--agent <agent>`（取值 `copilot|claude|codex|dsh|cursor|chatgpt|all`）。

定位会话的优先顺序：

```bash
asmgr current                                   # 仅 DSH：运行时注入 DSH_SESSION_ID 时直接打印
asmgr list --agent <agent> --cwd "$PWD" --limit 5   # 按工作目录找最近会话
asmgr search "关键词" --agent <agent> --session <id> # 会话内检索定位
```

- `current` 在 `DSH_SESSION_ID` 未设置时报错；mtime 最新的会话与"当前会话"是两回事。
- ID 支持前缀匹配；前缀有歧义时命令会拒绝并要求加长前缀或用 `--agent`/`--file` 缩小范围。
- 读取任意位置的会话文件（scp 来的、恢复出来的）：所有读命令支持 `--file <path>`（别名 `--events`），格式自动探测。

## 常用任务

| 任务 | 命令 |
|---|---|
| 对话主干（用户/助手/问答/压缩摘要，无工具噪音） | `asmgr show <id> -a <agent> -f dialogue` |
| 第 N 轮对话主干 | `asmgr show <id> -a <agent> --turn <n> -f dialogue` |
| 第 N 轮用户原话，正文原样 | `asmgr show <id> -a <agent> --turn <n> --role user -f plain` |
| 全部用户消息 | `asmgr show <id> -a <agent> -f dialogue --role user` |
| 完整工具参数与结果 | `asmgr show <id> -a <agent> -f text` |
| 机器处理 | `asmgr show <id> -a <agent> -f json` |
| 跨会话搜索 | `asmgr search "关键词" --agent <agent>` |
| 导出报告 | `asmgr html <id> -a <agent> -o out.html`；Markdown 用 `md` |

轮次划分、角色过滤、注入上下文排除等语义细节见 [轮次、角色与保真度](references/turns-and-fidelity.md)；各命令完整选项见 [命令参考](references/commands.md)。

## 执行边界

- **只读**：asmgr 不写 `.copilot` / `.claude` / `.codex` / `.dsh` / `.cursor`；导出报告是有损给人看的产物，**不能**反推回可 `--resume` 的原生会话。
- **会话改名交给用户**：asmgr 只读、不写会话名；需要改名时给建议，由用户在对应工具里操作。
- 导出的报告是**归档**，恢复到"另一台机器能续聊"是另一条规划中的能力（备份 `backup` 命令），两者不混用。
- 命令输出的有损警告（`warning:` / `source.lossy`）如实转述给用户，缺失内容不补造。

## 参考文档索引

- [命令参考](references/commands.md)——`list` / `search` / `show` / `html` / `md` / `import` / `tree` / `quota` / `backup` 的选项与输出格式；解决"这个筛选怎么写"时读。
- [轮次、角色与保真度](references/turns-and-fidelity.md)——`--turn` 轮次语义、`--role` 的两层含义、`--format plain` 的原样承诺、各来源的有损边界；解决"输出为什么少/多了内容"时读。

> 上游文档：[README（v0.7.0）](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/README.md)、[ADR 0001 范围：归档与恢复](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/docs/adr/0001-scope-archive-and-restore.md)、[ADR 0003 归档重建保真度](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/docs/adr/0003-archive-reconstruction-fidelity.md)、[ADR 0004 统一会话格式](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/docs/adr/0004-unified-session-format.md)。本 skill 与仓内 README 冲突时，以已安装版本的行为为准。
