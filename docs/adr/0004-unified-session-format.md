# ADR 0004：固定 DSH 语义的统一会话文档

日期：2026-10-06；状态：采用。

## 背景

各来源此前直接生成用于显示的 `TimelineEntry[]`，无法一致地保留原生内容块、请求用量、上下文采样、账号额度和线程关系。来源字段名称相似不表示统计语义相同；把 Codex 的包含缓存输入直接改名为 DSH `inputTokens` 会重复计算缓存。

## 决策

所有来源经 `parseSession()` 产出 `SessionDocument`：`format: "asmgr.session-document"`、`version: 1`。固定参考 [DeepSeek Harness 5badb150](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)，原生 Session format 4，计量定义见 [TokenUsage](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm/src/types.ts)。不会加载本机 DSH runtime 或随其升级改变统一文档语义。

文档包含固定 `basis`、来源 `ref/source`、线程 `identity`、会话 metadata，以及 `{type, seq, time?, data}` 事件信封。`message/append` 存放结构化消息块，`usage/record` 存放计量证据。规范化 `seq` 是本地投影序号，不是原始日志序号；原始 `seq/row/time/blobId` 保留在 `provenance`。没有逐消息时间戳的来源不使用文件名、mtime 或会话创建时间伪造消息时间。

`blocks` 与 `usage` 是事件 payload 的便利视图；来源适配器完成读取后才组装规范事件。`entries` 由这些事件单一投影，用于现有 text/dialogue/HTML/Markdown/search。原生内容块和未知附件可保留在 `native`，但不因保留原始字段就把私有注入上下文、未知插件 payload、失败尝试或孤立旧分支加入可见转录。

来源适配器在自己的读取过程中收集内容、用量与身份。规范化层不再另读源文件来猜计量字段，避免双读不一致、重复实现和静默失败。兼容视图用于保留已有归档排版，不作为恢复原生消息的信息来源。

## 计量不变量

- `inputTokens` 为未缓存输入；`cacheReadTokens`、`cacheWriteTokens` 是互不交叉的输入桶。
- `reasoningTokens` 包含在 `outputTokens` 中，不相加。
- 原始字段和转换说明分别保留；只有已经核实语义的字段才进入统一指标。无法确认缓存写入是否属于其他桶时，只保留来源数值，不宣称其是 DSH 独立桶。
- 缺失不是零。任何一个计入记录缺少某项指标，该项完整总量保持未知，不将其余记录的小计冒充完整总量；无计量来源输出 `accounting: unavailable`。
- 去重依赖原生响应标识在同一来源/会话内唯一的约定（并不按模型名字虚构新请求，也不跨会话合并计量）；流更新已知覆盖关系由来源适配器先标记，缺标识时只按可验证的原记录位置去重，不按相同 token 数推断重复。
- 精确响应记录按来源/所属会话和 `responseId` 去重；同一响应存在矛盾数值时显式诊断，不静默叠加。没有响应记录的旧日志只使用最后一个累计快照，并标明 `latest-snapshot`；两种证据不混加。
- 上下文输入采样、账号额度、父会话继承数据和其他线程用量不计入当前会话请求总量。保留这些观测不等于当前线程消耗了它们。
- `totalTokens` 只有语义与完整输入加输出一致且计数完整时才能作为统一总量；来源自己的 blended/context/display total 可原样保留，但不可混用。

## 来源与版本边界

Codex 参考 [822e58cc](https://github.com/openai/codex/tree/822e58cc3d666166c7446c5b1ea2e52f5d09594c)。原始 `input_tokens` 包含缓存读取；`token_count.last_token_usage` 是上下文输入观测，不可按事件数量累计。`token_usage_record.usage` 是响应级证据。`rate_limits` 是请求时刻的账号级观测，不能据工作目录归因额度百分比，也不能在没有账号标识时证明多个文件属于同一账号。

Cursor Agent 是闭源、未公开稳定磁盘协议的来源。只读 SQLite 和内容寻址引用图，读取当前根节点可达的消息；不把所有 blob 的插入顺序误当作完整会话。未验证的 protobuf 数字不转换为 token 计数，没有逐消息时间或用量时保持未知。解析差异和缺失通过有界诊断及来源警告呈现。

## 后果

这是 asmgr 的只读、版本化中间格式，**不是**可交给 DSH 或其他 harness `resume` 的原生日志。所有来源保真程度仍取决于原始记录及已知适配范围，不能声称任意未知字段均已解释。新增来源和格式变化需要补映射证据、合成测试与本机只读验证；统一 schema 的不兼容变化另升版本。
