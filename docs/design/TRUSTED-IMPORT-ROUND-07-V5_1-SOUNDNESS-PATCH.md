# 第七轮讨论：v5.1 证明闭合补丁（Soundness Patch）与 E2E 状态机全量修正

> **性质**：讨论记录与正式补丁说明。含 **(A) 端到端推演中暴露的 9 处连接语义缺陷（P0–P2）**、
> **(B) 对应的规范修正方案（含 A6 路径契约、两阶段闭包与目标树构造公式）**、
> **(C) 16 步完整生命周期状态机（Proof-Closed E2E State Machine）**。
>
> **上游**：`TRUSTED-IMPORT-ROUND-06-RULING.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v5）。

---

## 0. 本轮定位：真正的 Proof Closure（证明闭合）

在第 6 轮收敛 A1–A5 后，我们转向全流程生命周期端到端推演（`adopt → materialize → executor → snapshot → deny/fix → acceptance → update-ref → rematerialize`）。
推演结果表明：**主 Invariant 屹立不倒，但在“上游模块输出如何作为下游模块输入”的连接语义处，暴露了数个致命的逻辑与安全裂缝**。

本轮不增加第十个正式对象，而是通过 **v5.1 Soundness Patch** 将这些裂隙完全焊死。

---

## 1. 缺陷裁决与修正明细（P0–P2）

| 优先级 | 缺陷定位 | 根因与风险 | v5.1 修正方案 |
|---|---|---|---|
| **P0** | `SNAPSHOT → FS SCAN` 顺序颠倒 | `snapshot_digest` 依赖路径、模式、blob 哈希；未扫描之前 Snapshot 不可能存在 | 改为主流水线：`QUIESCE → BOUNDED FS CAPTURE → SEAL SNAPSHOT → DIFF`；且在 Capture 阶段前置机械配额（防御 100GB DoS） |
| **P0** | Manifest Baseline 定义失真 | 若直接以 Canonical Tree 为基准做 diff，被 `projection.exclude` 的敏感文件会被误算为 `DELETE` | 明确差异基准：`Candidate Manifest (Executor Delta) = Projected Baseline Snapshot ↔ Candidate Revision Snapshot` |
| **P0** | Promotion 目标树丢失排除文件 | 若 promotion 仅由已批准 candidate blob 构造，则 canonical 中被 exclude 的 `.env` 等文件会在新 tree 中丢失 | 确立公式：`TARGET_CANONICAL_TREE = BASELINE_CANONICAL_TREE + AUTHORIZED PATCH`；未暴露的 canonical 文件严格原样继承 |
| **P0** | `projection.redact` 缺乏逆变换 | candidate 修改了含 `***` 的文件后，promotion 无法将脱敏占位符逆向还原为真实 secret，导致 secret 被破坏 | **V1 显式禁止 `projection.redact`**；敏感结构化文件整文件排除。复杂逆向合并留待未来扩展 |
| **P0** | Acceptance Staging 与对象脱节 | 若有 unresolved DENY，剔除被拒文件后验收测的不是 candidate 真实产物；且 staging 仅放变更文件无法运行测试 | ① 引入 **Pre-acceptance Closure**：有 unresolved DENY 严禁跑验收；② Staging 包含 `Projected Baseline + Authorized Patch + Synthetics` |
| **P0/P1** | 测试资产被 candidate 篡改 | 敌对代码可删除失败用例或弱化 assertion 骗取 PASS | 区分诊断测试与门禁测试；引入 **Trusted Acceptance Assets**（只读挂载于 candidate 外部的测试套件）作为唯一 promotion 门禁依据 |
| **P1** | `synthetic_dirs` 扫描整目录忽略 | 若 scanner 忽略 `dist/`，executor 写入 `dist/evil.js` 将完全绕过扫描 | `dist/` 作为空目录存在于 Projected Baseline 中；**其下任何子条目必须完整参与 FS 扫描**并产生 `ADD` delta |
| **P1** | 缺少 Path Identity Contract | Linux 文件名不强制 UTF-8；非法编码在 Node 字符串转换后可能碰撞，破坏策略匹配与哈希 | 新增 **A6 Canonical Path Contract**：必须为相对路径、`/` 分隔、严格 UTF-8、Unicode NFC 规范化、无 `.`/`..`、区分大小写；违者准入即拒 |
| **P2** | 文本与测试用例残留旧语义 | TI-13 提 journal fallback（非 Git 早已准入即拒）；TI-9 提 policy 任一变动作废 Grant（冲突 C5） | 彻底删除非 Git journal 残留；TI-9 修正为仅 `scope_digest` 等授权字段变化时作废；清理 `canonical absent` 模糊措辞 |

---

## 2. 核心数学与架构公式固化

### 2.1 差异与目标树分离公式

```text
1. 投影基准派生（只读视图）：
   Projected Baseline Snapshot = Derive(Canonical Baseline Tree, Projection Policy)

2. 执行器实际修改（语义评估基准）：
   Executor Delta = Diff(Projected Baseline Snapshot, Candidate Revision Snapshot)

3. 最终提升目标树（写回 Git 真源）：
   Target Canonical Tree = Canonical Baseline Tree + Authorized Delta
   （规则：Candidate-visible 依授权修改；Excluded/Masked/Untouched 严格原样继承）
```

### 2.2 两阶段闭包验证（Two-Phase Closure）

- **Pre-acceptance Closure（准入验收门）**：
  - Cumulative Manifest 中的所有变更项在当前 `Policy + Scope Grant` 下均有效授权；
  - **不存在任何未解决的 DENIED 项**（若有，任务处于 blocking remediation obligation，直接中断，不跑验收）；
  - 确定待验收视图：`Promotable Acceptance View = Projected Baseline + Authorized Patch + Synthetic Dirs`。
- **Final Revalidation & CAS Promotion（最终提升门）**：
  - 验收通过后，再次原子核验：Snapshot 内容未变、授权状态未变、策略未变；
  - 核验 `refs/afr/canonical` 当前 OID 仍等于 `expected baseline_oid`；
  - 构造 Commit 并执行 `git update-ref refs/afr/canonical <new_oid> <baseline_oid>`。

### 2.3 A6 Canonical Path Contract（文件系统契约扩展）

路径合法性作为 Canonical Filesystem Contract 的不可分割子集：
1. **纯相对路径**：不得以 `/` 开头，不得含盘符；
2. **单一分隔符**：严格使用 `/`，禁止连续分隔符（如 `a//b`）；
3. **有效字符编码**：必须是合法、规范的 UTF-8 字节序列；
4. **Unicode NFC**：统一执行 Unicode 规范化形式 C（NFC），防止视觉相同但字节不同的跨系统歧义；
5. **严禁遍历符号**：不得包含 `.`、`..` 段；
6. **无 NUL 字节**；
7. **严格区分大小写**；
8. **违反契约处理**：在 Capture 阶段作为 B(i) 机械拒绝，严禁进入 CAS 与 Manifest。

---

## 3. 完整 16 步生命周期状态机（Proof-Closed E2E State Machine）

```text
0. ADOPT
   commit-ish ──(受信解析)──> exact commit OID
   Canonical Admission Scan（A5 文件系统契约 + A6 路径契约）
   git update-ref refs/afr/canonical <new_oid> <zero_oid>

1. PROJECT
   canonical tree + Projection Policy
   ──> Projected Baseline
   ──> Repair Baseline View (/baseline/, 只读)
   ──> synthetic empty dirs (mkdir -p, 0755)
   ──> Live Candidate 工作区

2. EXECUTE
   不受信执行器在隔离容器内运行
   自由产生 candidate 变更（可肆意破坏 candidate 工作区）

3. QUIESCE
   停止执行器容器，SIGKILL 兜底清理所有子进程/孤儿进程
   锁定 candidate 文件系统进入只读检查状态

4. BOUNDED FS CAPTURE
   受信控制面执行受限全树扫描（深度、文件数、单文件大小硬限额）
   lstat 检查 inode 类型（B(i) 硬拒 symlink/device/fifo 等）
   校验 A6 路径契约
   计算原始字节 SHA-256，将合法 raw bytes 存入 Trusted CAS

5. SEAL SNAPSHOT
   按规范计算 snapshot_digest = H(schema_version + sorted(path, type, mode, blob_digest))
   密封生成 Candidate Revision Snapshot 及其不可变 CAS 引用集

6. DIFF
   Projected Baseline Snapshot ↔ Candidate Revision Snapshot
   精确计算 Candidate Manifest（ADD/MODIFY/DELETE/MODE）

7. AUTHORIZE
   机械门过滤 A/B(i)/B(ii)/D
   Scope Verifier 评估 C 带扩展
   逐项写入 Authorization Ledger（记录 provenance）
   若存在任何 DENY ──(YES)──> 记录 blocking remediation obligation，转入修复循环，流程阻断
                       └──(NO)──> 进入下一阶段

8. CONTENT REVIEW
   基于不可变 Snapshot 内容评审实现质量

9. PRE-ACCEPTANCE CLOSURE
   全量 cumulative manifest 逐项核验授权有效性
   核对无任何 blocking obligations，确认策略版本当前有效

10. BUILD ACCEPTANCE VIEW
    Projected Baseline + Authorized Cumulative Patch + Synthetic Dirs
    绝不挂载 canonical .git；若需要 Git 则在临时目录 git init 消毒仓库

11. ACCEPTANCE
    挂载只读 Trusted Acceptance Assets（受信门禁测试）
    分流运行：Diagnostic（白名单诊断输出）与 Opaque（含密，日志隔离入 Quarantine）
    验收未通过 ──> 标记失败，阻断提升

12. FINAL REVALIDATION
    重新验证 Snapshot 未被篡改、授权凭证仍有效、策略未降级、baseline OID 未被并发推进

13. BUILD TARGET CANONICAL TREE
    Baseline Canonical Tree + Authorized Cumulative Patch
    保持 Excluded/Masked 敏感文件原封不动继承

14. PROMOTE
    以 Target Canonical Tree 构造 Git commit
    执行 CAS 提交：git update-ref refs/afr/canonical <new_oid> <baseline_oid>

15. REMATERIALIZE & VERIFY
    Trusted Worktree Materializer 从 canonical Git blob 重建宿主工作区只读缓存
    对比校验 Materialized View 散列与 Canonical Tree 完全吻合
```

---

## 4. 结论

本推演全面修复了 v5 阶段残留的 9 处深层隐患。至此，从初始化接入、安全捕获、差异比对、双阶段授权闭包到最终原子提升，全链路各状态节点均经受住了对抗性写路径审查，安全模型正式达成 **Soundness Closure**。
