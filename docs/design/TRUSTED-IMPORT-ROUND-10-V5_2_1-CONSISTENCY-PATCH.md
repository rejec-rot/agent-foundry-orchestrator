# 第十轮补丁：v5.2.1 一致性与证据闭环（Consistency & Evidence Patch）

> **性质**：对第九轮裁决与 v5.2 正文文本之间残留矛盾的精细化修复意见。
> **定位**：**核心架构已经收敛，本次专注于规范文本的一致性与跨层 Soundness 闭合。** 不增加第十个正式安全对象，不增加第四个执行环境层。
> **上游**：`TRUSTED-IMPORT-ROUND-09-EXECUTION-ENVIRONMENT-RULING.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v5.2）。

---

## 0. 本轮总览：从架构收敛走向文本与证据的绝对一致

在第九轮完成三层执行环境模型（Source / Runtime / Evidence Layer）构筑后，复审发现文本层面仍存在 **2 处直接矛盾**与 **4 处跨层 Soundness 漏洞**。这些问题若不彻底修剪，会导致工程实现人员面临冲突指令，并在验收证据绑定与跨命名空间合并处留下绕过窗口。

本轮通过 **v5.2.1 一致性补丁** 将这 6 处问题全数修正：

| # | 类别 | 缺陷位置 | 根因与风险 | v5.2.1 修复规范 |
|---|---|---|---|---|
| **1** | **P0 矛盾** | §6 图表时序残留 | §4 已改，但 §6 仍画着 `QUIESCE → SNAPSHOT → FS scan` 旧图 | 统一 §6 拓扑图为 `QUIESCE → BOUNDED CAPTURE → SEAL SNAPSHOT`，标题同步更名 |
| **2** | **P0 矛盾** | §4 QUIESCE 虚构“只读锁定” | 流水线写“锁定 candidate FS 进入只读”，而内核/Node 并未实现 remount-ro | 删除“只读锁定”虚构表述；QUIESCE 严格定义为停止容器+杀死孤儿，真正不可变边界是 Trusted CAS + Snapshot |
| **3** | **Soundness** | 验收证据未绑定修订 | 验收结果若仅记 `{"status":"pass"}`，在出新 revision 后会发生旧证据重放 | 所有 Evidence Record 强制绑定 `snapshot_digest`、`baseline_oid`、`fixture_id` 等；Tier C 额外绑定 reviewer 审查哈希 |
| **4** | **Soundness** | Tier B 测试辅助文件被篡改 | Candidate 虽未改 `.test.js`，但改了 `tests/helpers/**` 或 `jest.config.js` 破坏断言 | 引入 **Baseline Regression Closure**：全量测试目录与配置从基线快照整体只读注入，彻底防止 helper 劫持 |
| **5** | **Engineering** | Dependency Fixture 绑定过窄 | 公式将 npm 字段写死，无法适配 monorepo、Cargo、Python，且未明确“Trusted”定义 | 抽象为通用公式：`H(dependency_input_digest + runtime_image + arch + policy)`；明确 fixture 内第三方代码仍可能敌对 |
| **6** | **Soundness** | 跨命名空间碰撞检查遗漏 | A6 与 E5 仅查局部；hidden baseline（如 NFD 路径）与 candidate（NFC 路径）合并后才发生冲突 | 统一建立 **Target Namespace Preflight**，在 Mechanical Gate 针对 `Baseline + Candidate Patch` 的全局最终命名空间做联合碰撞预检 |

---

## 1. 详细修复规范

### 1.1 拓扑图与章节标题完全统一（P0，修复 §6）

* **修正内容**：
  将 §6 彻底重构并更名为：
  ```text
  ## 6. QUIESCE → BOUNDED CAPTURE → SEAL SNAPSHOT
  ```
* **拓扑图统一**：
  ```text
  LIVE CANDIDATE (可写，生命周期结束丢弃)
        ↓
  QUIESCED（双重可验证判据：容器已停 + 子/孤儿进程已死）
        ↓
  BOUNDED FS CAPTURE
        ├─ 全树 lstat 检查 inode 类型（B(i) 硬拒非法 inode，A5）
        ├─ 校验 A6 路径契约
        ├─ 硬限额前置拦截（深度、条目数、单文件大小，防 DoS）
        ├─ 计算 raw bytes SHA-256
        └─ 将原始字节复制入 Trusted CAS
        ↓
  SEAL SNAPSHOT
        └─ 计算 snapshot_digest = H(schema_version + sorted(...))
        ↓
  REVISION N（对一切 model-facing 组件不可变）
  ```

---

### 1.2 纠正 QUIESCE 的“只读锁定”虚构表述（P0，修复 §4 / §6）

* **安全真相**：
  在同 UID / 普通 Linux Docker 环境下，控制面没有也不应凭空假设实现了 `remount-ro` 或文件系统底层快照。
* **边界纠正**：
  * QUIESCE 的**唯一责任**是证明并确保：**所有非受信写者（untrusted writers）均已被终止**。
  * Candidate 仍然只是宿主上的一个普通物理目录，随时可销毁。
  * **系统的真正不可变边界（Immutability Boundary）是：Sealed Snapshot + Trusted CAS。**

---

### 1.3 验收证据强绑定具体修订（Soundness，修复 §9.1）

* **防重放 Invariant**：
  任何测试 PASS 或评审签名，必须能精确自证是**对哪一次修订在什么环境下产生的证据**。
* **Evidence Record 绑定约束**：
  每一个落入控制面的验收证据记录（Evidence Record）必须至少绑定以下 7 元组：
  ```text
  Evidence Binding = {
      candidate_snapshot_digest,
      baseline_oid,
      acceptance_profile_digest,
      acceptance_assets_digest,
      dependency_fixture_id,
      command_binding,
      policy_section_digests
  }
  ```
* **Tier C 额外绑定**：
  若为 Candidate 修改测试并走审查背书模式，必须额外记录：
  ```text
  Tier C Binding = Evidence Binding + {
      review_decision_id,
      reviewed_test_blob_digests,
      reviewed_snapshot_digest
  }
  ```
* **失效链**：
  * Revision 变更 $\rightarrow$ 历史 Evidence 隐式失效（stale）；
  * 测试文件重新变动 $\rightarrow$ Reviewer 审查背书立即作废；
  * Final Revalidation 阶段核验上述哈希，任一不符直接拒绝提升。

---

### 1.4 Tier B Baseline Regression Closure（Soundness，修复 §9.5）

* **漏洞场景**：
  执行器并未修改测试入口 `tests/auth.test.js`，但修改了它引用的辅助函数 `tests/helpers/auth-fixture.js`（例如将其断言改为 `export const check = () => true`），导致 baseline 顶层测试被虚假跑通。
* **规范修正**：
  * Tier B 运行的不是孤立的几个测试文件，而是 **Baseline Regression Closure（基线测试闭包）**；
  * 由控制面从 `refs/afr/canonical` 基线快照中完整提取测试集合（如 `tests/**`、`test/fixtures/**`、测试 runner 配置文件 `jest.config.js` 等）；
  * 在验收 Staging 中以**只读视图（RO）**覆盖 Candidate 的测试目录；
  * 执行命令：`Candidate 业务源码 + Baseline Regression Closure (RO)`，彻底消除测试辅助文件或配置被篡改的风险。

---

### 1.5 通用 Dependency Fixture 标识（Engineering，修复 §9.4）

* **公式泛化**：
  将特定于 npm 的公式解耦为生态适配器架构：
  ```text
  dependency_fixture_id = H(
      dependency_input_digest
    + runtime_image_digest
    + platform_arch
    + installer_policy_digest
  )
  ```
  * **Node 生态**：`dependency_input_digest = H(package-lock.json + package.json + workspace manifests + safe npmrc)`；
  * **Rust 生态**：`dependency_input_digest = H(Cargo.lock + Cargo.toml + workspace manifests)`；
  * **Python 生态**：`dependency_input_digest = H(poetry.lock / requirements.txt / pyproject.toml)`。
* **安全定性（消歧义）**：
  “Trusted Dependency Fixture”中的 **Trusted 仅指由受信任 harness 构建并哈希锚定**，其内部第三方包依然遵循 hostile-code 假设，构建过程绝不传入生产密钥与高权限凭据。

---

### 1.6 Target Namespace Preflight（Soundness，修复 §5.3 / §10.1）

* **漏洞场景**：
  * Baseline 存在未暴露给 Candidate 的隐藏文件：`docs/café.txt`（NFD 编码）；
  * Candidate 新增了合法文件：`docs/café.txt`（NFC 编码）；
  * 局部检查时双方内部均无碰撞，但在最终 `Baseline + Patch` 合并为 Target Canonical Tree 时，引发了灾难性的同形异码命名空间冲突。
* **联合预检机制**：
  在进入 Scope Verifier 之前，Mechanical Gate 必须对合成的全局命名空间执行前置验证：
  $$\text{Target Namespace Preflight} = \text{Baseline Canonical Namespace} + \text{Candidate Structural Patch}$$
  统一一次性机械拦截：
  1. **File/Directory 前缀与类型冲突**（E5）；
  2. **Raw Path 冲突**；
  3. **A6 跨集合 NFC Policy Key 碰撞**（触发 `PATH_POLICY_AMBIGUITY` 硬拒）；
  4. **Hidden Subtree 结构性碰撞**。

---

## 2. 结论

本轮通过 6 个精准补丁彻底消除了 v5.2 文本中的 2 处逻辑残留与 4 处跨层 Soundness 空洞。
三层执行环境模型（Source / Runtime / Evidence）在文本和工程规范上全部对齐。

至此，**规范文本与核心架构均已完全收敛，设计正式冻结为 v5.2.1**。
