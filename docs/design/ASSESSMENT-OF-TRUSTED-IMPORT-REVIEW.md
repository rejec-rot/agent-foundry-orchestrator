# 对《AFR 受信导入架构评审》的评估

> **评估对象**：`docs/design/AFR-TRUSTED-IMPORT-ARCHITECTURE-REVIEW.md`
> **被评估者**：`docs/WRITE-SCOPE-ENFORCEMENT.md`（我方的写入范围约束设计草案）
> **本文立场**：对那份评审逐点判断——哪些改对了、哪些比我强、哪些我要压回去或要求回答。

---

## 1. 总体判断

**这份评审质量很高，而且它指出的是我方草案的一个真错，不是措辞分歧。建议采纳其主模型。**
但它有**一处与本项目硬约束的真实冲突**、**一处关键遗漏**、**一处未给实现路径**，这三点必须先答，不能直接照抄实现。

一句话概括它做对的事：

> 把执法点从「**写的时候**」（只读挂载挡越界写）移到「**导入的时候**」
> （candidate → 受信 diff → manifest → 策略 → Trusted Importer → canonical）。

---

## 2. 它改对了的核心：执法点后移

我方草案的模型是：

```text
工作区只读 + 声明目录逐个 rw 挂载  →  越界写 EROFS
```

这有一个我方 **§15.1 自己点出但没解决**的死结：

- **写被挡住了，就没有"越界产物"可供 diff**；
- 于是 C 带（verifier）**永远没有东西可裁**；
- 而"可信 manifest 从哪来"这个问题**悬空**。

评审把这个死结翻转：**executor 不是 canonical workspace 的 writer，只是 candidate 的生产者；
唯一写 canonical 的是 Trusted Importer。** 由此：

| 原模型的困境 | 新模型下的状态 |
|---|---|
| 越界写要靠物理挂载挡住 | **不需要挡**——越界变更根本进不了 canonical |
| 安全目标：`agent 是否越界写过` | 安全目标：`未经批准的变化是否有任何路径进入 canonical` |
| 可信 manifest 来源悬空 | **本来就必须靠 baseline → candidate 的受信 diff** |
| UID 分离是前提（本机无 root ⇒ 做不了） | UID 分离**降级为 defense in depth** |

最后一行对本项目价值最大：**本机没有 root，方案 A 无法验证**；在新模型下，
只要 executor 碰不到 canonical，**不换 uid，主安全模型依然成立**。

**结论**：采纳其主模型；我方草案里「挂载只读 + 逐目录 rw」**退为第二层**
（防越界的体验/ERP 层，不再是安全边界）。

---

## 3. 它比我方草案强的地方（建议逐条采纳）

1. **manifest 作为唯一授权对象**：批准的是 `candidate manifest`，不是整个 candidate 文件系统。
   这比我方"逐次范围申请"清晰得多，也更**可证明、可测试、可 fuzz**。
2. **三类信息拆开**：`candidate_manifest` / `requested_scope_expansion` / `denied_write_events`。
   我方把它们混在 `outside_manifest` 一个概念里了。
   尤其是它那句 **「申请不需要可信，批准才需要可信」**——正确且重要。
3. **Scope Grant 绑 `scope_revision`**（而非单次 run、也非整个 task）：
   `task_id / plan_rev / baseline_digest / scope_rev / approved_write_set / policy_digest`，
   任一变更即 `invalidate`。这比我方倾向的"一次批准一个 revision"更准——
   按我方原写法，fix 循环会被逼出过多重裁。
4. **`required / anticipated / forbidden` 三列表**：**真正的可用性解药**。
   `anticipated` 不自动授权，但让 verifier 知道"planner 事前预测过"，裁决成本下降。
   它点破的 **「实际最容易崩的是 write set 可用性，不是 verifier 负载」** 比我方此前争论的焦点更贴近现实。
5. **Importer 只写新 inode、不继承 metadata、原子 rename**：
   把 symlink / hardlink / xattr / mode / 特殊 inode / 宿主触发面**全部收进一个 choke point**。
6. **新 invariant**：`No model-facing component may directly mutate the canonical workspace`
   （executor / planner / content reviewer / scope verifier 都不写文件；Trusted Importer 是唯一 writer）。
   这其实是把跑现有设计**形式化**，方向正确。
7. **命名**：废弃 `copy-back` / `回拷`，改名 `trusted-importer`。
   同意——`copy-back` 天然诱导实现者想到 `cp -a`，而正确的做法恰恰不是 `cp`。

---

## 4. 我要压回去 / 要求先回答的三点

### 4.1 纯 Node 无法实现它的 §13 / §17 —— 与本项目「零外部依赖」硬冲突

评审要求 importer 用：

```text
fd-relative traversal + openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)
```

但 **Node 的 `fs` 不暴露 `openat` / `openat2` / dirfd 相对操作**。
因此这套 security boundary **在纯 Node 里做不到**，而本项目 `dependencies` 是 `{}`。
这是**硬冲突**，不是措辞问题。

**我方的调和方案（请评审表态是否接受）——"先冻结、再 diff"**：

```text
1. run 结束，先确保 executor 进程已死（本项目已有进程组树杀 + 孤儿回收）
2. candidate 卷此时只由 importer 触碰 ⇒ 没有并发写者 ⇒ TOCTOU 窗口基本消失
3. 残余只剩"恶意树形"（非并发竞态）：全量 lstat + O_NOFOLLOW + 拒绝一切非普通文件
   + 所有导入都新建 inode + 原子 rename
4. openat2 / RESOLVE_* 记为"未来升级项"，不作为当前实现前置
```

即：**把 TOCTOU 从"需要内核原语"降级为"需要没有并发写者"**，而后者本项目已经有能力保证。

### 4.2 acceptance 在哪一侧跑？——评审完全没提

评审的数据流把 Content Reviewer 放在 import 之后，但**通篇没有出现 acceptance**。
这不是小事：**acceptance 是本项目两个"保留资产"之一（静态白名单 + 内容哈希锚定），是信任锚**。

- 若 acceptance 在 **candidate** 上跑：执行器可用被篡改的 runner / 测试喂**假结果** ⇒ 验收结果不可信。
- 若 acceptance 在 **import 之后**跑：才安全，且失败可回退。

**我方倾向**：`import → acceptance → 失败则 restore 回退`。
本项目**已经有 P7 的 restore point**（可逆执行）正好承接这条回退。
这条时序**必须钉死**，否则"双模型博弈 + 验收锚定"会出现缝。

### 4.3 manifest 怎么算？——评审只说了"trusted diff"，没给实现路径

全树 diff 在大仓上不便宜，且每个 revision 拷一份 candidate 会让磁盘翻倍。

**本项目已有的捷径（评审没提）**：

- `lib/rollback.mjs` 已有 git plumbing（`add -A` → `write-tree` → `commit-tree`）。
  baseline 与 candidate 各 `write-tree` 一次，`diff-tree` 即得**带 hash/mode 的 manifest**，
  且**免费获得 rename 检测**。
- `lib/worktree.mjs` 已有 **git worktree**。candidate 直接用 worktree ⇒ **零拷贝、天然可 diff**，
  把"每个 revision 拷一份"的成本消掉。

建议：**Phase 1 的 candidate + diff 用 git 实现**，而不是自写树遍历器。

> ⚠️ **本节已被 §7 修正**：`git worktree` **不能**直接交给 executor——
> linked worktree 经 `$GIT_COMMON_DIR` 与 canonical `.git` 共享 refs/config，
> 等于给 executor 一条通向 canonical Git state 的路径。正确做法见 §7：
> candidate 用**普通隔离目录**，Git 只在**受信扫描侧**以临时 `GIT_INDEX_FILE` 使用。

---

## 5. 采纳范围（我方结论）

| 项 | 决定 |
|---|---|
| `executor = candidate producer`、`Trusted Importer = 唯一 writer` | ✅ **采纳**（主模型） |
| `No model-facing component mutates canonical` 作为 invariant | ✅ **采纳** |
| 策略层 A / B(i) / B(ii 空) / C / D | ✅ **保留**（评审也认可） |
| 授权对象改为 `candidate manifest` + `scope grant` | ✅ **采纳** |
| `required / anticipated / forbidden` | ✅ **采纳** |
| 挂载只读 + 逐目录 rw | ⤵ **降为第二层**（体验层，非安全边界） |
| `openat2(RESOLVE_*)` 作为硬前提 | ❌ **不采纳为前置**；改为「冻结-再-diff」+ 记档升级项（待 4.1 表态） |
| acceptance 时序 | ⏳ **待定**；我方提案 `import → acceptance → 失败回退`（见 4.2） |
| manifest 实现 | ⏳ **建议用 git**（见 4.3） |

---

## 6. 下一步

1. 就上面 **4.1 / 4.2 / 4.3** 三点取得一致（回问评审方，或由你裁决）。
2. 按新模型**重写 `docs/WRITE-SCOPE-ENFORCEMENT.md`**：
   主模型换成 candidate→manifest→importer，"挂载只读"降为第二层，
   补 `Scope Grant` / `baseline` / `manifest` / `import transaction` 四个对象，并把三个待决点写入 §15。
3. 落 **Phase 1 原型**（可验证、不需要 verifier）：
   受信 diff 出 `candidate_manifest` + 机械门（A/B(i)），带测试。
   这符合本项目「先证明机制，再加模型」的一贯做法。

---

## 7. 三点待决的正式答复（已落实，v2 设计据此重写）

### 4.1 **接受。** 但 `Freeze` 升级为正式安全状态

- `openat2(RESOLVE_*)` 从 V1 **硬前提**降为未来 **defense in depth**（Node 公开 `node:fs` 无 dirfd 相对 API）。
- **收紧措辞**：v1 评估里"TOCTOU 窗口基本消失" → **「Freeze 成功后建立『candidate 无并发写者』这一安全前置条件；无法证明 freeze 则不得进入 diff/import。」**
- `Freeze` 是状态机 `RUNNING → QUIESCING → FROZEN`，不是"调用一次 `kill()` 就算完成"。
  进入 `FROZEN` 须证明：容器已停 + 子/孤儿进程确认已死 + 写租约撤销 + 无其他 RW 消费者。

### 4.2 **部分接受。** 顺序改为 `trusted staging → acceptance → promotion`

- **不采用** `canonical import → acceptance → rollback`：那会让 canonical 在一段时间里
  处于"尚未通过 acceptance"的状态。
- **采用** `Trusted Staging → Acceptance Sandbox → (PASS) → Promotion`，
  建立不变式 **`canonical 只包含已通过 acceptance 的 revision`**。
- **补 `Acceptance Trust Closure`**：现有锚定只保护**命令字符串**；
  `npm test → package.json → scripts/test.js → config` 若可被改，则 `command hash unchanged`
  **推不出** `acceptance semantics unchanged`（最直白：`"test": "exit 0"`）。须明确闭包中哪些 immutable/protected。
- **提升的是原始已批准 blob**，不是 acceptance 后的 staging（测试会产出 `coverage/` `dist/` 等，
  甚至恶意改源码）。P7 restore point 改为处理 promotion 崩溃等场景，而非日常 acceptance 失败回退。

### 4.3 **接受 Git diff，拒绝 executor-facing `git worktree`**

- **worktree 不是零拷贝工作树**（共享的是 object database，仍创建实际 working tree）；
- **更严重**：linked worktree 的 `.git` 经 `$GIT_COMMON_DIR` 指回主仓，refs/config 共享
  ⇒ executor 重新获得通向 canonical Git state 的路径，**违反 §0 的 invariant**。
- 改为：candidate = **普通隔离目录 / volume**；受信侧用
  `GIT_DIR=<canonical>/.git` + `GIT_INDEX_FILE=/trusted/tmp/index` + `--work-tree=<frozen candidate>`
  做 `read-tree` / `add -A` / `write-tree` / `diff-tree`。Git 只出现在受信扫描侧。
- **rename 不作为授权语义**：`rename A → B` 归一化为 `DELETE A + ADD B`；
  Git rename detection 仅用于展示/审计。
- worktree 最多可用于**受信 staging**，不能作为 executor 与 canonical 之间的隔离手段。

> 以上已全部写入重写后的 `docs/WRITE-SCOPE-ENFORCEMENT.md`（v2 主流水线 14 步 + 六个正式对象
> + Acceptance Trust Closure + 受信 Git 快照 + TI-1..TI-16 测试计划）。
