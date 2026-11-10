# Antigravity CLI（AGY）本地会话读取

适用来源为 Antigravity CLI 的脑目录（brain），默认 `${AGY_HOME:-~}/.gemini/antigravity-cli/brain`（`AGY_HOME` 指向包含 `.gemini` 的上层目录）。该格式无公开文档；以下为 2026-11-10 对本机 502 个会话目录的只读观察与据此构造的合成回归所覆盖的布局，不是厂商兼容承诺。

## 已观察结构

每个会话一个 `<conversation-id>/` 目录（UUID 命名，即会话 id），固定布局：

```
<conversation-id>/
  .system_generated/logs/transcript.jsonl         紧凑转录（每行一个 JSON 步骤）
  .system_generated/logs/transcript_full.jsonl    完整转录（同行对齐、字段不截断）
  .system_generated/logs/chunks/transcript*/      分块副本（行集与 transcript.jsonl 一致）
  .system_generated/logs/media/step_N_media_M.*   粘贴图片 / 截图落盘
  .system_generated/messages/*.json               收到的 agent 间消息（sender/recipient/priority）
  .system_generated/steps/<n>/output.txt          步骤输出留档
brain 同级还有 history.jsonl：{conversationId, workspace, display, timestamp, type}
```

`transcript.jsonl` 与 `transcript_full.jsonl` 逐行对齐（实测行集一致）；紧凑行的 `truncated_fields: ["content"|"tool_calls"]` 标记该字段被截断，完整版的同一行持有未截断值。AGY 自己的 CHECKPOINT 摘要即指示"compact 有 truncated_fields 时去 transcript_full.jsonl 读该行"。chunks/ 是展示分块，不提供额外行。

每行公共字段：`step_index`（会话内递增）、`source`（`USER_EXPLICIT` | `MODEL` | `SYSTEM`）、`type`、`status`、`created_at`（ISO-8601 UTC）。已观察 type 与专用字段：

| type | source | 专用字段 | 统一映射 |
|---|---|---|---|
| `USER_INPUT` | USER_EXPLICIT | `content`（`<USER_REQUEST>` 包装 + `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` 附注） | user/message，正文原样保留；每条 USER_INPUT 是一轮人类输入 |
| `PLANNER_RESPONSE` | MODEL | `thinking`、`tool_calls: [{name, args}]`、`content`、`input_tokens` / `cache_read_tokens` / `output_tokens` | thinking → reasoning/thinking；每个 tool_call → tool/tool_use（callId 为 `step<N>:<i>` 本地合成）；content → assistant/text；token 三元组 → 一条 per-response 用量记录（cache_read 独立桶，语义对齐 Gemini / 统一格式口径） |
| `GENERIC` | MODEL | `content`（工具输出）、`media: [{mime_type, uri}]` | tool/tool_result；`Command exited with code N` 且 N≠0 判 failure；media 以 `{mimeType, uri}` 指针保留在 data，不复制字节 |
| `SYSTEM_MESSAGE` | SYSTEM | `content`（内嵌 `[Message] ... sender=<uuid> ...` 头） | system/system |
| `CHECKPOINT` | SYSTEM | `content`（压缩续跑摘要）+ token 三元组 | system/compaction（进入对话主干）；token 数是压缩点上下文规模快照，按 `kind: "context"`、`counted: false` 记录，不计入会话用量 |
| `ERROR_MESSAGE` | SYSTEM | `error`（如 API 重试失败） | event/error |

工具参数是**一层 JSON 编码**：`{"CommandLine":"\"ls -la\""}` 的值实为字符串 `"ls -la"` 外加引号。适配器在值形如 JSON 标量（字符串/数字/布尔/null）且能完整 round-trip 时解码一层，其余原样保留。

## 会话身份与派发关系

- 会话内出现任何 `USER_INPUT` → 身份 `main`（人类直接发起）。
- 全程没有 `USER_INPUT` → `subagent`：此类会话的第一行通常是 orchestrator 派发的 `SYSTEM_MESSAGE`，其内嵌头 `sender=<uuid>` 即**父会话的 conversation id**（真实 orchestrator→worker 派发中已验证该 uuid 等于父会话目录名）。解析出 sender 时记入 `identity.parentSession`，供 `tree` 构建父子图；解析不出时身份仍为 subagent，父会话保持未知。
- cwd 不在 transcript 行内：发现阶段从 brain 同级 `history.jsonl` 的 conversationId → workspace 索引富化，取该会话**首次**记录的 workspace（与其它适配器"会话起始 cwd"语义一致）。
- 会话标题与逐响应模型名不在 transcript 中记录（`invoke_subagent` 参数里的 Model 字符串只描述派发意图，不绑定后续响应），保持未知而非推断。

## 口径和保真

- 解析优先读 `transcript_full.jsonl`（ref 指向紧凑文件时自动取同目录完整版），此时紧凑侧的截断标记不构成损失。仅当完整版缺失、且紧凑行携带 `truncated_fields` 时标记 `source.lossy` 并逐项计数警告。
- PLANNER_RESPONSE 的 token 三元组是单次响应增量（非累计快照），按 `responseId: step-<N>` 去重；缺字段保持未知，不补零。CHECKPOINT 计数是上下文规模，不混入总量。
- 工具调用与 GENERIC 结果不做位置强配对：仅当上一 PLANNER_RESPONSE 批次恰有一个未配对调用时按 callId 关联（1:1 安全场景）；多调用并发时配对不可验证，GENERIC 保持独立 tool_result，不编造归属。
- `invoke_subagent` / `manage_subagents` / `send_message` 等工具按普通 tool_call 读取（参数、结果文本齐全）；子会话本身作为独立 brain 会话被发现，通过 parentSession 关联，不在此处内联展开。
- 对 brain 目录只读；不触碰 `conversations/*.db`（每会话 SQLite 库）与 `conversation_summaries.db`，transcript JSONL 已含全部对话内容。目录遍历（`--file <dir>`）跳过 AGY 主目录的 `history.jsonl` 索引文件，避免把非会话文件当会话报错。
- 这是只读归档适配，不调用 antigravity CLI，不触发 resume，不生成可恢复的原生会话。

## 运行时与测试

纯 JSONL 读取，无 SQLite / 压缩依赖；`--file` 指向单个 transcript 或任意副本（非 `transcript*.jsonl` 命名时 id 退回文件名）。合成 fixtures（`fixtures/agy/`）覆盖：紧凑/完整双日志与截断标记、全部六种行类型、参数一层解码、1:1 调用配对、失败退出码、media 指针、CHECKPOINT 上下文不计量、subagent 派发与 parentSession、history.jsonl 的 cwd 富化、显式文件与目录遍历。本机全量只读验证了 502 个会话目录的发现与抽样解析。

```bash
asmgr list -a agy
asmgr list -a antigravity --agy-root /path/to/brain -f json
asmgr show <conversation-id> -a agy --turn 1 --role user -f plain
asmgr search "关键词" -a agy
asmgr tree <conversation-id> -a agy        # orchestrator → worker 派发树
```
