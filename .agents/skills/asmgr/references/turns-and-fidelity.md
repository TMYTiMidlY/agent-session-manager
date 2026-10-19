# 轮次、角色与保真度

`show` 的输出由三层选择器决定——轮次（`--turn`）→ 消息角色（`--role`）→ 尾部/摘要（`--tail` / `--summary`）——再交给四种格式渲染。理解每层"选什么、排除什么"，才能解释输出里多了或少了什么。

## <a id="turn-semantics"></a>轮次的划分

一轮 = 一条**人类输入**（human prompt）加上其后所有条目，直到下一条人类输入之前。`--turn <n>` 取第 n 轮。

人类输入的判定：role 为 `user`、kind 为 message/text、正文非空、且**排除注入上下文**。注入上下文按来源识别：

| 来源 | 排除规则 |
|---|---|
| Codex | 正文以 `# AGENTS.md instructions for`、`<user_instructions>`、`<environment_context>`、`<turn_context>`、`<codex_internal_context`（goal 续跑）、`<skill>` 开头 |
| Claude | 行带 `isMeta` 或 `isCompactSummary` 标记 |
| DSH / Copilot / ChatGPT | 适配器只把人类输入归入 user 消息，默认无需排除 |

由此产生的语义要点：

- **首轮是第一条人类输入，不是第一条 user 消息**：会话开头注入的 AGENTS 指令、环境中块不占轮号；真实会话里 goal 续跑注入（"Continue working toward the active thread goal"）也不占。
- 注入上下文不出现在所选轮次里；不带 `--turn` 的完整 text/JSON 输出仍照常保留它们。
- `ask_user_question` 等交互问答的**决策与回答留在提问所在轮次**，不另开新轮。
- 轮次按完整 timeline 计数、先于 `--role`/`--tail` 生效：加 `--role user` 不会改变轮号。
- `--turn` 不合并 guardian 子线程（它们有独立 timeline）；JSON 的 `document.view` 标明 `turn`，且不经原生 opaque 内容泄漏被排除的消息。
- 轮次越界明确报错（`session has N user turns`）；输出为空通常是选择器组合所致（如所选轮次内没有该角色的条目），属预期行为。

## <a id="role-two-meanings"></a>消息角色与会话身份

`--role` 在两个命令里含义：

- `show` / `search`：过滤**消息角色**（user/assistant/tool/reasoning/system/event），作用于规范化 timeline 条目，保留原始 index 不重编号。
- `list`：筛**会话身份**（main/subagent/guardian/unknown），即该会话在会话图里的位置，与消息内容无关。

dialogue 的角色过滤与主干过滤取交集：`--role user` + dialogue 输出的是主干里的用户消息（含可恢复的问答决策）。

## 输出格式的差异

| 格式 | 内容 | 头部装饰 |
|---|---|---|
| `text` | 全量条目：工具参数+结果、子代理/技能/计划/压缩统计 | session 头 + `## N. role/kind 时间戳` |
| `dialogue` | 对话主干：用户消息、交互问答与决策、压缩摘要、助手回复 | 同 text（保留原 index） |
| `plain` | 选中条目的正文本身，多条以空行分隔 | 无 session 头/序号/时间戳/标题；有损警告走 stderr |
| `json` | 统一 `SessionDocument`（版本化事件信封 + 结构化内容块）+ 派生 `entries` | 机器可读，`document.view` 标记缩减视图 |

`plain` 的正文是逐字节原样的：空白、换行、代码围栏都保留；取"第 N 轮用户原话"用 `--turn <n> --role user -f plain`。dialogue 头部的 `N` 是完整 timeline 中从 1 开始的原始位置，过滤后不重编号——解析 dialogue 输出时按 `## N. role/kind` 头切分即可，无需正则猜正文边界。

## 来源保真度与有损警告

各来源能恢复的内容不同，缺失以显式警告暴露（text/dialogue 头部 `warning:`、plain 的 stderr、JSON 的 `source.lossy` 与 `source.warning`）：

- **Copilot**：`events.jsonl` 缺失（被 prune/只迁移了 DB）时回退 `session-store.db` 的 `turns` 表，只有用户/助手文本；交互式决策与工具条目标记不可恢复。
- **ChatGPT 分享**：公开页隐藏的工具结果无法恢复；只有资源指针的图片/附件显示占位符。
- **DSH**：图片/文件只显示占位符并提示损失；压缩 checkpoint 只显示已知摘要。
- **Cursor**：闭源 store.db，未验证的 protobuf 数字不做推断，局部缺失给诊断。

统一格式口径：`inputTokens` 是**未缓存输入**，`cacheReadTokens`/`cacheWriteTokens` 独立成桶，`reasoningTokens` 是输出子集；缺值保持未知，不假装成零。精确响应增量按 `response_id` 去重，旧日志只有累计快照时明确标记口径。

> 设计依据：[ADR 0003 归档重建保真度](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/docs/adr/0003-archive-reconstruction-fidelity.md)、[ADR 0004 统一会话格式](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/docs/adr/0004-unified-session-format.md)。兼容策略（新版本 header、未知事件的局部诊断）见 [README「DSH 读取与主干」](https://github.com/TMYTiMidlY/agent-session-manager/blob/v0.7.0/README.md#dsh-读取与主干)。
