# ADR 0003：归档侧——离线重建的保真度模型

## 状态

已接受。是 [ADR 0001](0001-scope-archive-and-restore.md) 归档侧的保真度契约。Copilot 事件到时间线的完整映射细节、12 类官方筛选清单与操作坑属参考资料，放在 README。

## 背景

Copilot CLI 有两种会话表示：`/share html` 渲染的是 **live 内存 timeline**（`session.getTimelineEntries()`），并**不**直接读 `events.jsonl`。而 `asmgr` 离线运行，只能读磁盘上的 `events.jsonl`。

## 决策

归档侧**从 `events.jsonl` 离线重建规范化时间线**，走一条独立于官方的映射路径：持久化事件 → `asmgr` 的映射器 → 规范化条目 → HTML / Markdown。

由此确立的理念：

- **单点映射器是核心风险**：只要离线映射漏掉一个事件分支，那一整类条目就会被**静默丢弃**（历史上的 compaction、`task_complete` 少渲染 bug 皆源于此）。因此解析器把每个原始事件记为 **handled / 有意忽略 / unknown** 三态计数——让 schema 漂移**显形报警**，而不是无声消失。"有意忽略"必须在策略里显式登记，否则一个新引入的事件和一个被主动丢弃的事件无法区分。
- **有些数据离线不可重建，是硬限制而非 bug**：只存在于 live 内存、从不落 `events.jsonl` 的条目（吉祥物启动横幅、`/share` 成功回执、临时重试提示）无法恢复。
- **忠于源，但不惧偏离官方**：`reasoningText` 在官方 live 映射里不进时间线（官方导出的 reasoning 条目为 0），`asmgr` **有意**把它拆成独立 reasoning 条目；并额外暴露 subagent / skill / plan 条目、可置顶的总结卡片、默认展开单行 info——这些是**有意的离线扩展**，超出官方筛选集。
- **渲染用 React 自实现**：不维护对官方 vanilla `/share html` bundle 的逐字节复刻；抽取上游 CSS/JS 的脚本只作**漂移探针**（Copilot 升级后 diff、提示复核映射），不是运行时或构建依赖。

## 后果

Copilot 升级后应复核 unknown 事件诊断并重跑漂移探针。持久化行为（尤其 compaction 时的文件截断机制）置信度相对低，值得对新版本重新验证。
