# 第九轮裁决：执行环境模型收敛与工程层裁定（Execution Environment Ruling）

> **性质**：对第八轮「工程可行性复审」的最终正式裁决与方案收敛记录。
> **核心突破**：在不增加 9 个正式安全对象的前提下，引入 **Source / Runtime / Evidence 三层执行环境模型**，彻底打通“安全形式化证明”与“真实工程可运行性”之间的鸿沟。
> **上游**：`TRUSTED-IMPORT-ROUND-08-ENGINEERING-REALISM-REVIEW.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v5.1）。

---

## 0. 本轮总览：双轨统一与三大执行层

第八轮提出的“安全模型正确”与“真实工程能不能跑”的划分极其关键。本轮裁决全面采纳了工程现实约束，同时对几处潜在的安全妥协进行了关键纠偏，最终确立了清晰的裁决矩阵：

| # | 议题 | 裁决状态 | 最终定案规范 |
|---|---|---|---|
| **1** | Scratch 构建产物 | ✅ **完全采纳** | 物理切分 **Candidate Source Namespace** 与 **Runtime Scratch Namespace**（独立挂载，不可将既有受控路径转为 scratch） |
| **2** | 仓内测试信任面 | ⚠️ **修改后采纳** | 确立 **Acceptance Evidence 三级证据模型**（Tier A 独立资产、Tier B 基线回归、Tier C 审查背书），拒绝将基线测试直接等同于功能充分性 Oracle |
| **3** | `node_modules` 等依赖 | ✅ **采纳并强化** | 引入 **Trusted Dependency Fixture 生命周期**（哈希绑定 lockfile + runtime + arch，受信任构建，禁止直接 RO 穿透宿主脏依赖） |
| **4** | `projection.redact` | ⚠️ **问题成立，方案纠偏** | **V1 坚决不支持可提升的 in-place redact**；采纳 Env Override 模式，混合文件若必须原地改动走 D / 人工门 |
| **5** | DENY 后诊断运行 | ✅ **完全采纳** | 严格解耦 **Diagnostic Dry-run**（含 Exact-Candidate 与 Promotable-View 两种沙箱诊断）与 **Promotion Acceptance**（门禁） |
| **6** | 命名空间类型冲突 | ✅ **采纳并扩大** | 在 Mechanical Gate 前置 **Namespace Structural Check**（B(i) 硬拒文件/目录前缀冲突与 hidden subtree 碰撞） |
| **7** | Unicode NFC / macOS | ⚠️ **纠偏后采纳** | 纠正 APFS/Git 编码处理认知；确立 **A6 双身份模型**（Raw Path 保持 Git 字节身份 + NFC 仅用于 Policy Match Key，碰撞时 fail-closed） |

---

## 1. 详细裁决与规范细化

### 1.1 Source 与 Runtime Scratch 命名空间的物理切分（采纳 1.1）

* **模型抽象**：
  ```text
  Candidate Source Namespace (/workspace)
      → 承载源码与受控资产
      → 参与 FS Capture、Snapshot 密封、Manifest 差异与 Promotion

  Runtime Scratch Namespace (/af-scratch/tmp, /af-scratch/cache, /workspace/dist)
      → 独立 Docker volume / tmpfs 挂载
      → 承载编译器输出、缓存、临时测试产物
      → 不属于 candidate source tree，不进 Snapshot，不计算 manifest，容器销毁即彻底丢弃
  ```
* **约束 Invariant**：
  > **禁止将 Canonical 中本来存在且被版本控制的路径转化为 scratch。**
  若仓库已提交 `dist/index.js`，`dist/` 必须作为 Source Namespace 受到严格版本监管。Scratch 划分必须由受信任物化策略声明，绝不能依据未受信任的 `.gitignore` 自动决定。

---

### 1.2 Acceptance Evidence 三级分层证据模型（修改后采纳 1.2）

不能因为缺乏仓外 hidden tests 就走向“基线测试 = 充分测试”的极端（基线测试无法证明新功能是否实现，只能证明没有回归错误）。验收证据正式划分为三级：

* **Tier A（External / Trusted Acceptance Assets）**：
  * 控制面持有的独立验收套件；
  * **效力**：最高等级 promotion evidence（适用于强安全或评测场景）。
* **Tier B（Baseline-anchored Repository Tests）**：
  * 来自 `refs/afr/canonical` 基线快照的既有仓内测试；
  * **效力**：Trusted Regression Evidence（证明修改未破坏既有契约与功能）。
* **Tier C（Candidate-authored / Candidate-modified Tests）**：
  * Candidate 本次新增或修改的仓内测试（如补全单测需求）；
  * **效力**：Diagnostic + Reviewer Evidence。必须由 **Content Reviewer 针对测试有效性专门签名**，作为“Review-backed Acceptance Evidence”，严禁单独作为独立验证 Oracle。

---

### 1.3 Trusted Dependency Fixture 生命周期（采纳并加强 1.3）

严禁直接将宿主目录 `-v ${cwd}/node_modules:...:ro` 挂进验收环境（宿主依赖可能存在污染、本地链接、ABI 漂移或恶意 lifecycle 脚本修改）。

* **标识公式**：
  ```text
  dependency_fixture_id = H(
      lockfile_bytes (package-lock.json / pnpm-lock.yaml / Cargo.lock)
      + runtime_version (Node/Python/Rust)
      + package_manager_version
      + platform_arch (linux-x64)
      + dependency_policy_digest
  )
  ```
* **运行机制**：
  * 验收环境装配：`Promotable Acceptance View (RO) + Trusted Dependency Fixture (RO) + Runtime Scratch (RW)`；
  * 若 Candidate 篡改了 lockfile，导致 `candidate.lock_digest != fixture.lock_digest`，旧 fixture 立即失效，必须交由受信任 harness 在受信沙箱中执行安全受限的依赖重新构建。

---

### 1.4 `projection.redact` 的定性与真实工程替代（纠偏 1.4）

* **裁决重申**：**V1 坚决不支持可提升的 in-place field redaction**。
  哪怕 Candidate 采用完整的 development mock 文件，其改动如果要在 promotion 时逆向合并（inverse merge）回真实 secret 配置文件，依然面临模式感知（schema-aware）合并的巨大破坏性风险。
* **工程落地方向**：
  1. **首选 Env Override Pattern**：规范推动项目将非敏感配置（`config.json`）与秘密（`process.env`）彻底解耦；
  2. **混合配置不可解时**：若必须修改包含真实秘密的混合配置文件，直接升格为 **D 带（人工审批门）**，交由操作者显式合并，杜绝控制面在不可验证的情况下盲目执行逆向合并。

---

### 1.5 诊断运行（Diagnostic Dry-run）与提升门禁解耦（采纳 1.5）

彻底消除“盲人修车”死锁，区分执行器调试反馈与安全提升门禁：

```text
               ┌─ unresolved DENY == 0 ──> 进入 Promotion Acceptance ──> 通过 ──> PROMOTION
               │
Capture / Scan ┤
               │                           ┌─ Exact-Candidate Diagnostic (含 DENY 项，看编译/全量报错)
               └─ 存在 unresolved DENY ──> ┤
                                           └─ Promotable-View Diagnostic (剔除 DENY 项，看剩余部分状态)
                                           （仅产生诊断日志喂回 executor，绝不触发提升）
```

---

### 1.6 Namespace Structural Check（采纳并加强 1.6）

在进入 Scope Verifier 之前，Mechanical Gate 必须执行确定性的文件系统结构碰撞检查，凡命中者一律 **B(i) 硬拒**：

1. **Prefix Collision**：任何新增/修改的文件，其路径前缀不得为现有普通文件；
2. **Directory-to-File Conflict**：任何新增普通文件，不得与 Baseline 中任何既有目录（含隐藏 subtree）同名；
3. **Hidden Subtree Collision**：若 Baseline 存在被排除的 `secret/token.txt`，Candidate 新建普通文件 `secret` 立即被机械硬拒，防止在 Git tree 提升时触发底层的 `ENOTDIR` 崩溃。

---

### 1.7 A6 路径双身份模型（Raw Identity + Policy Match Key）（纠偏 1.7）

澄清底层事实：Git 核心将路径视作以 `\0` 结尾的字节流，APFS 保持规范化不变。粗暴拒绝 NFD 或自动转码 NFC 都会引发灾难（前者误杀合法的 macOS 提交历史，后者会引发原字节碰撞）。

* **A6 双身份模型（Dual Identity Model）**：
  1. **Raw Path Identity**：
     * **用途**：Git tree、`snapshot_digest`、Manifest 身份、CAS promotion；
     * **约束**：保持原始字节（要求是合法的 UTF-8 序列，但不强制 NFC）。
  2. **Policy Match Key**：
     * **用途**：Glob 匹配、B(i) 清单比对、`protected_paths` 判定；
     * **计算**：`policy_key = Unicode_NFC(decode_utf8(raw_path))`。
  3. **Normalization Collision Check**：
     * 若准入或扫描中出现 `raw_path_A != raw_path_B` 但 `NFC(A) == NFC(B)`，触发 **`PATH_POLICY_AMBIGUITY` 错误，准入/扫描即拒**，杜绝 Unicode 等价形式的障眼法绕过。

---

## 2. 架构三层模型（Execution Environment Model）

不增加 9 个正式安全对象，将其自然归入三个功能派生层，消除理论与工程的割裂：

```text
1. Source Layer（版本源层 —— 决定“什么能进入 Canonical”）
   ├─ Canonical Revision (refs/afr/canonical)
   ├─ Candidate Projection (Candidate Source Namespace)
   ├─ Candidate Revision Snapshot
   ├─ Authorized Cumulative Patch
   └─ Target Canonical Tree

2. Runtime Layer（运行时层 —— 决定“程序如何真实跑起来”）
   ├─ Runtime Scratch Namespace (/af-scratch/tmp, tmpfs)
   ├─ Trusted Dependency Fixture (lockfile-hashed)
   ├─ Synthetic Runtime Dirs (0755 empty dirs)
   └─ Mock Services / Network Policy

3. Evidence Layer（证据层 —— 决定“凭什么认为该修订可以接受”）
   ├─ Tier A: External Trusted Acceptance Assets
   ├─ Tier B: Baseline-anchored Repository Tests
   ├─ Tier C: Candidate-authored Tests + Content Reviewer Signature
   ├─ Diagnostic Dry-runs (Exact / Promotable)
   └─ Promotion Acceptance Closure
```

---

## 3. 结论

第九轮裁决完成了安全理论与工程落地之间的最终缝合。至此，全案已无悬而未决的架构性或现实性分歧，设计正式收敛。
