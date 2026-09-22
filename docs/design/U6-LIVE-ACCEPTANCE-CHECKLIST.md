# U6 live 验收签字清单（**未签字前不执行任何 live 动作**）

状态：**待签署**。本文件只准备执行方案，**未启用 live、未安装/启用任何单元、未挂载、未外发**。
回退点：`88a76c6`（tag `stage5-u5-dry-run-authorization`）；最新本地矩阵固定点 `c5c54fc`（tag `stage5-u6-local-matrix-batch3`）。

> **执行原则**：本清单签署后，我**手动**运行命令（**不安装 timer、不 enable 单元**），逐条核对预期证据；
> **任何一条不符即停**并回报。超出本清单范围的动作一律不做。

---

## 1. 签字前必须由操作者填写的输入（缺一项即不执行）

| # | 输入 | 由操作者填写 | 说明 |
|---|---|---|---|
| 1 | **白名单资产** | `canonical_dir = ______` `cas_dir = ______` | 必须**精确真实路径**；本轮建议仅 1 个资产；**不得**包含生产关键仓库 |
| 2 | **执行器与身份** | author = ______ / reviewer = ______ / 运行身份 = ______ | A1a live 本身不调用模型；此项只决定后续若跑真实任务时的组合 |
| 3 | **限额** | 并发 = __ / 单任务时限 = __ / 模型调用或费用上限 = __ / 磁盘与日志上限 = __ | A1a live 恢复不消耗模型额度；限额用于同一观察窗口内的任务 |
| 4 | **通知** | 保持 `off`（默认） / 启用 live（需另附私密 webhook 与明确同意） | 本清单默认 **off**：不外发 |
| 5 | **观察窗口** | 时长 = __ / 值守人 = ______ / 立即停用条件 = ______ | 建议：≥24h、首异常即停、范围异常/审计失败/权限漂移任一出现即停 |
| 6 | **回退版本** | `______` | 建议 `c5c54fc`（含全部本地矩阵）或 `88a76c6`（U5 固定点） |
| 7 | **签署** | 姓名 ______ 日期 ______ 授权范围摘要 ______ | 见 §6 |

---

## 2. 执行前核对（只读，零变更）

```sh
# 1) 回退点与工作树
git -C <repo> rev-parse HEAD && git -C <repo> status --porcelain   # 期望：干净，HEAD = 签字版本

# 2) 默认关闭（未设置即为 off）
echo "AF_A1A_MODE=${AF_A1A_MODE:-<unset=off>} AF_BOUNDARY_NOTIFY_MODE=${AF_BOUNDARY_NOTIFY_MODE:-<unset=off>}"

# 3) 未安装任何单元
ls /etc/systemd/system/af-a1a-recovery.* /etc/systemd/system/af-boundary-notify.* 2>/dev/null | wc -l   # 期望 0

# 4) 白名单与资格解释（read-only）
AF_A1A_MODE=dry-run AF_A1A_ALLOWLIST_FILE=<allowlist> \
AF_BOUNDARY_AUDIT_DIR=<audit> AF_TASKS_DIR=<tasks> \
node af-admin.mjs a1a status --json
AF_A1A_MODE=dry-run AF_A1A_ALLOWLIST_FILE=<allowlist> … \
node af-admin.mjs a1a explain --canonical <canonical> --cas <cas> --json
```

**预期**：`status` 显示 `mode=dry-run`、白名单 1 个资产、`state` 可核验（或 `missing` 表示尚无状态）；
`explain` 的 12 条 guard 全为 true（`eligible=true`），否则**停止**——资格不满足就不该进入 live。

---

## 3. live 执行（手动、单次、逐条核对）

```sh
# 单次 live sweep（不装 timer；--confirm 是刻意的第二道门）
AF_A1A_MODE=live \
AF_A1A_ALLOWLIST_FILE=<allowlist> \
AF_BOUNDARY_AUDIT_DIR=<audit> \
AF_TASKS_DIR=<tasks> \
AF_ASSET_LOCK_DIR=<locks> \
node af-admin.mjs a1a sweep --confirm --json
```

**逐条预期证据**（任何一条不符即停）：

| # | 检查 | 预期 |
|---|---|---|
| E1 | 退出码 | `0`（无待办/已处理）；`1` 表示需人工或耗尽 → **视为异常并停** |
| E2 | 决策 | 该资产 `decision=WOULD…/ATTEMPTED` → 成功时最终 `DISENGAGED` + `delivered=true` |
| E3 | 恢复审计 | `audit/` 下该资产出现 `intent(1) → mutation-started(2) → result(3) → alert-closed(5)`，阶段序号齐全 |
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
| 签署人 / 日期 | ____________________ |
| 回退版本 | ____________________ |

> **未签署 = 不执行。** 本清单不改变任何默认值：`AF_A1A_MODE` 缺省 `off`、白名单缺省为空、
> 单元未安装、通知缺省 off。**无人值守生产验收在签署并执行、且证据全部符合预期之前仍为未通过。**
