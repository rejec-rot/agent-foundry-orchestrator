# 第四轮讨论：正式裁决 + 我方复审（待裁六点）

> **性质**：讨论记录（每轮一份）。含 **(A) 你对第三轮的正式裁决**、
> **(B) 我方对第 5 条修正的确认**、**(C) 由第 4/9 条衍生出、我复审时新发现的六处待裁问题**。
>
> **上游**：`TRUSTED-IMPORT-ROUND-03-OPINIONS.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v3）。

---

## A. 正式裁决（采纳）

| # | 条目 | 裁决 |
|---|---|---|
| 1 | policy 界定 planner `required` 上界 | ✅ 采纳；且 **`required` 本身不是授权**，planner 只有申请能力 |
| 2 | Snapshot = 内容寻址 | ✅ 采纳，升为正式对象；**CAS/blob store 属于 trusted domain** |
| 3 | invariant 改述 | ✅ 采纳；精确为「**No model-facing component may directly mutate canonical state or obtain a writable alias to it**」 |
| 4 | baseline 密钥排除 | ✅ V1 必做；但**必须引入 Candidate Projection**（否则 excluded 路径会被误判为 DELETE） |
| 5 | 增量判权 / 累积提升 | ⚠️ **修改后采纳**：增量 delta 主裁决 + **Authorization Ledger** + promotion 前 **cumulative closure check** |
| 6 | 文件系统是安全真源 | ✅ 采纳；措辞精确为「**捕获 untrusted candidate revision 时**，文件系统观察是事实来源」 |
| 7 | 非 Git 工作区硬拒绝 | ✅ 采纳；且应在**任务准入**时拒绝（`TASK_ADMISSION_FAIL`），不是在 promotion 才发现 |
| 8 | Hard G | ✅ **正式定为架构决定**：`canonical truth = refs/afr/canonical`，worktree 是 materialization |
| 9 | **新增：Candidate Projection** | ✅ 不是优化，是 **soundness requirement** |

**裁决理由（第 5 条的绕过窗口）**：`evil.txt` 在 R1 被 DENY，但文件仍在 live candidate；
R2 只改了 `src/a.js`，于是 `delta R1→R2` 看不到 `evil.txt`，仅看 delta 会判 R2 合法——
而 `baseline→R2` 的**累积 manifest 仍含 `ADD evil.txt`**。故**仅增量 delta 不 sound**。

**修正后的拆法**：

```text
增量 delta           → 发现"这一轮新增了什么授权问题"（并减少 verifier 调用）
Authorization Ledger → 逐路径记录 scope 与批准所在修订
cumulative closure   → promotion 前：∀ entry ∈ cumulative_manifest 必须有有效授权，否则 block
```

---

## B. 我方对第 5 条修正的确认

**同意，且这是我方第三轮提案的真实漏洞。** 我原来的「增量判权 / 累积提升」只保证了 *性能*，
没有保证 *authorization soundness*——被拒的路径会因"后续 delta 没提到它"而被**洗白**。
Ledger + cumulative closure 是正确且必要的补丁。（⚠️ 但见 C1、C3：ledger 自身还需两处加固。）

---

## C. 我方复审新发现的六处（**待裁**，未写回 v3）

### C1. Ledger 的「黏性」：Grant 收窄后，旧 `allowed` 必须重估

Ledger 以 **path** 记录，而授权以 **grant（glob）** 表达。若 `write_set` 收窄（`scope_rev++`），
先前被标 `allowed` 的路径可能**不再被新 Grant 覆盖**。

> 若 ledger 只记 `{scope: allowed}`、不记"**在哪个 grant 修订下批准**"，
> 就会变成**一次批准、永久授权**——grant 收窄失效。

**建议**：ledger 条目绑定 `grant_revision`；grant 变化时**重估所有条目**（未被新 grant 覆盖的旧 allowed 降级）。

### C2. `exclude` 必须**双向**：只挡"入"不挡"出"，executor 可自建被排除路径

Projection 的 `exclude: [.env]` 挡的是 **canonical → candidate**。
但它**挡不住 executor 在 candidate 里新建一个 `.env`**。
若 import 侧不把 exclude 路径也判为 **B(i)/D**，executor 就能 `ADD .env` 并把它**提升进 canonical**。

> `exclude` / `protected` 必须**同时**作用于 projection（入）与 import gate（出）。
> 否则"排除"只是让它看不见，不是让它写不进。

### C3. denied 文件的 **livelock**：必须"拒绝即隔离"

`evil.txt` 被 DENY 后若**留在 live candidate**，累计闭包检查会让**此后每一版 promotion 都被 block**，
而 executor 既无指令也无动力去删它 → **任务永久卡死**。

**建议**：deny 时**立即从 live candidate 移除该路径**（或标记为 promotion-ignored），
并把 deny 结论作为 **required change 反馈进 fix 提示**。

### C4. Revision identity **不应内嵌 `scope_revision`**

`scope_revision` 是**授权事实**，revision 是**内容事实**。
把它塞进 revision ID，会让同一批字节在不同授权下得到不同 ID，**破坏内容寻址 / 去重 / 缓存**，
且与你自己列的"Grant / Ledger 是独立对象"相矛盾。

**建议**：`revision_id = hash(baseline_oid + projection_policy_digest + candidate_manifest_digest)`（**纯内容**）；
授权（Grant / Ledger / Approval / Acceptance 记录）**各自引用**该 id。

### C5. policy 必须**收敛为单一 digest**（projection / scope / acceptance closure / B(i) 都有它）

现在至少有四处"policy"：projection policy、scope policy、Acceptance Trust Closure、B(i) 清单一。
若各自独立定版，会出现"**到底哪个 policy 版本生效**"的歧义，审计上最难查。

**建议**：一个**受信 policy 对象**（内部可有子节），**对外只有一个 `policy_digest`**；
revision / grant / acceptance 记录全部引用同一个 digest。C4 里的 `projection_policy_digest` 并入它。

### C6. Acceptance 秘密的**真实暴露面**：验收执行的是不可信测试代码

"秘密不进 model context"是对的方向，但**不等于秘密安全**：
验收沙箱**跑的是 candidate 里的测试代码**，因此注入给验收的秘密**对不可信代码可见**，
可被外带或滥用。

**建议**：
1. 明确 `Secret Boundary` 的假设是「**测试代码是敌对的**」；
2. 验收沙箱 **`--network none`**（AFR 现有能力，必须保持）；
3. 秘密**短时效、最小权限、按测试需要注入**，且**不进** snapshot / CAS / manifest / log / model context。

---

## D. 结果与下一步

- **已裁决 9 项 → 写回 v3（见下一条 commit/改动）。**
- **C1–C6 标为"待裁"**，已进入 v3 §15 的未决清单；其中 **C2、C3** 我认为是与第 9 条同级的
  **soundness requirement**（排除路径可被自建、被拒文件导致 livelock），**建议不要拖到最后**。
- 九个正式对象采纳如下（不再增加模糊概念）：

```text
1. Canonical Revision
2. Materialization / Projection Policy
3. Live Candidate
4. Candidate Revision Snapshot
5. Candidate Manifest
6. Scope Grant
7. Authorization Ledger
8. Acceptance Revision
9. Accepted Promotion
```

> 注：由于 C5，对象 2 的 "Projection Policy" 最终可能并入"单一受信 policy"，
> 仍保留为**概念上的一节**，但对外共享同一个 `policy_digest`。
