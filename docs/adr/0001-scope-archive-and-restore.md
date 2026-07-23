# ADR 0001：范围、双面能力与"归档 ≠ 恢复"

## 状态

已接受。命令名与包结构见 [ADR 0002](0002-single-package-asmgr-distribution.md)；归档侧保真度见 [ADR 0003](0003-archive-reconstruction-fidelity.md)；恢复侧见 [ADR 0004](0004-restore-fidelity-and-safety.md)。

## 背景

本仓库始于 `copilot-backup`——一个用 restic 备份 `~/.copilot` 的封装。范围已扩大：不仅备份，还要按 id 取回历史会话、搜索旧会话、为 GitHub Copilot CLI / Claude Code / OpenAI Codex CLI 生成给人看的报告，并（规划中）把会话忠实恢复到能继续续聊的状态。

## 决策

`agent-session-manager` 提供**两侧、严格分层**的能力：

- **归档（只读检索）**——`list / search / show / html / md`。从本地 agent 历史只读重建，产出**有损、只读、给人看**的报告。已实现。
- **恢复**——忠实重建**可 `--resume` 的原生会话状态**，来源 = restic 快照 ∪ 另一台机器。规划中（实现在 GitHub issue 跟踪）。

核心公理 **归档 ≠ 恢复**：报告（Copilot `/share html`、`asmgr html/md`）是**有损、单向**的产物——丢弃 `system.message`、`hook.*`，不保留事件链，**不可能从报告反推出可 resume 的原生状态**。给人看走归档；换机续聊走恢复；二者不可互相替代。

**只读边界**：归档侧对 `~/.copilot`、`~/.claude`、`~/.codex` 只读，从不写、从不联网拉会话；唯一联网的是 `backup`（restic）。恢复侧只写**显式目标**（缓存目录或目标机 home），绝不回写 live agent home。

## 取舍

早期立场是"只归档、不把会话恢复回原 CLI"。现在明确**恢复是一等目标**，但与归档严格分层、各有独立的保真度契约（见 ADR 0003 / 0004）。备份只是归档与恢复的**一个来源**，不是产品主线。社区同类项目（`claude-code-trace`、`codex-trace` 等）是 schema 覆盖与 UX 的参考，不作依赖内嵌。
