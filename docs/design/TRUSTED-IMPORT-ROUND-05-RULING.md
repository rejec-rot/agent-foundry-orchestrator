# 第五轮讨论：C1–C6 裁决 + 新增 C7 + 我方再复审

> **性质**：讨论记录（每轮一份）。含 **(A) 你对 C1–C7 的裁决**、**(B) 我方确认（含承认自身三处错误）**、
> **(C) 我方由 C3/C6/C7 衍生的四处补充（待裁）**。
>
> **上游**：`TRUSTED-IMPORT-ROUND-04-RULING.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v4）。

---

## 0. 本轮评价：它修正了我方的三处错误

| 我方的错 | 它的修正 | 性质 |
|---|---|---|
| C3 提案「DENY 后控制面/`promotion-ignore`」 | **不自动删**；DENY = blocking remediation obligation | 我方提案**破坏所有权关系**，且 `promotion-ignore` 会让 acceptance 与 promotion 不一致 |
| C4 公式 `hash(baseline_oid + policy_digest + manifest)` | **仍不是纯内容 ID**；拆成 `snapshot_digest`（纯内容）+ **Revision Context** | 我方**自相矛盾**（既说"纯内容"又塞进 baseline/policy） |
| C5「单一不可分 digest」 | **Policy Bundle + section digests** | 我方**过度耦合**：改 acceptance timeout 不该让所有 Scope Grant 失效 |

---

## 1. 裁决摘录（C1–C7）

| 项 | 裁决 | 核心 |
|---|---|---|
| **C1** Ledger 黏性 | ✅ 采纳并加强 | **Ledger = provenance，不是授权源**。当前授权 = `Current Policy + Current Grant + Current Manifest Entry`；历史 `allowed` 自动成 stale evidence，无需重写 |
| **C2** exclude 双向 | ✅ 原则采纳 | **projection 与 import 分成两个轴**（`projection.exclude` / `import.deny`），不混成一个 `exclude` |
| **C3** denied livelock | ⚠️ 问题成立、**方案不采纳** | **不自动删 / 不 promotion-ignore**；DENY 产生 **blocking obligation** |
| **C4** revision identity | ⚠️ 原则对、公式错 | 拆成 **`snapshot_digest`（纯内容）** + **Revision Context** |
| **C5** 单一 policy digest | ⚠️ 部分采纳 | **Policy Bundle（bundle_digest）+ section digests** |
| **C6** acceptance secret | ✅ 采纳并**升级为 V1 security requirement** | `--network none` 不够；**stdout/stderr/log/artifact 也是外带通道** |
| **C7**（新增）baseline 来源 | ➕ 必须定 | **只能从 `refs/afr/canonical^{tree}` 物化，绝不能从 worktree 拷** |

**关键规则摘录**

- C1：> Authorization Ledger records **why** an entry was authorized; it does **not** independently confer authorization.
- C3：> DENIED entry **不得进入 acceptance staging**；staging 只从 **approved cumulative manifest** 重建。
  否则：`src/main.js` import `evil.txt`，acceptance 看到它 → PASS，promotion 却忽略它 → **canonical 跑不起来**。
- C4：
  ```text
  snapshot_digest = H(schema_version + sorted(path, type, normalized_mode, blob_digest))
  Revision Context = { snapshot_digest, baseline_oid, policy_digest, scope_revision, task_id }
  ```
- C6：优先级 **真实生产 Secret = NEVER** > 短时效最小权限测试凭据（仅当不可避免）> mock/disposable service（首选）；
  Acceptance Policy 至少控制 `network / stdout-stderr / artifact export / mounts / environment / capabilities`。
- C7：> No candidate may be materialized from the canonical worktree; candidate materialization starts from the accepted canonical Git tree only.
  附带收益：宿主工作目录里的 `.env`、IDE 文件、临时密钥**只要不属于 canonical tree，从一开始就进不了 candidate**。

---

## 2. 我方确认

- **C1**：它的定义比我的"重估所有条目"更好——staleness 是**隐式**的，不需要 O(n) 重写。采纳。
- **C2**：拆两轴比我"双向 exclude"准确。采纳（并接受安全默认：projection excluded/masked ⇒ import 方向至少 protected，除非 trusted policy 显式覆盖）。
- **C3**：**我承认原提案错**。其"acceptance 与 promotion 必须看到同一集合"的理由尤其致命，我漏了。采纳其 blocking obligation 模型。
- **C4**：**我承认公式错**。采纳 `snapshot_digest` + context 的拆法。
- **C5**：**我承认过度耦合**。采纳 Bundle + section digests。
- **C6**：采纳并升级。`console.log(process.env.SECRET)` 在 `--network none` 下照样外带 —— 这条我漏了。
- **C7**：**采纳，且同意它是 soundness requirement**：漏掉它，Hard G 在 Candidate Materialization 第一步就被绕回。

---

## 3. 我方补充（由 C3 / C6 / C7 衍生，**待裁**）

### A1. C3 的"remendiation 可能无法完成" —— 需要一个**只读 baseline 视图**

C3 要求 executor 自己去 remediate 被拒项。但考虑**被拒的是一次 DELETE**：

```text
executor 删了 src/base.js → DENY（protected）
要 remediate，executor 必须把它恢复
但 executor 手上没有原始字节（它没有 .git）
```

→ 可能出现"另一种 livelock"：**deny 了一个 executor 无法撤消的操作**。

**建议**：给 candidate 提供一个**只读的 baseline 视图**（如 `/baseline/`，仅非 secret 路径），
让 executor 能自我修复删除/改动。这**不违反** C3 的所有权规则（控制面不写 live candidate），
但必须先定"哪些 baseline 路径可读"（与 C6 的秘密边界相交）。

### A2. C6 需要**输出脱敏器**，否则修复循环学不到失败原因

C6 说 acceptance 输出不可信、可能含 secret、不得未处理地喂给模型。
但 fix loop 又必须知道**为什么验收失败**。

**建议**：acceptance harness 必须**知道自己注入了哪些临时 secret 值**，并在把输出交给任何模型上下文前
**按这些值做脱敏**（并保留可读的失败信息）。否则要么泄密、要么修复循环瞎。

### A3. Hard G + C7 ⇒ **空目录在 canonical 中不可表示**

Git tree 不存空目录。canonical truth = git tree ⇒ **canonical 里不能有空目录**。
而 build / test 环境常依赖空目录（如 `dist/`、`tmp/`）。

**建议**：显式记录为 Hard G 的**已知后果**；如需空目录，用占位文件（`.gitkeep`）或由 projection 合成。
不要让它成为后续"神秘失败"。

### A4. **初始 canonical revision 如何建立**（第一个任务之前）

C7 要求 candidate 从 `refs/afr/canonical^{tree}` 物化。但一个仓库**第一次**被 AFR 接管时，
该 ref 还不存在。

**建议**：定一条**显式、受信的 bootstrap**，例如：

```text
afr adopt --from <commit-ish>      # 显式宣告初始 canonical revision
```

**绝不能**用"把当前（可能 dirty 的）worktree 当作初始 canonical"——那等于在 bootstrap 处又把 C7 绕回。

---

## 4. 结论与写回清单（→ v5）

- **九个正式对象不再扩**（你已明确）。`snapshot_digest` / section digests / Revision Context
  都只作为这九个对象的**字段/关系**，不新增对象。
- **C1–C7 写回 v5**；**A1–A4 记为新的待裁**（我建议 A1、A3、A4 与 C2/C3 同级，因为它们同样影响 soundness/可用性）。
- 其中 **C4、C7** 你定为 soundness 修正；我方补充里 **A1** 也接近 soundness（否则 C3 会以另一种形式 livelock）。
