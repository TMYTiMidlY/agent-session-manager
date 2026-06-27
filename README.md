# copilot-backup —— Copilot CLI 会话历史增量备份

把本机 `~/.copilot`（GitHub Copilot CLI 的全部会话历史）**增量、加密**备份到任意 S3 兼容（或其他 restic backend）后端。目标：任意历史会话都能恢复到「`/share html` 可复刻」的程度。已端到端验证通过。

底层：**restic**（CDC 去重 + zstd 压缩 + 端到端 AES-256）。仓库里的脚本和本 README 是**通用的**——所有「打到哪台机、哪个 bucket、走什么端口」都从 `secrets.env` 读取；换机部署只改那一个文件即可。

---

## 这套东西由什么组成

| 文件 | 作用 |
|---|---|
| `backup.sh` | 备份主脚本：① 对 `session-store.db` 做 SQLite WAL checkpoint（保一致）② `restic backup` ③ `forget`+`prune`（按保留策略清理） |
| `exclude.txt` | 排除清单（**只放通用 glob**：SQLite 热文件、锁；锚定到 `$COPILOT` 下的路径如 `logs/` / `rewind-snapshots/` 由脚本拼 `--exclude` 传入） |
| `secrets.env` | **凭据 + 当前部署信息**：restic 仓库地址、S3 AK/SK、仓库密码、网络拓扑注释。权限 600，**勿提交**。 |
| `secrets.env.example` | 上面那份的脱敏模板（仓库可见），迁移到新机时按注释填。 |
| `systemd/copilot-backup.{service,timer}.example` | systemd user unit 模板（首次安装时拷到 `~/.config/systemd/user/` 并按机器路径编辑） |
| `backup.log` | 每次运行的追加日志 |

> 当前实际部署的网络拓扑（mesh IP / 端口 / 5 跳链路 / 为什么这么绕）在 `secrets.env` 顶部注释里有完整图示，**改部署时优先看那个**。

## 工作原理

### restic 怎么做「6.5 GiB 备成 1.7 GiB」

- **去重（CDC）**：文件按内容切成约 1 MiB 的块，相同块只物理存一份（块名 = 块内容的 SHA-256，即 *content-addressed*）。实测 6.52 → 5.13 GiB，省 21%。
- **压缩**：每个唯一块再用 zstd 压一遍。events.jsonl 是纯文本压得狠（≈3:1）；整体压缩比 3.01x、省 67%。
- 两步**无损叠加**：文件 = 一串块哈希清单，相同块共用一份但每个文件完整记录"我由哪些块组成"，重组 100% 逐字节还原。
- 之后每天**只传净增字节**——刚跑完第二次时实测仅上传 ~1 MiB（不是重传 1.7 GiB）。

### 端到端加密

- restic 在本机用 `RESTIC_PASSWORD` 派生 AES-256 密钥后再上传，后端**只见密文**。
- **连文件名、目录结构都加密**：后端被翻或入侵，没有这个密码既解不出内容、也看不出备了哪些文件。
- 唯一钥匙 = `RESTIC_PASSWORD`。**必须有一份本机以外的副本**，否则盘坏即永久无法恢复——见末尾「重要」段。

### SQLite 一致性

`~/.copilot/session-store.db` 是 SQLite WAL 模式，跑 Copilot CLI 时可能有未合并的 WAL。备份前在 Python 里跑 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合进主库再清空，让备份到的 `.db` 自洽。库正被独占时 checkpoint 是 best-effort（跳过即可），不影响主库一致性。

### systemd user timer

`copilot-backup.timer` 每天触发 `copilot-backup.service` 跑一次 `backup.sh`，午夜后 0–10 分钟随机抖动避免整点拥塞。

- `Persistent=true`：关机错过的触发，下次启动后补跑。
- 必须开 **linger**（`sudo loginctl enable-linger $USER`）—— *linger* 让 systemd 在你没登录时也保留这个用户的 user manager，否则用户级 timer 在你登出后就停了。

## 备份范围（实测）

备份**整个 `~/.copilot` 目录树**，排除运行时噪音 + SQLite 热文件。

实测（2026-06-27 重新对账）：

| 构成 | 大小 | 是什么 | 取舍 |
|---|---|---|---|
| `events.jsonl` × 1170 | 4.19 GiB | 每会话完整事件流，`/share html` 与 dredge-up 的唯一数据源 | ✅ 核心 |
| `rewind-snapshots/` × 26898 | 2.00 GiB | 被改文件的全字节快照，仅 `/rewind` 用 | ⚠️ 默认备，可砍 |
| 其余（db / md / yaml / json / env…） | 0.34 GiB | session.db、checkpoints、全局索引 session-store.db、配置、secrets | ✅ 备 |
| **小计：restic 实际处理** | **6.52 GiB** | restic 自报 snapshot size | |
| `logs/process-*.log` | 2.86 GiB | CLI 运行时 debug trace，跟会话恢复无关 | ❌ 排除 |
| `*.db-wal/-shm` + `*.lock` | ~3.5 MiB | SQLite 热文件 / 运行时锁 | ❌ 排除 |
| **源 `~/.copilot` 总大小** | **~9.45 GiB** | （`du --apparent-size`） | |

> 算账：9.45 ≈ 6.52（备）＋ 2.86（logs）＋ 0.003（热文件）＋ 0.07（du 与 restic 对稀疏/链接处理的固有差异），对得上。

restic stored 后实际占 **1.70 GiB**：6.52 → 5.13（去重省 1.4 GiB / 21%）→ 1.70（zstd 压缩 3.01x / 省 67%）。

## 首次安装

> 新机器照着做即可。

### 1. 装 restic（用户级，不需要 sudo）

```bash
mkdir -p ~/.local/bin
curl -fL https://github.com/restic/restic/releases/download/v0.19.0/restic_0.19.0_linux_amd64.bz2 \
  | bunzip2 > ~/.local/bin/restic
chmod +x ~/.local/bin/restic
~/.local/bin/restic version    # restic 0.19.0 ...
```

（系统包管理器装的 restic 也行；脚本默认找 `~/.local/bin/restic`，可在 `secrets.env` 里设 `RESTIC_BIN` 覆盖。）

### 2. 准备 backend

restic 支持很多 backend（S3-compatible / SFTP / REST / 本地路径……完整列表见 [restic docs](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)）。常用 S3 兼容（rustfs / MinIO / SeaweedFS / AWS S3 / B2 / R2）准备：

- endpoint URL（含端口）
- bucket name（bucket 本身要先存在；restic init 只在 bucket 内建对象前缀）
- access key id + secret access key（对该 bucket 至少要有 read/write/delete 权限）

### 3. 写 secrets.env

```bash
cd ~/path/to/copilot-backup
cp secrets.env.example secrets.env
chmod 600 secrets.env
# 编辑 secrets.env：按注释填 4 个 export（RESTIC_REPOSITORY / AWS_* / RESTIC_PASSWORD）
# 同时把顶部的"当前部署链路"注释改成你这台机的实际链路（mesh / portproxy / 直连？）
```

`RESTIC_PASSWORD` 建议随机生成：

```bash
openssl rand -base64 32        # 或: pwgen -s 32 1
```

### 4. 初始化 restic 仓库

```bash
set -a; source secrets.env; set +a
~/.local/bin/restic init
```

> ⚠️ **现在就把 `RESTIC_PASSWORD` 复制到密码管理器** —— 整套方案唯一的密钥单点故障，丢了永久解不开。详见末尾「重要」段。

### 5. 跑一次手动备份验证

```bash
./backup.sh --dry-run                   # 先 dry-run 看会备什么
./backup.sh                             # 真跑一次
~/.local/bin/restic snapshots           # 应看到一条新 snapshot
~/.local/bin/restic stats --mode raw-data
```

### 6. 装 systemd timer（每日自动备份）

```bash
mkdir -p ~/.config/systemd/user
cp systemd/copilot-backup.service.example ~/.config/systemd/user/copilot-backup.service
cp systemd/copilot-backup.timer.example   ~/.config/systemd/user/copilot-backup.timer

# 编辑这两份，把 ExecStart / StandardOutput / StandardError 里的相对路径
# 改成你本机的 backup.sh / backup.log 绝对路径

# 让 user timer 在你没登录时也能跑（需要 sudo 一次性配置）
sudo loginctl enable-linger $USER

systemctl --user daemon-reload
systemctl --user enable --now copilot-backup.timer
systemctl --user list-timers copilot-backup.timer    # 验证下次触发时间
```

## FAQ

### Q1. `6.52 GiB → stored 1.70 GiB`，是压缩吗？

是**去重 + 压缩两步叠加**，都是无损：

- **去重**：6.52 → 5.13 GiB —— 文件切成约 1 MiB 的块，内容相同的块只物理存一份（省 ~1.4 GiB / 21%）。
- **压缩**：5.13 → 1.70 GiB —— 每个唯一块再用 zstd 压缩；events.jsonl 是纯文本压得狠（≈3:1）；整体 3.01x、省 67%。

### Q2. 去重真的有重复吗？重复从哪来？

有，去重实打实扔掉了 1.4 GiB。来源：

- 每个 `events.jsonl` 里都嵌着同一大段 system prompt / instructions / skill 描述（每会话每轮重复）；
- `rewind-snapshots/` 同一文件被改多次、每次存整份拷贝，版本间大量重复。

### Q3. 去重后还能精确恢复吗？

**能，100% 无损、逐字节一致。** 原理是 *content-addressed storage*（块按其内容的 SHA-256 命名，文件 = 一串块哈希清单；相同块共用一份，但每个文件都完整记录"我由哪些块组成"）。已验证：restore 出的 `events.jsonl` 与原位 **sha256 完全相同**，且能直接喂给 `dump_session.py` 复刻出和官方 `/share html` 同款的 109 KB 单文件 HTML。

### Q4. 进程日志 `logs/` 为什么不备？

那是 CLI 自己的运行时 debug trace（给 `/diagnose` 排障、报 bug 用），跟"恢复你的会话"无关；体量最大（~3 GiB 还在涨）、瞬时过期、还掺敏感（代理端口、API 请求体）。**排除 ≠ 删除**：本地日志原封不动，`/diagnose` 排障不受影响。

### Q5. 敏感数据（local-secrets/*.env、mcp-config.json 等）安全吗？

**备了，而且是加密的。** restic 端到端 AES-256：数据在本机加密后才上传，后端只收到密文。

- 后端**没有** `xxx.env` 这种对象名，只有一堆 `data/<hash>` 的加密 pack；
- **连文件名、目录结构都加密**。后端被翻或入侵，没有 `RESTIC_PASSWORD` 既解不出内容、也看不出备了哪些文件。

### Q6. 增量到底多省？

首份 stored 1.70 GiB；之后每天只传**净增字节**。**刚跑完第二次时**实测仅 **1.06 MiB**（不是重传 1.7 GiB）。长期看，每次增量与"你这台机当天的会话净增字节量"同量级，会随活跃度浮动；总仓库大小靠 `forget --keep-daily/weekly/monthly` + `prune` 控制（保留策略见 `backup.sh`）。

## 运维速查

```bash
cd ~/path/to/copilot-backup
set -a; source secrets.env; set +a            # 载入凭据 + 仓库地址

./backup.sh                                    # 手动备份
./backup.sh --dry-run                          # 干跑，看会备什么、不实际写

restic snapshots                               # 看快照列表
restic stats --mode raw-data                   # 去重压缩后实际占用
restic stats --mode restore-size               # 还原后总大小（含全部 snapshot）

# 恢复（先到临时目录核对再合并；--include 可只取某个绝对路径）
restic restore latest --target /tmp/restore
restic restore latest --target /tmp/restore --include /home/agony/.copilot/session-state/<id>

# 把某会话的 events.jsonl 复刻成 share-html
SKILL=~/TiMidlY-projects/skills/skills/.curated/dredge-up/scripts
uv run "$SKILL/dump_session.py" <session-id> --events <events.jsonl路径> --format html --out report.html

# systemd timer
systemctl --user list-timers copilot-backup.timer       # 看下次触发
systemctl --user disable --now copilot-backup.timer     # 暂停自动化
journalctl --user -u copilot-backup.service -n 50       # service 日志
tail -f backup.log                                       # 跟踪追加日志
```

完整恢复到新机：装 restic → 写 `secrets.env`（同样的 `RESTIC_REPOSITORY` + AK/SK + `RESTIC_PASSWORD`）→ `restic restore latest --target /`。

## ⚠️ 重要

### 🔴 `RESTIC_PASSWORD` 必须备到本机以外

这是整套方案唯一的**密钥**单点故障：仓库本身是用这个密码加密的，所以「把密码也备进 restic 仓库」等于把唯一钥匙锁进了它要开的保险柜——一旦本机这块盘坏了 / `secrets.env` 误删，后端的 1.7 GiB 备份就**永久解不开**（后端被翻也解不开，这正是端到端加密的目的；但反过来对你也是一样）。

> 注：另一类"数据丢失"是 backend 本身的 pack 文件丢了——那不是密钥问题，是数据本身没了。如果担心后端可靠性，restic 支持把同一份数据写到多个 backend（异地双活）；本文不展开。

**必须做的一步**（agent 不会代做，凭据只能本人持有）：

```bash
grep ^RESTIC_PASSWORD= ~/path/to/copilot-backup/secrets.env
# 复制 = 后面的值（别用 cat —— 那会把 AK/SK 一起喷进 scrollback）
```

把这个值粘到密码管理器（Bitwarden / 1Password / KeePassXC 等）或异机备份的笔记里。**至少要在另一台设备上有一份**。

恢复时只要有这个密码 + restic 仓库地址 + AK/SK，从零（空机器装个 restic）就能 `restic restore` 出全部备份。

### 其他

- `secrets.env` 含明文凭据（S3 AK/SK + restic 密码），**切勿 git 提交**。本目录（`~/TiMidlY-projects/copilot-backup/`）当前不在任何 git 仓库内，所以暂无被追风险；若未来要把它纳入 git 管理，先在工作区根 `.timidly-excludes` 加一行 `copilot-backup/secrets.env`（或在本目录加 `.gitignore`），再 `git init`。别复制粘贴到别处。
- **想省 2.0 GiB**：在 `secrets.env` 里取消注释 `export BACKUP_EXCLUDE_REWIND=1` 即可（不影响 share-html / `--resume` / dredge-up）。
  - `rewind-snapshots/` = 每个 session 目录（`~/.copilot/session-state/<id>/rewind-snapshots/`）下的**被改文件全字节快照**，仅给 Copilot CLI 的 `/rewind`（撤销上一轮的文件改动）用。这功能你大概率用不上（出问题更多靠 git）。
