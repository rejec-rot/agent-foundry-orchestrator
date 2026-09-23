# U6 live 验收签字清单（**未签字前不执行任何 live 动作**）

状态：**待签署**。本文件只准备执行方案，**未启用 live、未安装/启用任何单元、未挂载、未外发**。
回退点：`88a76c6`（tag `stage5-u5-dry-run-authorization`）；最新本地矩阵固定点 `c5c54fc`（tag `stage5-u6-local-matrix-batch3`）。

> **执行原则**：本清单签署后，我**手动**运行命令（**不安装 timer、不 enable 单元**），逐条核对预期证据；
> **任何一条不符即停**并回报。超出本清单范围的动作一律不做。

---

## 1. 签字前必须由操作者填写的输入（缺一项即不执行）

| # | 输入 | 由操作者填写 | 说明 |
|---|---|---|---|
| 1 | **白名单资产** | `canonical_dir = /home/reject/DSHWorkSpace/u6-live-asset/canonical` `cas_dir = /home/reject/DSHWorkSpace/u6-live-asset/cas` | 必须**精确真实路径**，且**必须是一个"真实处于保留态"的资产**（见下方红框）；本轮建议仅 1 个；**不得**包含生产关键仓库 |
| 2 | **执行器与身份** | author = `codex` / reviewer = `cline` / 运行身份 = `uid 1000`（本轮 live 恢复不调用任何模型，此项仅备案） | A1a live 本身不调用模型；此项只决定后续若跑真实任务时的组合 |
| 3 | **限额** | 并发 = `1` / 单任务时限 = `30min` / 模型调用与费用上限 = `0`（本轮不执行任务）/ 磁盘与日志上限 = `100MB / 30d` | A1a live 恢复不消耗模型额度；限额用于同一观察窗口内的任务 |
| 4 | **通知** | `AF_BOUNDARY_NOTIFY_MODE=off`（保持默认，不透发） | 本清单默认 **off**：不外发 |
| 5 | **观察窗口** | 时长 = **单次执行**（不设观察窗口）/ 值守人 = `reject`（操作者）/ 立即停用条件 = **首异常即停**（范围异常、审计写失败、权限漂移、`RECONCILE_*`、`status` 非 0） | 建议：≥24h、首异常即停、范围异常/审计失败/权限漂移任一出现即停 |
| 6 | **回退版本** | `29f0c53`（tag `stage5-u6-live-rehearsal`） | 建议 `c5c54fc`（含全部本地矩阵）或 `88a76c6`（U5 固定点） |
| 7 | **签署** | 姓名 `reject` / 日期 `2026-09-23` / 授权范围摘要 = 仅第 1 项**单一非生产资产**、**单次** live sweep、通知 off、不安装不启用单元（本行由执行代理按操作者会话内明确授权「我现在授权帮我签」**代填**） | 见 §6 |

---

> **⚠ 关键前提（最容易踩的坑）**：`eligible=true` 只对**真实保留态**的资产成立。§2 要求 12 条 guard 全 true，
> 其中 3.2/3.6/3.7 需要：**生命周期真实产生**的 `PROTECTION_RETAINED_PENDING_RECOVERY`（有保护 epoch、有效快照）、
> 任务记录里**作者/评审终止证据齐全**、scope 确认为空。**新建的空白或一次性夹具永远到不了 live**
> （会停在 3.2/3.6/3.7）——这不是故障，是设计。若手上没有这样的真实资产，就**不要签字**，改用 dry-run 路径。

## 2. 执行前核对（只读，零变更）

```sh
# 1) 回退点与工作树
git -C <repo> rev-parse HEAD && git -C <repo> status --porcelain   # 期望：干净，HEAD = 签字版本

# 2) 默认关闭（未设置即为 off）
echo "AF_A1A_MODE=${AF_A1A_MODE:-<unset=off>} AF_BOUNDARY_NOTIFY_MODE=${AF_BOUNDARY_NOTIFY_MODE:-<unset=off>}"

# 3) 未安装任何单元
ls /etc/systemd/system/af-a1a-recovery.* /etc/systemd/system/af-boundary-notify.* 2>/dev/null | wc -l   # 期望 0

# 4) 白名单与资格解释（read-only）—— env 必须与生命周期当初一致，否则资格会被误拒
AF_A1A_MODE=dry-run \
AF_A1A_ALLOWLIST_FILE=<allowlist> \
AF_TASKS_DIR=<tasks> \
AF_BOUNDARY_AUDIT_DIR=<audit> \
AF_BOUNDARY_SNAPSHOT_DIR=<snapshots> \      # 3.6 快照：缺失即拒；默认 ~/.agent-foundry/host-boundary-snapshots 或 /tmp/af-host-boundary-snapshots
AF_PROTECTION_EPOCH_DIR=<audit>/epochs \    # 3.7 预期保护元数据 epoch；默认 <AF_BOUNDARY_AUDIT_DIR>/epochs
AF_CGROUP_BASE=<scope base> \               # 3.5 scope 扫描直接读它；缺失即"无法确认"→ 拒
node af-admin.mjs a1a status --json
node af-admin.mjs a1a explain --canonical <canonical> --cas <cas> --json
```

> 上面 5 个 env（含 `AF_BOUNDARY_SNAPSHOT_DIR` / `AF_PROTECTION_EPOCH_DIR` / `AF_CGROUP_BASE`）**必须与生命周期当时的取值一致或指向同一默认位置**；
> 任一不同，资格会因"快照缺失 / 无 epoch / scope 无法确认"被拒——那是配置不一致，不是资产有问题。

**预期**：`status` 显示 `mode=dry-run`、白名单 1 个资产、`state` 可核验（或 `missing` 表示尚无状态）；
`explain` 的 12 条 guard 全为 true（`eligible=true`），否则**停止**——资格不满足就不该进入 live。

---

## 3. live 执行（手动、单次、逐条核对）

```sh
# 单次 live sweep（不装 timer；--confirm 是刻意的第二道门）
AF_A1A_MODE=live \
AF_A1A_ALLOWLIST_FILE=<allowlist> \
AF_TASKS_DIR=<tasks> \
AF_BOUNDARY_AUDIT_DIR=<audit> \
AF_BOUNDARY_ALERTS_FILE=<alerts> \
AF_BOUNDARY_SNAPSHOT_DIR=<snapshots> \
AF_PROTECTION_EPOCH_DIR=<audit>/epochs \
AF_CGROUP_BASE=<scope base> \
AF_ASSET_LOCK_DIR=<locks> \
AF_BOUNDARY_NOTIFY_MODE=off \              # 本轮明确不外发
node af-admin.mjs a1a sweep --confirm --json
```

**逐条预期证据**（任何一条不符即停）：

| # | 检查 | 预期 |
|---|---|---|
| E1 | 退出码（**已加固**） | `0` = 无事可做或干净完成；`1` = **有资产需人工**（`RECONCILE_*`/`RESTORE_INCOMPLETE`/耗尽/拒绝/延后）；`3` = **有资产无法核验**（绝不当作"无事可做"）。`1`/`3` → **停并回报**。**不要只看退出码**：以 E2 的逐资产 `decision/outcome` 为准（加固前 `RECONCILE_REQUIRED` 会返回 0，属缺陷，已修） |
| E2 | 决策 | 该资产 `decision=WOULD…/ATTEMPTED` → 成功时最终 `DISENGAGED` + `delivered=true` |
| E3 | 恢复审计 | A1a live **会传 `persistTask`**，故成功链为 `intent(1) → mutation-started(2) → result(3) → persisted(4) → alert-closed(5)`；**必须含 `persisted(4)`**（缺即意味着任务落盘未完成 → 应为 `RECONCILE_RECORD` 而非成功）。人工 CLI 路径无该钩子，链为 1→2→3→5 |
| E4 | 告警 | 成功后该资产告警**关闭**（`open=false`）；失败则**保持开放**且不计成功 |
| E5 | 权限 | 资产属主/模式**按快照逐条还原**；`state=RECONCILE_*` 时**不得**再次释放 |
| E6 | 状态 | `a1a/state.json`：`attempts` 递增、`phase` 与 `next_attempt_at` 合理（退避 `min(base·2^(n-1),cap)`） |
| E7 | 审计不可核验 | 若出现 `unverifiable` → 退出码 **3** → **立即停用并人工核对** |
| E8 | 残留 | 无 `asset-*.lock` 残留、无 `registry.lock` 残留、无 `/tmp` 夹具遗留 |

**复核命令**：`node af-admin.mjs a1a status --json`、`boundary alerts [--include-resolved]`、`boundary notify-status`（通知 off 时应为 0 待办）。

---

## 4. 立即停用（任一异常时）

```sh
# 1) live 关闭（不存在被 enable 的 timer，因此无需 systemctl）
unset AF_A1A_MODE            # 或 AF_A1A_MODE=off

# 2) 保留全部证据：不删除 audit/、epochs/、state.json、通知队列
# 3) 若资产处于 RECONCILE_REQUIRED / RECONCILE_RECORD：按人工核对流程处理，绝不再次释放
node af-admin.mjs a1a status --json          # 期望：mode=off；需人工项仍可见
```

**停止条件（任一出现即停并回报）**：范围异常未被解释、`unverifiable`、审计写失败、权限还原不符快照、
`RECONCILE_*`、通知出现意外外发、任何超出签字资产范围的资产被触及。

---

## 5. 回退

1. 代码回退：`git checkout <签字回退版本>`（默认 `c5c54fc`）；**回退前确认 `AF_A1A_MODE` 已为 `off`**。
2. 状态/证据：**保留** `audit/`、`epochs/`、`state.json`、告警与通知队列（它们是证据，不是垃圾）。
3. 若已在真实资产上完成恢复且怀疑误判：按 `A1A-AUTO-RECOVERY-DESIGN.md` §8.3——**重新施加保护**并调查，
   **禁止**用自动路径重新保护。
4. 回退后核对：`a1a status` 为 `off`、无未被解释的锁文件、告警状态与恢复记录一致。

---

## 6. 签署

| 项 | 内容 |
|---|---|
| 授权范围 | 仅 §1 填写的**单一白名单资产**；**通知保持 off**；不安装/不启用任何单元；单次或限定次数执行 |
| 明确不含 | 真实模型任务执行（除非 §1 第 2/3 项另行签字）、任何外发、ENOSPC 特权挂载、其它资产 |
| 签署人 / 日期 | `reject` / `2026-09-23`（经操作者会话内明确授权，由执行代理代填） |
| 回退版本 | `29f0c53`（tag `stage5-u6-live-rehearsal`） |

> **未签署 = 不执行。** 本清单不改变任何默认值：`AF_A1A_MODE` 缺省 `off`、白名单缺省为空、
> 单元未安装、通知缺省 off。**无人值守生产验收在签署并执行、且证据全部符合预期之前仍为未通过。**
