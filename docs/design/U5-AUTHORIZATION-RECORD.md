# U5 authorization record — A1a dry-run trial

状态：**已授权范围 = 仅 dry-run**。**live 未授权**；未安装、未启用任何 systemd 单元；未外发任何通知；白名单只含一个**专用非生产**测试资产。

本记录对应 `UNATTENDED-ROLLOUT-PLAN.md` 的 U5（授权试运行）。U6（生产验收 / live）所需的其余确认仍待操作者提供，见文末。

## 1. 操作者确认项

| # | 项目 | 本轮确认值 |
|---|---|---|
| 1 | 白名单资产 | **专用非生产测试资产**（一次性、可丢弃），路径见 §2 |
| 2 | 执行器与身份 | 本轮 dry-run **不调用任何执行器**；live 执行器组合留待 U6 确认 |
| 3 | 限额 | 本轮 **不触发**：dry-run 不调用模型、不改状态、不发通知。并发/时限/调用/费用上限留待 U6 |
| 4 | 通知目的地 | **off**：本轮不外发。此前的一次性 webhook 测试**不继承**到本计划；如启用 live 需另行明确授权 |
| 5 | 允许的操作 | **仅 `AF_A1A_MODE=dry-run`**：只判定与写 `a1a_would_recover`/`a1a_ineligible` 审计，**零权限/任务/告警/状态变更** |
| 6 | 观察窗口与停止条件 | 本轮为单次 dry-run 审阅；live 观察窗口、值守人、立即停用条件与回退版本留待 U6 |

## 2. 白名单（专用测试资产，非生产）

`AF_A1A_ALLOWLIST_FILE=/home/reject/DSHWorkSpace/a1a-u5-test/allowlist.json`

```json
{
  "schema": "af-a1a-allowlist-v1",
  "assets": [
    {
      "canonical_dir": "/home/reject/DSHWorkSpace/a1a-u5-test/canonical",
      "cas_dir": "/home/reject/DSHWorkSpace/a1a-u5-test/cas",
      "task_id": "T-A1A-U5",
      "max_attempts": 3
    }
  ]
}
```

测试夹具（一次性，可整体删除）：`canonical/`（小仓库内容）、`cas/`、`tasks/T-A1A-U5.json`（合成任务，声明 `boundary_state=PROTECTION_RETAINED_PENDING_RECOVERY`、`task.state=COMPLETED`、作者终止证据齐全）、`scopes/`（空，模拟无可确认写者）、`audit/`。该夹具**未被真实保护**（属主仍为 1000），因此预期在资格判定阶段被拒绝——这正是否定路径的验收目的。

## 3. 本轮 dry-run 观察结果

```
af-admin a1a status   -> mode=dry-run, allowlist=1 asset, state=missing(空), exit 0
af-admin a1a explain  -> allowlist match=yes; eligible=false; first_failure=3.6-snapshots-valid
af-admin a1a sweep    -> REFUSED_INELIGIBLE a1a_ineligible(3.6-snapshots-valid), exit 1
```

逐项 guard（`explain` 输出）：3.1 allowlist ✅、3.2 boundary-state ✅、3.3 task-terminal ✅、
3.4 终止证据 ✅、3.5 scopes empty ✅、**3.6 snapshots ❌**、**3.7 protection epoch ❌**、
3.8 审计可写 ✅、3.9 预算 ✅、3.10 无未完成恢复 ✅、3.11 资产锁 ✅、3.12 通知独立 ✅。

结论：引擎在真实输入上**按设计 fail-closed**（无快照/无 epoch 即拒绝，不猜、不释放）。

零变更证据（dry-run 后）：
- 测试资产属主仍为 `1000`（未释放、未改权限）。
- 审计目录仅新增 `audit/a1a/events.jsonl`（一条 `a1a_ineligible`）；**未写 `state.json`**。
- 任务文件字节未变；仓库无 `runtime/asset-locks/` 等残留。

## 3.1 正向路径观察（本轮补做：真实保护后的 dry-run）

§3 的夹具**未被真实保护**，因此只覆盖了**拒绝路径**。dry-run 的意义还包括在**满足全部资格**时
确认"将要恢复"而不动手，故补做一次正向观察（`verification/a1a-dry-run-eligible.mjs`，可重复执行）：

一次性夹具（临时目录，可整体删除）：真实 `engageTaskHostBoundary()` 施加保护（root 属主 +
快照 + **保护 epoch**），合成任务记录（`COMPLETED` + 作者终止证据齐全 + 保留边界 + 与告警一致的
`alert_id`），空 scope 基目录，专用审计根与锁目录；`AF_A1A_MODE=dry-run`。

```
af-admin a1a status  -> mode=dry-run, exit 0
af-admin a1a explain -> eligible=true（12 条 guard 全过）
af-admin a1a sweep   -> decision=WOULD_RECOVER, exit 0
```

16/16 断言通过（连续 3 次），其中包括**零变更**证据：

- 属主/权限/模式逐条**完全不变**，夹具仍为 root 属主（保护未被释放）；
- 任务记录与告警日志**字节不变**；
- **未写 `state.json`**（预算未被消费）；仅新增 `a1a/events.jsonl` 中的一条 `a1a_would_recover`；
- 无资产锁文件残留；
- 收尾用**受控恢复**（非 `force`）：`outcome=DISENGAGED`、`delivered=true`，夹具属主归还 1000。

> 结论：dry-run 在**正向路径**上同样只写审计、不动权限/任务/告警/状态，且资格满足时可稳定
> 到达 `WOULD_RECOVER`。

## 3.2 夹具处置

U5 的一次性夹具 `/home/reject/DSHWorkSpace/a1a-u5-test/` 在记录完成后**已删除**：它是**未被真实保护**
的合成目录（`boundary_state` 声明为保留态但属主仍是 1000），留着既无独有证据（结果已在上文），
又容易被误当作真实保留资产指向白名单。它的两条路径都可用仓库内脚本/配方随时重建：正向见
`verification/a1a-dry-run-eligible.mjs`，拒绝路径只需按 §2 重建同样（未保护）的夹具。

## 4. U5 期间发现并修复的缺陷（回归见 A1A-5）

`a1a explain` 对**pin 了 `task_id` 的白名单条目**报 “not allowlisted”（3.1 失败），而 `a1a sweep`
（直接使用条目）却能匹配——两者结论不一致。原因：`matchAllowlistAsset` 在调用方未指定 task 时，
仍用 `null` 去比对条目 `task_id`。已修正为「仅当调用方**显式**给出且与条目冲突时才算不匹配」，
并加回归断言。修复后 `explain` 与 `sweep` 结论一致（均为 3.6）。

## 5. 待操作者提供（U6 / live 前置，缺失即“不做”）

1. **live 限额**：并发任务数、单任务时限、模型调用/Token/费用上限、磁盘与日志上限。
2. **live 执行器与身份**：author/reviewer 执行器与运行身份（AGY 仍因 403 排除）。
3. **通知 live**：是否启用飞书四态卡片外发；如启用，提供私密 webhook/token（不进仓库）。
4. **观察窗口与停止条件**：观察时长、值守人、立即停用条件。
5. **回退版本**：确认回退目标（当前 U4 提交 `43efcf3`；最近 tag `stage5-u3-a1a-dry-run`，U4 tag 名待确认）。

## 5.1 构建正向探针时发现的接口细节（非缺陷，已记录）

`readA1aEvents()` 接收**解析后的 cfg**（内部据此推导审计目录），传 `{file}` 形状会抛
`ERR_INVALID_ARG_TYPE`。这是内部 API 契约，调用方须先 `a1aConfig()`；已在探针中修正，
未改动生产代码。

## 6. 不可放宽的边界

- 本记录只授权 **dry-run**；`live` 与 `--confirm` 均不在本轮范围内。
- 未安装/未启用任何单元，未发送任何通知，白名单仍只含上表测试资产。
- live 前必须完成 §5 的全部确认，并按 U6 故障矩阵验收。
