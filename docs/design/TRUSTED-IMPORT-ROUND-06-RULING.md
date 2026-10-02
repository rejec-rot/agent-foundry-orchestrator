# 第六轮讨论：A1–A4 裁决 + 新增 A5（文件系统契约）+ v5 冻结与端到端推演指引

> **性质**：讨论记录（每轮一份）。含 **(A) 你对 A1–A4 的正式裁决**、
> **(B) 核心原则纠偏与 A5 新增项（Canonical Filesystem Contract）**、
> **(C) v5 规范写回决议与端到端状态机证明推演（End-to-End Walkthrough）指引**。
>
> **上游**：`TRUSTED-IMPORT-ROUND-05-RULING.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v5）。

---

## 0. 本轮总览：从边角修补转向语义契约与全流程证明

第五轮收敛了 C1–C7 后，我方提出了关于拒绝后可恢复性、验收秘密、空目录与初始化启动的补充（A1–A4）。
你给出了极其清晰有力的裁决，修正了我方在安全论证和语义模型上的偏差，并明确指出了 Hard G 下必须具备的 **A5（文件系统契约）**。

| 项 | 裁决 | 核心修正与定性 |
|---|---|---|
| **A1** baseline 只读视图 | ✅ 采纳 | 归类为 **liveness/repairability**（非 soundness）；必须由同一 `baseline_oid + projection policy` 派生，严禁挂载 canonical worktree |
| **A2** acceptance 输出脱敏 | ⚠️ 需求成立，方案定性为 defense-in-depth | 提出关键原则：**给模型看的验收不得持有秘密**；区分 diagnostic 与 opaque acceptance，原始日志隔离于 trusted quarantine |
| **A3** 空目录 | ✅ 问题成立，拒绝 `.gitkeep` 默认 | 引入 **`synthetic_dirs` 运行时物化策略**，不污染 canonical，不破坏依赖空目录的程序语义 |
| **A4** canonical bootstrap | ✅ 完全采纳并强化 | `afr adopt --from <commit-ish>` 立即锁定 OID + **Canonical Admission Scan** + CAS zero-OID 创建 |
| **A5**（新增）文件系统契约 | ➕ 必须定为 prerequisite | **收窄 Hard G 支持范围**：仅常规文件、执行位与结构目录；symlink/ACL/xattr 等一律不作为 canonical truth |

---

## 1. 详细裁决与原则确认

### A1：采纳 Repair Baseline View（定位：可修复性与活性）

- **问题场景**：executor 删除了受保护文件（如 `DELETE src/base.js`）被 DENY。若要求 executor 自行修复，但由于 candidate 隔离且没有 `.git`，executor 无法获取原文件内容，会导致修复死锁。
- **裁决**：采纳。在 candidate 环境中提供只读 `/baseline/` 视图。
- **边界约束**：
  1. 定位为 **liveness / repairability**，而非底层 soundness。
  2. 该视图必须严格由受信控制面根据 `baseline_oid + projection policy` 重新导出派生，**绝不得直接 bind mount 宿主 canonical worktree**。
  3. 视图遵循 projection 过滤规则，不包含 excluded/secret 文件。

### A2：秘密输出的真安全边界（原则：给模型看的验收不持密）

- **我方原偏差**：试图在 acceptance harness 中用已知 secret 字符串做精准正则替换脱敏后喂回模型。
- **裁决与纠偏**：
  1. 敌对测试代码可以通过字符拆分（`s.e.c.r.e.t`）、编码（base64/hex）、时间侧信道等方式泄露信息，字符串精准替换**在数学上不可作为安全证明**，仅能列为 **defense-in-depth**。
  2. **核心原则**：
     > **需要给模型看的 acceptance，原则上不应持有模型不能知道的秘密。**
  3. **验收分流治理**：
     - **Diagnostic Acceptance（无敏感秘密）**：常规单元测试/规范检查，失败日志允许经白名单/标准化格式提取后反馈给模型上下文。
     - **Opaque Acceptance（含敏感秘密/集成测试）**：仅反馈布尔/退出状态（如 `integration acceptance failed`）；原始输出完全进入 **trusted quarantine**，绝不流入 planner/reviewer/executor 上下文。

### A3：空目录处理——采用 `synthetic_dirs` 物化策略，不用 `.gitkeep`

- **我方原偏差**：提议用 `.gitkeep` 占位解决 Git tree 无法表达空目录的问题。
- **裁决与纠偏**：
  1. `.gitkeep` 是真实文件。某些程序断言“目录必须为空”，放入 `.gitkeep` 会反向破坏程序逻辑。
  2. **正确模型**：`Canonical Git State + Materialization Policy = Runtime Filesystem`。
  3. 由受信物化策略声明运行时合成目录（`synthetic_dirs: [tmp/, dist/, var/cache/]`），materializer 负责 `mkdir -p`，这些目录**不属于 candidate manifest，也不进 canonical tree**。

### A4：Canonical Bootstrap 与 Admission Scan

- **裁决**：
  1. `afr adopt --from <commit-ish>` 必须立即受信解析为精确、不可变的 Commit OID（如 `9f8a...`），不得动态跟踪分支名。
  2. **Canonical Admission Scan（准入扫描）**：在首个 canonical ref 建立前，必须扫描该 commit 对应的 tree，检查是否存在非法路径、不受支持的 symlink/submodule 或违反策略的文件。检查未通过则拒绝 adopt。
  3. **CAS 原子初始化**：使用 `git update-ref refs/afr/canonical <new_oid> <zero_oid>`。通过 zero-OID 强制保证 ref 预先不存在，若存在则报 `ADOPTION_ALREADY_EXISTS`，fail-closed，杜绝意外覆盖已有 canonical。

### A5：Hard G 的 Canonical Filesystem Contract（底层语义契约）

- **性质**：Hard G 的 **Soundness / Semantic Prerequisite**。
- **收窄规范**：Git 官方数据模型天然只支持 regular file（`0644`/`0755`）、symlink、directory、gitlink，不承载 UID/GID/ACL/xattr/capabilities/timestamps 等 POSIX 属性。AFR V1 正式收窄其承诺的文件系统能力：
  - **支持并规范化的状态**：
    - `NORMAL_FILE`：普通字节流，mode 归一化为 `0644`。
    - `EXECUTABLE_FILE`：可执行普通文件，mode 归一化为 `0755`。
    - `DIRECTORY`：结构化目录，仅表达路径层级，物化 mode 固定为 `0755`。
  - **显式不受支持的语义（准入/扫描即拦截，或物化不继承）**：
    - symlink、hardlink 标识、fifo、socket、device 节点。
    - uid、gid、ACL、extended attributes (xattrs)、capabilities、文件时间戳、任意 POSIX mode。
- **产物收益**：`snapshot_digest` 的 `normalized_mode` 获得严格数学定义，彻底消除 snapshot、promotion 与 materialization 三者对文件系统属性理解的不一致。

---

## 2. 规范写回决议（→ v5）

1. **九个正式对象边界冻结**：九个对象保持不变，A1（Repair Baseline View）作为 materialization 策略的受限派生，A2/A3/A5 作为 Policy Bundle 与 Snapshot 的规范字段与约束。
2. **§15 未决事项清空**：
   - C1–C7、A1–A5 全部从“未决清单”移出，写入对应架构章节。
   - 唯一保留的项为低层工程实现选项（如 JSON Pointer 规范化实现、Docker overlay/copy 方式）。

---

## 3. 下一步：端到端状态机证明推演（End-to-End Walkthrough）

按裁决指示，停止继续在局部扩展细枝末节，转入生命周期全路径的端到端证明推演：

```text
adopt (A4, A5)
  ↓
materialize (C7, A1, A3)
  ↓
executor (C2, A1)
  ↓
snapshot (C4, A5)
  ↓
deny / fix (C1, C3, A1)
  ↓
acceptance (C6, A2)
  ↓
update-ref (Hard G, A4)
  ↓
rematerialize
```

**对抗性审查原则**：在上述状态机的每一个状态节点与转移间隙中，严格推演：“**在此刻，哪一个不受信主体（executor / planner / adversarial test code / hostile tool）能物理或逻辑写到什么？**”，以形式化/结构化闭合整个安全证明。
