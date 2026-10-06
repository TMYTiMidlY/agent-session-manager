# 统一会话重构验证记录

日期：2026-10-06；Node 24.21.0、Bun 1.4.2。只读原生来源，不写 agent 状态目录；报告只保留计数，不提交真实对话、原始额度样本或生成的私人报告。

## 本机全量读取

通过 `pnpm run test:local` 顺序发现并读取全部来源，每个成功结果检查统一文档、规范事件信封序号和转录索引。

| 来源 | 发现 / 成功解析 | 显示条目 | 空转录 | 读取失败 |
|---|---:|---:|---:|---:|
| Copilot | 1,214 / 1,214 | 229,754 | 519 | 0 |
| Claude | 0 / 0 | 0 | 0 | 0 |
| Codex | 496 / 496 | 127,808 | 9 | 0 |
| ChatGPT 已导入快照 | 1 / 1 | 168 | 0 | 0 |
| DSH | 2,051 / 2,051 | 273,933 | 39 | 0 |
| Cursor Agent | 17 / 17 | 822 | 6 | 0 |
| **合计** | **3,779 / 3,779** | **632,485** | **573** | **0** |

这是正在使用的目录快照，数量会变化。空转录包括未开始会话、仅 metadata 或无可恢复 DB turns，不能假定全部是损坏。Codex 的有界诊断共 2,857 次，包含不可计量的压缩标记、版本兼容及归属说明；Cursor 的 32 次诊断包含不可达旧分支和未经验证字段。**解析成功不代表所有未知字段都已解释**，有损与缺口仍在统一来源信息中保留。

本机没有 Claude 历史，不声称完成了真实 Claude 会话验证。Claude 以合成 JSONL 覆盖独立内容块、同响应流更新、重放、工具关联、坏行和缓存语义，并以仓库 fixture 验证 CLI / Markdown / HTML。

## 自动化与成品

实施前基线为 275 项通过；完成后的 `pnpm test`（先 TypeScript，再 Vitest）为 **33 文件 / 448 用例全绿**，包含原有解析/归档/搜索回归及新格式、原生计量、Cursor protobuf/SQLite、统计、额度、关系、时区和审阅回归。`pnpm run build` 成功；源码入口与单文件 bundle 使用同一解析器，不依赖安装中的 DSH runtime。

成品 bundle 对 Copilot、Codex、已导入 ChatGPT、DSH、Cursor 的真实非空会话，以及 Claude fixture，均完成 JSON/show、Markdown 和 HTML 导出。Codex `list --stats --sort peak_ctx -f json` 排序验证通过，本次最大观测 input 为 784,879 tokens；`quota --timezone Asia/Shanghai -f json` 输出完整小时轨迹。Bun bundle 的 Cursor list/show 也成功产生同一统一格式。生成报告只留在忽略的私人目录，不提交正文。

Cursor 在 Node 与 Bun 的只读路径均得到相同 17 个会话、822 个显示条目；检查所有原生文件 hash/mtime 前后不变，没有伪造逐消息时间或 token 用量。所有 Cursor 来源，包括 sidecar 入口，绕过持久负索引，防止 WAL 或 sibling 数据变化导致漏搜。

## 独立审阅与修复

使用显式指定的 GLM-5.3 并行智能体，完成统一核心、Cursor、来源计量与 CLI 的独立审阅。用户已批准该并行方式替代无法单独设置队友模型的持久 Agent Teams。

审阅发现并补判别性回归的问题包括：

- Cursor sidecar 缓存错误键与 WAL 负索引、嵌入 JSON 损坏静默丢失、重复调用标识的歧义关联、metadata 类型/版本和坏库错误表达。
- DSH 缺 seq 的 fork 继承计量泄漏；改以日志行序和最后可信 seed 标记定位继承切点。
- Codex 压缩填满窗口的全零快照被误认作精确计量；保留原数据但明确不入账。
- search 在过滤 guardian 前错误解析 ID；现先对完整候选集检查歧义，并尊重显式选择。
- show 消息角色过滤未作用于第二 JSON 转录载体；现所有消息载体同步过滤，标记 reduced view。
- 深树递归与重复时区 formatter 的规模问题；树深度有显式截断，formatter 有界复用。
- 无 primary/secondary 窗口时的余额/plan 元数据丢失，以及无法按小时放置的 timestamp 静默跳过；保留独立账号 metadata 观测，给出有界诊断。

修复后经独立复核：已发现的 P1/P2 阻塞问题全部解决。

另外区分 DSH UI 的缓存缺省零折算与原始日志缺值，保留转换说明；未知 Codex cache-write 只保留原值，不虚构为 DSH 独立桶；fork 的继承历史不拉长本线程的起始区间。

## 仍有边界

Cursor 闭源、未公开稳定格式，field 5 数字没有可信 token 口径；未知 protobuf groups 或内容块只保留可验证部分并诊断。无账号 ID 的 Codex 额度轨迹可能合并不同账户，不把额度桶冒充账户，也不推断全局重置或按项目百分比归因。统一文档是只读归档，不支持原生 resume/restore。
