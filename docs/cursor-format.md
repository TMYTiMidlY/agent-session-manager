# Cursor Agent 本地会话读取

适用来源为 Cursor **Agent CLI** 的 `~/.cursor/chats/`，不是编辑器 workspace 的 `state.vscdb`。它是闭源且无稳定公开磁盘协议的来源；以下为 2026-10-06 本机只读观察及合成回归所覆盖的布局，不是厂商兼容承诺。

## 已观察结构

每个 `<workspace-hash>/<agent-id>/` 下有 `store.db`，通常另有 `meta.json`。SQLite 包含 `meta(key,value)` 和 `blobs(id,data)`。`meta['0']` 为十六进制编码 JSON，已观察字段包括 `agentId/latestRootBlobId/name/createdAt/lastUsedModel`。sidecar 提供会话级 `createdAtMs/updatedAtMs/cwd/title/hasConversation`。显式备份文件凭 SQLite schema 和内部 metadata 识别，不要求仍位于原来的 hash/UUID 目录。

blob id 为原始字节的 SHA-256。已覆盖两种 payload：完整 AI SDK 风格 JSON 消息，以及 protobuf 信封。信封 field 1 按顺序引用其他 blob；field 4 可携带完整 JSON 消息；field 9 可提供 `file://` 工作目录。用 field 1 的有向引用图重建当前 `latestRootBlobId` 可达消息，父节点先于子节点，按引用顺序遍历并去重共享祖先。

不能把所有 blob 的 rowid 顺序作为会话：不可达节点可能是编辑、重新生成或旧分支。哈希不匹配、引用缺失、循环、非法长度/varint、未知 protobuf groups、损坏 JSON 和不透明载体会有有界诊断，不通过扫描任意 JSON 子串猜正文，也不静默改用全部历史。

## 口径和保真

- 已知 `system/user/assistant/tool` 角色、text/reasoning/tool-call/tool-result 内容块进入统一文档；工具调用和完成保留各自来源位置，结构化参数和结果关联。
- 未知内容块可在 `document` 中保留原生结构，但不进入可搜索文本；保留原始数据不等于已经解释其语义。
- 本机未观察到可靠的逐请求 input/cache/output 计量。field 5 的数字含义未经验证，**不**作为 token 使用量或上下文计量；统计为未知，而不是零。
- 缺少逐消息时间戳时不使用会话创建时间、文件 mtime 或时间估计填补。`lastUsedModel` 只代表会话 metadata，不绑定到每条历史响应。
- 这是只读归档适配，不调用 Cursor CLI，不触发 resume，不生成可恢复的原生会话。

## 运行时与测试

Node 通过 `node:sqlite` 的 `mode=ro`、`readOnly` 和 `query_only` 读取；Bun 使用 `bun:sqlite` 的 `readonly` 和 `query_only`。缺少能力与源数据库损坏分别报错。派生 search 缓存不以 SQLite 主文件 stat 推断内容不变，避免遗漏 WAL 新消息。

本机 Node 24.21.0 与 Bun 1.4.2 均只读验证了 17 个会话目录（12 个数据库、5 个仅 metadata 的未开始会话）；两运行时都得到 822 个显示条目。合成测试覆盖消息链、共享祖先、坏字段、未知内容的搜索隔离、复制到任意位置的数据库和读取前后字节/mtime 不变。此数量是验证快照，不应当作用户目录的固定规模。

```bash
asmgr list -a cursor
asmgr list -a cursor-agent --cursor-root /path/to/chats -f json
asmgr show --file /path/to/copied-conversation.db -f json --no-guardian
asmgr search "关键词" -a cursor --no-cache
```
