# ADR 0004：发现、规范投影与检索执行分层

## 问题与约束

DSH 存档按事件写很多独立 Zstandard 帧。旧实现 header 采样也 `readFile` 整文件；全库 search 逐个构造完整 timeline，且把渲染的附件占位符说明逐会话输出到 stderr。默认 discovery 按 id 排序，用户无法从列表定位最近会话。

不要把 Node 的 `Buffer.subarray` 累计 suffix 参数长度误称为实测二次复制：Node 24 的 native 路径取指针，主要 CPU 成本是每帧 decoder 初始化、分配与事件投影。Bun 的多帧行为又不同。修复必须以正确性和端到端实测为准。

## 决策

1. **发现只读 metadata**：DSH authoritative header；其他 JSONL 来源最多采样前 50 条。stat 提供独立 `mtime`/`size`，列表默认文件活动降序、稳定 ties。`updatedAt` 仍指事件时间，不偷换概念。精确 cwd 过滤和 JSON 输出不为默认 list 构造 timeline；统计分组明确需要解析。
2. **压缩边界独立**：增量扫描标准/skippable 帧的 header/block/checksum 边界，逐完整帧交给公开 decoder；只缓存当前帧，UTF8 用持续 StringDecoder。不能直接 pipe Node Zstd stream：同 chunk 的后续帧可能被静默忽略；Bun 也可能接受截断。结构 scanner 保证 EOF，decoder 保证压缩内容/checksum。采样提前关闭 fd，不假装验证未请求尾部。
3. **搜索语义只来自规范投影**：不对 raw JSON 做全文 grep，不引入第二套简化 DSH 人类消息/工具/问答/compaction 语义；hit 索引可与 show 对照。未来流式投影优化必须复用并验证规范解析逻辑，而不是牺牲 provenance/问答一致性。
4. **有界执行与真实 CPU 并行**：按 mtime 排序，每批最多 concurrency 个会话，批内结果按源顺序合并；命中 cap 后不安排下一批。CLI worker pool 实际并行同步解压/投影，失败回退同一 reader。仅 Promise 并发不足以并行同步 CPU。核心接受可注入 scan backend，默认无 worker 生命周期或 console 副作用。workers 无需克隆完整 timeline，只返回该查询的有限 hits 与有界诊断；始终 finally terminate。
5. **可丢弃的私有派生文本索引**：gzip 保存小型 metadata/diagnostics header 与大小写归一的规范 search texts，不缓存完整 ParsedSession。首次尝试完整 timeline 缓存后，实测热全库扫描仍需 JSON 解析大量工具 payload 和重新 stringify 搜索文本，达 21 秒/约 1 GiB，故不采用。先用带完整 header seal、Bloom hash 与 shape 校验的小型 UTF16 三字符 Bloom sidecar 排除无命中者；它只允许误报，短 query <3 不排除。余下文本索引在 hash 验证后用 Buffer.includes 保守预筛；JSON 转义后的 needle 保留普通子串匹配，UTF16 surrogate 查询绕过字节预筛。可能命中再读规范源，保证完整 hit/tool 语义和原 index。stat 的 path/id/mtime/size/ctime/inode 校验；读前后变动不写缓存，一个源只占一个槽位；atomic temp + rename，目录 0700 / 文件 0600。128 MiB 限额。缓存不可用不影响检索；`--no-cache` 读写均绕开；库 API 默认不写。解析语义变化必须递增 `SEARCH_CACHE_VERSION`，不能只改 schema 而复用过期投影。缓存非加密、含私密文本，文档显式告知。Copilot SQLite/db-turns 绕过持久缓存：真实 WAL 更新不改变主 DB stat，会让旧负索引漏掉新 turn，不能用主文件指纹冒充事务 snapshot。
6. **诊断与呈现分离**：核心发 structured diagnostic。预期附件 placeholder 为 notice，默认文本搜索不刷 stderr；真实兼容性/完整性问题仍汇总，即使没命中。CLI 默认保留 bounded 路径样本，verbose 显示逐条，quiet 关闭。导出的 lossy warning 保留。
7. **标识不猜测**：前缀有歧义拒绝；`current` 只使用 DSH_SESSION_ID，不把 newest mtime 当运行状态。损坏的最高代在目录发现保留可报告 ref，不自动降代，也不使其余会话不可搜；显式文件仍严格拒读。

## 取舍与验收

- 冷首次检索依然要解析候选历史；cache 热读也受文本体量约束。默认 2 workers 会占多个 heap，`-j 1` 是低内存逃生口，不承诺几十 workers 必然更快。
- 仍同步单帧解压，不接入 DSH runtime 私有 native handles，不增加系统 zstd 可执行依赖。超大单帧/JSONL 行不是常量内存。
- cache 是派生副本，不是归档格式或恢复入口；不会修改原始会话目录。会话 cwd 若不在采样窗口则保持未知，不为 metadata list 偷偷全扫。
- 合成回归覆盖顺序、cap/full-scan、坏源隔离、角色/目录过滤、cache 失效/损坏/权限、worker/backend；Zstd 覆盖任意分片/截断、UTF8、checksum、skippable、关闭与采样。发布本机架构的实际 Bun compiled artifact 要执行 smoke，不能只靠 Node Vitest 或“Bun 有 API”。
