# 终审裁决：v5.2.1 架构与实现规范正式冻结（Implementation Spec Frozen）

> **性质**：受信导入（Trusted Import）技术论证的最终裁决与实现规范冻结声明。
> **结论**：**不再开启第 11 轮架构讨论。核心架构正式冻结（Architecture Frozen: v5.2.1），收尾工作完成，进入实现规范冻结（Implementation Spec Frozen）。**
> **主文档**：[`docs/WRITE-SCOPE-ENFORCEMENT.md`](../WRITE-SCOPE-ENFORCEMENT.md)（已同步更新）。
> **生效时间**：2026-09-18。

---

## 0. 核心定案说明

经过十轮深度推演与外部评审，Agent Foundry Runtime（AFR）的受信导入安全体系已达成完备证明：
1. **安全模型成立**：`candidate compromise ≠ trusted workspace compromise`。
2. **核心 Invariant 绝对成立**：
   > **No model-facing component may directly mutate canonical state, or obtain a writable alias to it.**
3. **架构收敛**：严格维持 **9 个正式安全对象** 与 **3 层执行环境模型（Source / Runtime / Evidence）**，无冗余概念膨胀。
4. **现实工程可行**：Runtime Scratch 物理隔离、Trusted Dependency Fixture、Diagnostic Dry-run 以及 Tier A/B/C 三级验收模型已全面嵌入主规范。

推演边际收益递减，纸面论证已无遗留 soundness 漏洞。**下一阶段所有真实问题必须由代码、故障注入与对抗性测试来检验。**

---

## 1. 最终收尾工作归档

在架构定案基础上，本次完成两项非架构性工程收尾与一项实现 Invariant 明确：

### 1.1 测试矩阵补齐（TI-26 ～ TI-31）
将 §14 机械回归测试矩阵扩展至 TI-31，全面覆盖 Round 09/10 的关键机制：

| 用例编号 | 机制名称 | 确定性断言 |
|---|---|---|
| **TI-26** | **Evidence Replay** | R1 验收产生 PASS $\rightarrow$ 生成 R2 $\rightarrow$ 控制面核验发现 `candidate_snapshot_digest` 不匹配，R1 证据自动标为 stale，严禁跨 revision 重放 |
| **TI-27** | **Tier B Closure** | Candidate 尝试篡改 `tests/helpers/**` 或 `jest.config.js` 等间接断言 $\rightarrow$ 控制面从基线快照全量只读注入 **Baseline Regression Closure** $\rightarrow$ 杜绝利用辅助文件伪造 PASS |
| **TI-28** | **Dependency Fixture** | `dependency_input_digest` / runtime image / arch / installer policy 任一发生变动 $\rightarrow$ `fixture_id` 哈希改变，旧 fixture 绝不复用，强制重新构建 |
| **TI-29** | **Target Namespace Cross Collision** | Baseline 存在未暴露隐藏 NFD 路径 + Candidate 新建 NFC 等价路径 $\rightarrow$ **Target Namespace Preflight** 在 Mechanical Gate B(i) 联合预检中确定性拦截（`PATH_POLICY_AMBIGUITY`） |
| **TI-30** | **Runtime Scratch** | 执行器在 `/af-scratch` 中生成 1000 个构建临时文件 $\rightarrow$ FS Capture 与 Snapshot 物理忽略，绝不进入 CAS 与 Manifest |
| **TI-31** | **Diagnostic vs Promotion** | 存在未决的 unresolved DENY 项 $\rightarrow$ 允许执行 Diagnostic Dry-run 输出编译与单测堆栈协助排错 $\rightarrow$ 但 Promotion Acceptance 与 CAS `update-ref` 必须绝对阻断 |

### 1.2 实现 Invariant 明确（机密边界收敛）
正式将機密边界下沉为文件系统与 API capability 的实现约束：

> **Model-facing components may receive revision-scoped materialized views, but must never receive direct arbitrary read/write access to the Trusted CAS or canonical Git object store.**

* **安全边界理由**：Candidate Projection 已经严格裁定了哪些 canonical 资产可以对模型暴露（如排除生产 `.env`）。如果 reviewer 或 verifier 拥有随意按 SHA-256 读取底层 CAS 或 Git Object Store 的权限，就会形成通过哈希探测机密资产的侧信道。模型组件只能访问控制面物化的受限视图。

### 1.3 实现阶段规划（§16 重构对齐）
纠正旧版“限额滞后于 Phase 2”的顺序倒挂，将限额前置到 Capture Truth 底座，建立分层的五阶段路线：

```text
Phase 1 — Capture Truth（事实捕获底座）
  ├─ afr adopt 锁定 OID + Admission Scan + zero-OID CAS 创建
  ├─ Candidate Projection 隔离挂载（Source 与 Scratch 物理切分）
  ├─ QUIESCE 判定（无非受信写者）
  ├─ Bounded FS Capture + DoS 限额前置拦截（inode 过滤 + A5/A6 路径契约）
  ├─ Seal Snapshot（raw bytes 入 Trusted CAS，生成不可变 snapshot_digest）
  └─ Manifest 机械差异计算（对齐 Projected Baseline）

Phase 2 — Mechanical Authorization（机械授权与预检）
  ├─ Scope Grant 机械模式匹配
  ├─ A 带机械放行与 B(i) 确定性硬拒
  ├─ Target Namespace Preflight 联合碰撞预检（前缀冲突 + Hidden 碰撞 + A6 NFC 歧义）
  ├─ Authorization Ledger 存证
  └─ 累积闭包初校验（无未决 DENY）

Phase 3 — Hard G Promotion（受信导入与提升）
  ├─ Target Canonical Tree 构造（Baseline Tree + Authorized Cumulative Patch）
  ├─ Git Tree / Commit 受信对象构造
  ├─ CAS 原子 update-ref（refs/afr/canonical）
  └─ Trusted Worktree Materializer（新 inode 物化，安全元数据净化）

Phase 4 — Runtime + Evidence（运行时支持与分层证据闭环）
  ├─ Scratch Namespace 独立 tmpfs/volume 挂载
  ├─ Trusted Dependency Fixture 通用构建与哈希锚定
  ├─ Diagnostic Dry-run 诊断运行调试
  ├─ Tier A / B / C 三级验收执行管道
  ├─ Baseline Regression Closure（RO 测试集与配置整体注入）
  ├─ Evidence Record 7元组强绑定
  └─ Pre-acceptance closure 与 Final Revalidation 门禁

Phase 5 — Intelligent / Operational Gates（智能门禁与深度防御）
  ├─ Scope Verifier 模型接入与 C 带单次裁决
  ├─ Human D Gate 人工审批流
  ├─ Stale Baseline 自动 Rebase
  ├─ af-exec UID 隔离运行与控制面权限剥离
  └─ 严格 Docker seccomp / apparmor 与网络防御
```

---

## 2. 端到端攻击者视角的证明链条

最终状态机在全链路攻击防御上已经无缝闭合：

```text
adopt
→ project
→ execute
→ quiesce (证明所有非受信写者已终止)
→ capture (受限扫描，前置 DoS 限额，raw bytes 入 CAS)
→ seal (计算 snapshot_digest，生成不可变事实边界)
→ diff (计算差异，排除文件不算 DELETE)
→ authorize (机械 A/B/D + 智能 C，未决 DENY 产生修复义务)
→ review (独立于 snapshot 评审质量)
→ pre-closure (验证 cumulative manifest 全量授权且无 DENY)
→ acceptance (Tier A/B/C 分级验证，Baseline 测试闭包防篡改)
→ final-revalidate (核验 7 元组证据绑定，防重放与失效)
→ build target tree (合成 Baseline + Patch，保留隐藏敏感文件)
→ CAS promote (原子 CAS update-ref)
→ materialize (安全物化，净化 mode/uid/xattr)
```

---

## 3. 下一步行动

1. **终止论证**：停止所有理论层面的概念扩张与文字推演。
2. **启动 Phase 1**：依照 §16，立即开始 **Phase 1（Capture Truth 事实捕获底座）** 原型编码与单元测试验证（TI-1 ～ TI-6, TI-15, TI-17, TI-24）。
