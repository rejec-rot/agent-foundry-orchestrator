# 受信导入（Trusted Import）——写入范围与候选产物的架构设计与实现规范

> **状态：实现规范正式冻结版（Implementation Spec Frozen / v5.2.1 最终闭环）。** 只定义设计与实现规范，不含实现代码。
> 架构于第十轮正式定案（Architecture Frozen: v5.2.1），并经最终测试矩阵与阶段表补齐，全面实现工程闭环：
> - **正文与拓扑时序完全对齐**：彻底同步 §4 与 §6 拓扑为 `QUIESCE → BOUNDED CAPTURE → SEAL SNAPSHOT`，删除虚构的“只读锁定”表述（真正不可变边界为 Sealed Snapshot + Trusted CAS）。
> - **证据强绑定具体修订**：所有 Evidence Record 强制绑定 `candidate_snapshot_digest`、`baseline_oid`、`dependency_fixture_id` 等 7 元组；Tier C 额外绑定审查决策，杜绝跨修订重放与背书失效（Soundness）。
> - **Tier B 测试闭包隔离**：引入 **Baseline Regression Closure**（基线测试集整体只读覆盖），杜绝 Candidate 篡改测试 helper/config 引发的虚假 PASS（Soundness）。
> - **通用 Dependency Fixture 标识**：公式泛化为 `H(dependency_input_digest + runtime_image + arch + policy)` 适配多语言生态，明确第三方包仍属潜在敌对代码。
> - **Target Namespace Preflight 联合预检**：Mechanical Gate 前置对 `Baseline + Candidate Patch` 全局命名空间执行统一碰撞检查（包含前缀冲突、Hidden 碰撞与 A6 跨集合 NFC 歧义）。
> - **实现 Invariant 明确**：模型组件仅获修订级物化视图，严禁对 Trusted CAS 或底层 Git Object Store 拥有任意读写权限。
> - **测试计划与落地规划补齐**：扩展 TI-26～TI-31 全面覆盖证据重放、闭包隔离、依赖固化与跨集合碰撞；五阶段落地规划重排对齐真实运行时/证据层。
>
> **相关文档**：`docs/design/`（简报 / 外部评审 / 裁决记录 01–10 / 最终冻结裁决）、
> `docs/PRIVILEGE-SEPARATION.md`（同 uid 根因）。

---

## 0. 核心 Invariant 与实现约束

### 0.1 核心架构 Invariant

```text
No model-facing component may directly mutate canonical state,
      or obtain a writable alias to it.
```

展开：**executor / planner / content reviewer / scope verifier —— 都没有任何写路径能修改
canonical state。** 四者都不写；scope verifier 只输出 `decision`。
**唯一写 canonical 的是 Trusted Importer。**

> **Canonical State 的定义**（v4 明确，否则 invariant 会被误读）：
> `refs/afr/canonical` + trusted CAS / object store + control-plane state + trusted policy
> + canonical materialization。
> 措辞保留 “**write path**” 并加 “or obtain a writable alias”：
> executor 当然要**读** candidate 中来自 canonical 的内容，所以不能写成 “canonical absent”。

要证明的东西从「如何限制 executor 在 workspace 里写什么」变成：

```text
如何允许不受信 executor 产生任意 candidate，
但只有被授权的变更能进入 canonical？
```

目标安全属性：

```text
candidate compromise  ≠  trusted workspace compromise
```

**推论（对本机关键）**：UID 分离从「安全模型成立的前提」降为 **defense in depth**（§12）。

### 0.2 实现 Invariant（机密边界与权限收敛）

```text
Model-facing components may receive revision-scoped materialized views,
      but must never receive direct arbitrary read/write access
      to the Trusted CAS or canonical Git object store.
```

> **原因与边界落位**：Candidate Projection 已经决定了哪些 canonical 内容可以暴露给模型；如果 reviewer / verifier 拥有随意按 hash 读取整个 canonical CAS 或底层 Git object store 的能力，就会从侧面绕过 Projection 的秘密边界（Secret Boundary）。
> 模型组件仅通过由控制面生成的 revision-scoped 物化视图访问受控数据，底层存储凭据与访问接口对 model-facing 组件严格不可见（fail-closed capability）。

---

## 1. 现状

`lib/sandbox.mjs` 把整棵工作区 bind mount、用宿主同一 uid（`-v ${cwd}:${cwd}`）。
执行器在工作区内**无逐路径约束**；控制面靠"不挂载"而不可见——那是**路径隔离**，不是**权限**
（详见 `docs/PRIVILEGE-SEPARATION.md`）。

---

## 2. 目标与非目标

**目标**：executor 可任意破坏自己的 candidate；未经授权的字节**没有任何路径**进入 canonical；
授权对象是**已批准的 manifest**；裁决者非 planner 也非内容评审；零外部依赖。

**非目标**：不做 UID 分离（部署期纵深，§12）；不判「改动好不好」（内容评审，§8）；
V1 不实现 `openat2(RESOLVE_*)`（§6.3）。

---

## 3. 九个正式安全对象与三层执行环境模型（v5.2 生产与安全双闭环）

为防止架构概念无节制膨胀，AFR 坚决**不新增第十个正式安全对象**，而是引入 **Source / Runtime / Evidence 三层执行环境模型**，理顺“版本、运行与证据”的分工：

```text
1. Source Layer（版本源层 —— 决定“什么能进入 Canonical”）
   ├─ 1. Canonical Revision (refs/afr/canonical)
   ├─ 2. Materialization / Projection Policy (Candidate Source Namespace)
   ├─ 3. Live Candidate
   ├─ 4. Candidate Revision Snapshot
   ├─ 5. Candidate Manifest (Executor Delta)
   ├─ 6. Scope Grant
   ├─ 7. Authorization Ledger
   └─ 9. Accepted Promotion (Target Canonical Tree)

2. Runtime Layer（运行时层 —— 决定“程序如何真实跑起来”，派生运行环境）
   ├─ Runtime Scratch Namespace (/af-scratch/tmp, tmpfs，不进 Snapshot，结束即弃)
   ├─ Trusted Dependency Fixture (lockfile-hashed，只读注入，解决 node_modules 缺失)
   ├─ Synthetic Runtime Dirs (0755 空目录)
   └─ Mock Services & Sandbox Isolation

3. Evidence Layer（证据层 —— 决定“凭什么认为该修订可接受”，验收证据流）
   ├─ 8. Acceptance Revision
   ├─ Tier A: External Trusted Acceptance Assets（外部强门禁）
   ├─ Tier B: Baseline-anchored Repository Tests（仓内基线回归证据）
   ├─ Tier C: Candidate-authored Tests + Reviewer Signature（评审背书证据）
   ├─ Diagnostic Dry-runs (Exact-Candidate & Promotable-View 诊断运行)
   └─ Promotion Acceptance Closure（最终提升门禁闭包）
```

### 九个正式安全对象定义

| # | 对象 | 定义 | 信任属性 |
|---|---|---|---|
| 1 | **Canonical Revision** | `refs/afr/canonical` 指向的已接受 revision；由 `afr adopt` 锁定 OID + Admission Scan + CAS 创建（A4）；worktree 仅为其只读派生缓存 | 受信 |
| 2 | **Materialization / Projection Policy** | 定义 `Canonical Revision → Live Candidate` 投影；切分 Source Namespace 与 Scratch Namespace（1.1）；含 Repair Baseline View（A1）；禁用 in-place redact（1.4） | 受信（其 digest 进入 revision identity） |
| 3 | **Live Candidate** | executor 可任意写的隔离树（普通目录 / Docker volume） | 完全不受信、可销毁 |
| 4 | **Candidate Revision Snapshot** | 身份 = **`snapshot_digest = H(schema_version + sorted(path, type, normalized_mode, blob_digest))`**；采用 A6 双身份模型；在 Bounded FS Capture 完成后密封生成；blob 存 **trusted CAS** | 受信裁定 |
| 5 | **Candidate Manifest** | 由 **`Projected Baseline Snapshot ↔ Candidate Revision Snapshot`** 计算的差异（Executor Delta，P0） | 受信 |
| 6 | **Scope Grant** | **路径/语义**授权：`task_id / plan_rev / canonical_oid / scope_rev / granted_write_set / scope_digest` | 受信 |
| 7 | **Authorization Ledger** | **授权证据（provenance），不是授权源**：`{path, decision, grant_revision, policy_digest, selector_id, candidate_revision}` | 受信 |
| 8 | **Acceptance Revision** | 验收环境：`Promotable Acceptance View = Projected Baseline + Authorized Patch + Synthetic Dirs + Trusted Dependency Fixture`；按 Tier A/B/C 三级证据评估（1.2, 1.3） | 受信 |
| 9 | **Accepted Promotion** | 目标树：**`Target Canonical Tree = Baseline Canonical Tree + Authorized Cumulative Patch`**（P0）；通过 Pre/Final 闭包后构造 commit 并 CAS `update-ref` | 受信 |

> **Revision Context（不是新对象，只是字段集合，C4）**：
> `{ snapshot_digest, baseline_oid, policy_digest, scope_revision, task_id }`。
> 四层事实彻底分开：**内容事实 → `snapshot_digest`；历史事实 → `baseline_oid`；
> 策略事实 → `policy_digest`（bundle + section，C5）；授权事实 → `scope/grant revision`。**

> **六个核心语义与边界点（v5.2 明确）**：
> 1. **Snapshot 是 Capture 的输出而非输入（P0）**：必须先执行受限 FS 捕获、检查配额/DoS 与文件系统契约，将 raw bytes 存入 CAS，最后计算 hash 密封 Snapshot。
> 2. **Manifest 与 Target Tree 的基准分离（P0）**：Manifest 衡量 `Projected Baseline ↔ Candidate`；Target Tree 衡量 `Baseline Canonical + Authorized Patch`（未暴露文件原样继承）。
> 3. **A6 路径双身份模型（1.7 纠偏）**：Raw Path Identity 保持原始合法 UTF-8 字节（用于 Git/CAS/Snapshot），Policy Match Key 采用 Unicode NFC（用于规则比对）；同形异码碰撞时 `PATH_POLICY_AMBIGUITY` fail-closed。
> 4. **Runtime Scratch 物理独立（1.1）**：临时编译产物挂载在独立 scratch volume/tmpfs 上，不进入 Snapshot 与 Manifest；禁止将已有版本控制路径转为 scratch。
> 5. **两阶段闭包与三级验收证据（1.2, 1.5）**：存在 DENY 时允许 Diagnostic Dry-run，但阻断 Promotion Gating；验收证据分级评估，允许仓内测试作为回归证据与评审背书证据。
> 6. **Scope Grant ≠ Authorization Ledger**：Grant 管"允许写哪些范围"，Ledger 管"逐路径批准证据与修订追溯"。

---

## 4. 主流水线：16 步生命周期状态机（v5.1 证明闭合）

```text
 0. ADOPT                commit-ish 受信解析为固定 OID + Admission Scan + zero-OID CAS 创建
 1. PROJECT              Canonical Tree + Projection Policy → Projected Baseline + /baseline/ 只读视图 + synthetic empty dirs
 2. EXECUTE              不受信执行器在隔离容器内自由修改 candidate 工作区
 3. QUIESCE              停容器 + SIGKILL 回收子进程/孤儿进程（终止所有非受信写者；真正不可变边界为 CAS Snapshot）
 4. BOUNDED FS CAPTURE   受限全树扫描（深度/大小/数量硬限额 + A5 文件系统契约 + A6 路径契约）+ 哈希 raw bytes 写入 Trusted CAS
 5. SEAL SNAPSHOT        计算 snapshot_digest = H(...) 密封生成 Candidate Revision Snapshot
 6. DIFF                 Projected Baseline Snapshot ↔ Candidate Revision Snapshot → Candidate Manifest (Executor Delta)
 7. AUTHORIZE            机械过滤(A/B/D) + Scope Verifier(C) → 记入 Authorization Ledger；若有未决 DENY 则触发修复义务并阻断
 8. CONTENT REVIEW       基于不可变 Snapshot 内容独立评审实现质量
 9. PRE-ACCEPTANCE       核验 cumulative manifest 全量授权有效，确保无 unresolved DENY，确认策略有效
10. BUILD ACCEPTANCE     物化 Promotable Acceptance View = Projected Baseline + Authorized Patch + Synthetic Dirs（消毒 Git）
11. ACCEPTANCE           挂载只读 Trusted Acceptance Assets 运行门禁测试；区分 Diagnostic 与 Opaque（含密日志隔离入 Quarantine）
12. FINAL REVALIDATION   再次原子核验 Snapshot 未变、授权凭据仍有效、策略未变、canonical OID 等于 expected baseline_oid
13. BUILD TARGET TREE    Target Canonical Tree = Baseline Canonical Tree + Authorized Cumulative Patch（未暴露文件原样继承）
14. PROMOTE              以 Target Canonical Tree 构造 Git commit，CAS 执行 git update-ref refs/afr/canonical <new> <old>
15. REMATERIALIZE/VERIFY Trusted Worktree Materializer 从 canonical Git blob 重建宿主工作区只读缓存并核对散列一致
```

**唯一端到端拓扑**：

```text
adopt → project → execute → quiesce → capture → snapshot → diff → authorize
      → review → pre-closure → build-staging → acceptance(trusted assets)
      → revalidation → build-target-tree → cas-promote → rematerialize & verify
```

在上述状态机的任一节点与转移间隙，`executor` / `model` 对 `canonical state` **均不存在任何物理或逻辑写路径**。

---

## 5. 策略层：四带漏斗

| 带 | 判据 | 谁判 | 上模型 |
|---|---|---|---|
| **A** | `change.path ∈ approved write set` 且**不命中 protected selector** | 机械放行 | 否 |
| **B(i)** | 命中硬拒绝清单（§5.3） | 确定性拒绝 | **否，且永不** |
| **B(ii)** | ~~机械放行越界~~ | **刻意清空** | — |
| **C** | `outside scope AND not mechanically forbidden` | 独立 scope verifier，**每 candidate revision 批量一次** | 是 |
| **D** | 控制面 / 提权 / protected selector | 人工门（复用 `WAITING_HUMAN`） | 否 |

### 5.1 selector 的**归属**与准入（v4：planner 只有申请能力）

**保护项不能由被约束方定义**，而且 **planner 的 `required` 也不是授权**——它只是**申请**。
正式语义：

```text
proposed_required / proposed_anticipated        （来自 planner，仅"申请"）
        │
        ▼
Trusted Scope Validator                         （受信准入规则）
        ├─ proposed_* ⊆ policy.allowed_root
        ├─ 不得命中 forbidden
        ├─ 命中 protected_* → D（人工门）
        └─ 通过
             ▼
        Scope Grant.granted_write_set           （这才是授权）
```

```yaml
# Planner 只能"申请"（命名即表明非授权）：
proposed_required:
  - src/auth/**
proposed_anticipated:
  - tests/auth/**
  - src/common/**

# Trusted Policy 定义（planner 无权扩大或收窄）：
allowed_root:
  - src/**
  - tests/**
forbidden:
  - .git/**
  - tasks/**
  - runtime/**
  - contracts/**
protected_paths:
  - .github/workflows/**
protected_json:
  - package.json#/scripts
  - package.json#/packageManager
```

> **规则**：
> 1. `proposed_required ⊆ policy.allowed_root` 是 **trusted admission rule**，不是 planner 的声明；
> 2. planner 永远没有授予写权限的能力——**只有申请能力**；被注入的 planner 声明 `required: ["**"]`
>    也必须由准入规则挡回；
> 3. `forbidden` / `protected_*` / `allowed_root` **必须来自 trusted policy / acceptance profile**。

- 粒度：目录 / glob（`protected_json` 是**字段级**）。只接受相对路径；`..`/绝对路径在校验期拒绝。
- 锚定：`write_scope_binding = sha256(canonical(granted_write_set))`，三点校验，跑过后缺失或被改 = 篡改。
- **命中 protected selector → D（人工门），不是永远禁止**：任务确实要改 `package.json#/scripts` 时走人工批准。

> ⚠️ **实现注记（本轮的补充）**：`protected_json` 要求机械门**解析文件内容**并按 JSON Pointer 比较子树，
> 而这超出"路径/glob"能力。两个后果必须处理：
> ① 需要**规范化**（JSON 解析后比较子树），否则 executor 只要**重新格式化** `package.json`
>    就会被误判为改了 `scripts`；
> ② 解析失败（非法 JSON）本身应按 **B(i)**（fail-closed）处理。

> **可用性优先**：最容易崩的不是 verifier，而是 planner 预测不足。`anticipated` 是缓冲，
> 否则会陷入「request → verifier → restart → 又发现一个路径」的循环。

### 5.3 硬拒绝清单（B(i)）——确定性、永远开着、永不上模型

| 类别 | 处置 |
|---|---|
| `..` 逃逸 / 绝对路径 / destination escape | HARD DENY |
| 符号链接穿越 / 新建符号链接 | HARD DENY |
| **hard link**（`lstat().nlink > 1`） | HARD DENY（按内容 materialize 为新 inode） |
| device node / FIFO / UNIX socket | HARD DENY |
| setuid / setgid / Linux file capabilities | HARD DENY |
| security xattr / ACL 继承 | HARD DENY / 不继承（§10.2） |
| uid/gid ownership | 导入时重置 |
| 新增可执行位 | 由 policy / scope gate 决定 |
| mount crossing（跨设备） | HARD DENY |
| 控制面路径（`tasks/ contracts/ config/ runtime/ lib/`、policy、executor safety config、提权/host 集成） | HARD DENY（提权类 → D） |
| protected selector（§5.1） | → D 人工门 |
| 单文件大小 / 总逻辑字节 / 总磁盘块 / 文件数 / 路径长度 / 目录深度 超限 | HARD DENY |
| **Target Namespace Preflight 碰撞（1.6）**：文件/目录类型前缀冲突、Hidden subtree 碰撞、跨集合 A6 同形异码碰撞（`PATH_POLICY_AMBIGUITY`） | HARD DENY |

---

## 6. QUIESCE → BOUNDED CAPTURE → SEAL SNAPSHOT（取代 v2 的 "freeze + lease"）

v2 的 `FROZEN` 里有一条"candidate write lease 已撤销"——**本项目没有这种对象**，且
"检查没有其他 RW opener"是**瞬时观测、不是权限属性**，在纯 Node 下也不可靠。
v5.2.1 明确**受限捕获后密封**的拓扑：

```text
LIVE CANDIDATE (可写，生命周期结束丢弃)
      │  executor 在隔离容器内跑完
      ▼
QUIESCED
      ├─ 停止 executor 容器
      └─ 回收子/孤儿进程（复用 killPidTree / orphan-reaper，确认已死）
      │
      ▼
BOUNDED FS CAPTURE
      ├─ lstat 全树检查 inode 类型（B(i) 硬拒非法 inode，A5）
      ├─ 校验 A6 路径双身份契约（UTF-8, 单正斜杠, 无 .. 段）
      ├─ 硬限额前置拦截（深度、条目数、单文件大小，防 DoS）
      ├─ 计算 raw bytes SHA-256
      └─ 将原始字节复制入 Trusted CAS
      │
      ▼
SEALED SNAPSHOT
      └─ 计算 snapshot_digest = H(schema_version + sorted(...))
      │
      ▼
REVISION N（对一切 model-facing 组件不可变）
      ├─ manifest diff (Projected Baseline ↔ Candidate Snapshot)
      ├─ content review
      └─ acceptance
```

- **QUIESCED 的判据只有两条可验证的**：容器已停 + 子/孤儿进程确认已死。
  确保所有非受信写者（untrusted writers）均已被彻底终止。
- **不存在虚构的“文件系统只读锁定”**：Candidate 仍然只是宿主上的普通物理目录；系统的**真正不可变边界（Immutability Boundary）是 Sealed Snapshot + Trusted CAS**，随后立即由受信任 Capture 消费并生成不可变哈希。
- **所有安全决策面对的是 `revision`，不是 live candidate。** 若 review 要求 fix：
  `revision N` 保持不可变，executor 继续写 live candidate，产出 `revision N+1`。
- 这使后面的 `Scope Grant` / content review / acceptance / 哈希锚定**全部更容易**——
  它们只需针对一个确定的、内容寻址的 revision。

### 6.3 `openat2` 的位置

`openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)` 是理想内核边界，
但 Node 公开 `node:fs` **不暴露 `openat`/`openat2`/dirfd-relative**（有 `O_NOFOLLOW`，无 dirfd 相对操作）。
**V1 不以前置**；改为：QUIESCE 把 TOCTOU 从"需要内核原语"降级为"需要没有并发写者"，
残余是**恶意树形**（全量 `lstat` + `O_NOFOLLOW` 打开最终文件 + 拒绝非普通文件 + 新建 inode）。
`openat2` 记为未来 **defense in depth**。

---

## 7. 安全真源是 FS 扫描；Git 只做存储与 promotion

### 7.1 为什么不能用 `git add -A` 当扫描器

```bash
git add -A   # ← 默认**不加** ignored 文件
```

executor 创建 `.cache/evil`、`dist/generated`、`secret.tmp`，若被 `.gitignore` 忽略，
`git add -A` 的 manifest **看不到它们**，但 candidate filesystem 里**确实存在**。
这直接违反"`manifest` = executor **实际**产生了什么"。

> 而且不止 `.gitignore`：`GIT_DIR` 的 **`.git/info/exclude`** 与 `core.excludesFile`
> 同样会把文件藏起来（且它们位于 **canonical `.git`** 内）。

**结论（v4 精确表述）**：

```text
捕获 untrusted candidate revision 时，文件系统观察是事实来源。
捕获之后，Revision Snapshot（manifest + blob hashes）成为该 revision 的权威表示。
```

```text
Trusted FS Scanner  = 捕获时的事实来源   （不看 .gitignore，全树）
Revision Snapshot   = 捕获后的权威表示
Git tree / index / LFS / .gitignore / .gitattributes = 派生视图或存储机制
```

### 7.2 受限 FS 捕获与 Snapshot 密封（Bounded FS Capture → Seal Snapshot）

```text
LIVE CANDIDATE (QUIESCED)
      ↓
BOUNDED FS CAPTURE
      ├─ lstat every entry & classify (regular / dir / unsupported)
      ├─ enforce limits: max_depth, max_entries, max_file_bytes (前置防 DoS)
      ├─ reject unsupported inode types (A5) & validate path (A6)
      └─ SHA-256 of RAW bytes → copy raw bytes into Trusted CAS
      ↓
SEAL CANDIDATE REVISION SNAPSHOT
      └─ snapshot_digest = H(schema_version + sorted(path, type, normalized_mode, blob_digest))
      ↓
CANDIDATE MANIFEST (Executor Delta)
      └─ Projected Baseline Snapshot ↔ Candidate Revision Snapshot (ADD/MODIFY/DELETE/MODE)
```

### 7.3 Git 在受信侧做存储与 CAS promotion

- 存储：`git hash-object --no-filters -w`（按**原始内容**计算 object，绕过 attributes/filter 改写）。
- 提升：`update-ref <ref> <new> <old>`（CAS，见 §10.1）。
- **executor 从始至终看不到** `.git` / `GIT_COMMON_DIR` / `refs` / `config` / `index`。
- **拒绝 executor-facing linked worktree**：它经 `$GIT_COMMON_DIR` 与主仓共享 refs/config，
  等于给出通往 canonical Git state 的路径，违反 §0。

### 7.4 rename 不做授权语义

`rename A → B` **归一化为 `DELETE A` + `ADD B`**；Git rename detection 仅用于展示/审计。

### 7.5 Candidate Projection（候选投影）与秘密边界 —— **soundness requirement**

candidate **不是 canonical 的完整拷贝**：baseline 里的密钥不能被物化进一个**联网的** executor 容器
（否则 executor 可直接外带）。

#### 7.5.1 物化来源（C7，soundness）

```text
refs/afr/canonical  →  canonical commit/tree  →  Trusted Materializer  →  Candidate Projection
```

> **invariant：No candidate may be materialized from the canonical worktree.**
> 只能从 **`refs/afr/canonical^{tree}`** 物化。worktree 可能 stale / dirty / 含未跟踪文件 /
> 含本机 `.env` 与 build 产物；从它拷贝会把 Hard G 在**第一步**就绕回去。
>
> 附带收益：宿主工作目录里的 `.env`、IDE 文件、临时密钥**只要不属于 canonical tree，
> 从一开始就进不了 candidate**——秘密排除只需再处理「tracked but sensitive」。

#### 7.5.2 projection 与 import 是**两个轴**（C2）

```yaml
projection:            # canonical → candidate：是否把内容暴露给 executor？
  exclude: [.env, secrets/**]
  synthesize: [.env.example]
  # 注意：V1 显式禁用 redact（P0：缺乏结构化逆变换支持，整文件排除）

import:                # candidate → canonical：是否允许该目标路径被创建/修改？
  deny: [.env, secrets/**]
```

> **安全默认**：projection 中 excluded 的 canonical 路径，**import 方向默认至少 protected**，
> 除非 Trusted Policy 显式覆盖。二者语义不同、不可合并成一个 `exclude`：
> 前者是"看不看得见"，后者是"写不写得进"。

**规则**：

1. 策略未物化到 candidate 的路径，**不参与 candidate diff，也绝不能因缺失被解释成 `DELETE`**；
   diff 严格在 `Projected Baseline ↔ Candidate Snapshot` 域计算。
2. executor 在 candidate 里**新建** `.env` 会被 **`import.deny` 拦下**（B(i)/D）。
3. **V1 禁用 `projection.redact`（P0 补丁）**：任何行内或字段级脱敏（如 JSON Pointer）都缺乏可靠的逆变换合并语义（若 executor 修改了同文件其他字段，promotion 无法自动将脱敏占位符还原为真实 secret，会导致 secret 破坏）。V1 对敏感文件严格采取整文件排除（`whole-path exclude`）。
4. Policy 自身属 trusted；executor 无权要求暴露 secret；**scope expansion ≠ secret access expansion**。

#### 7.5.3 Secret Boundary：按 **hostile-code** 模型（C6，V1 security requirement）

> 一旦把 secret 注入**执行不可信代码**的进程，就不能再声称该 secret 对该代码保密。

优先级：

```text
真实生产 Secret          → NEVER
短时效 / 最小权限测试凭据   → only if unavoidable
mock / disposable service → preferred
```

Acceptance Policy 至少控制：`network / stdout-stderr / artifact export / filesystem mounts / environment / capabilities`。

- **`--network none` 是默认**，但**不够**：
  `console.log(process.env.SECRET)` → stdout → **log → operator/model** 就是外带通道。
- **秘密输出治理原则（A2）**：
  > **需要给模型看的 acceptance，原则上不应持有模型不能知道的秘密。**
- **验收分流（A2，Soundness 边界）**：
  1. **Diagnostic Acceptance（无秘密）**：常规单元测试/静态检查，失败时允许标准白名单诊断（测试名、断言行）流入模型上下文。
  2. **Opaque Acceptance（含敏感秘密/集成测试）**：仅向控制面返回退出码与状态（如 `failed`）；**原始日志/stdout/stderr 整体落入 Trusted Quarantine 隔离区**，严禁直接或未过滤进入 planner/reviewer/executor 上下文。
  3. **已知 Secret 精确值替换**：仅作为 **defense-in-depth（纵深防御）**，不得在安全论证中作为“已证明安全”的前提（恶意代码可通过编码/拼接绕过）。
- secret **不得进入** snapshot / CAS / manifest / log / model context。
- 需要服务时：`acceptance container → isolated docker network → mock/test service`，**不默认给 Internet egress**。

#### 7.5.4 只读 Repair Baseline View（A1，可修复性与活性）

- **问题**：executor 删除了受保护文件（如 `DELETE src/base.js`）被 DENY。若要求 executor 自身 remediate，但 candidate 隔离环境中没有 `.git` 亦无原文件，会导致任务无法继续的 livelock。
- **规则**：
  1. 控制面在 candidate 环境中按需挂载只读 `/baseline/` 视图。
  2. **严格隔离**：该视图必须由控制面根据同一 `baseline_oid + projection policy` 派生物化，**绝不得直接 bind mount 宿主 canonical worktree**。
  3. 该视图遵循 Projection Exclude 规则，不包含任何秘密文件。
  4. 定位属于 **liveness / repairability** 机制，不影响底层安全 Invariant。

#### 7.5.5 Candidate Source Namespace 与 Runtime Scratch Namespace 物理分离（1.1 裁决）

- **问题**：构建工具（如 `npm run build`）在构建目录（如 `dist/`、`/tmp/`）中吐出数百个临时文件，若并入源码树扫描会打爆 CAS 并造成越权报错。
- **双命名空间物理切分**：
  1. **Candidate Source Namespace (`/workspace`)**：
     - 承载项目源代码与受控文件；
     - 严格参与 Bounded FS Capture、Snapshot 密封、Manifest 差异与 Promotion。
  2. **Runtime Scratch Namespace (`/af-scratch/tmp`, `/workspace/dist` 独立覆挂)**：
     - 通过独立 Docker volume / tmpfs 挂载在执行器容器中；
     - 专门接纳编译缓存、临时测试产物与运行日志；
     - **物理不属于 Candidate Source Tree**：不参与 FS 扫描，不进 Snapshot，不进 Manifest，容器结束即被丢弃。
- **限制 Invariant**：
  > **禁止将 Canonical 中本来存在且被版本控制的路径转化为 scratch。**
  若仓库历史中已提交 `dist/index.js`，则 `dist/` 属于 Source Namespace，必须接受版本监管。Scratch 划分必须由受信任物化策略声明，绝不能依据未受信任的 `.gitignore` 自动决定。

#### 7.5.6 Canonical Bootstrap 与 Canonical Admission Scan（A4）

- **问题**：新仓库接入 AFR 时，尚未存在 `refs/afr/canonical`。
- **规则**：
  1. 初始接入必须通过显式、受信任的操作：`afr adopt --from <commit-ish>`。
  2. **解析为固定 Commit OID**：`--from main` 必须立即受信解析为不可变 Commit OID（如 `9f8a...`），严禁跟踪动态分支。
  3. **Canonical Admission Scan（准入扫描）**：
     - 在创建引用前，受信控制面遍历扫描该 commit tree。
     - 校验所有路径、对象类型（检查是否包含不受支持的 symlink、submodule、非法路径名，见 A5/A6）。
     - 只有通过扫描的 commit 允许成为 initial canonical。
  4. **CAS 原子初始化**：
     - 使用 `git update-ref refs/afr/canonical <new_oid> <zero_oid>`。
     - Git 官方语义规定使用 zero old-OID 强制要求目标 ref 预先不存在。若已存在则报 `ADOPTION_ALREADY_EXISTS`，fail closed，防止静默覆盖已有规范历史。

#### 7.5.7 Canonical Filesystem Contract（A5，底层文件系统契约）

- **Soundness Prerequisite**：Hard G 确立 `canonical truth = Git tree`，但 Git 树非完整 POSIX 文件系统快照。必须在规范层界定 AFR 承诺保真的属性范围。
- **V1 支持并规范化的状态**：
  1. `NORMAL_FILE`：普通文件字节流，mode 归一化为 `0644`。
  2. `EXECUTABLE_FILE`：具有可执行权限的普通文件，mode 归一化为 `0755`。
  3. `DIRECTORY`：纯结构化目录层级，无独立属性，物化固定为 `0755`。
- **显式拒绝或不予继承的语义（Unsupported）**：
  - **拒绝准入（B(i) 拦截）**：symlink、hardlink 身份标识、fifo、socket、device 节点。
  - **不予继承（Sanitized）**：uid、gid、POSIX ACL、extended attributes (xattrs)、capabilities、时间戳（mtime/ctime/atime）、任意自定义 POSIX mode。
- **效果**：`snapshot_digest` 计算公式中的 `normalized_mode` 获得严格数学意义，彻底消除 snapshot、promotion 与 materialization 之间的语义分歧。

#### 7.5.8 A6 Canonical Path Contract：双身份模型（1.7 纠偏）

- **Soundness Prerequisite**：Git 核心将路径视作以 `\0` 结尾的字节流，APFS 保持规范化不变。粗暴拒绝 NFD 或自动转码 NFC 都会破坏跨平台兼容性或引发原字节碰撞。AFR V1 确立 **A6 路径双身份模型**：
  1. **Raw Path Identity（原始物理路径身份）**：
     - **用途**：Git tree、`snapshot_digest`、Manifest 身份、CAS promotion；
     - **约束**：保持原始字节序列；要求是合法的 UTF-8 编码，相对路径，`/` 分隔，无 `.`/`..` 段，无 NUL 字符，大小写敏感，但不强制要求已经是 NFC。
  2. **Policy Match Key（策略比对键）**：
     - **用途**：Glob 匹配、B(i) 清单比对、`protected_paths` 判定；
     - **计算**：`policy_key = Unicode_NFC(decode_utf8(raw_path))`。
  3. **Normalization Collision Check（同形异码碰撞检查）**：
     - 若准入扫描或 FS Capture 中出现 `raw_path_A != raw_path_B` 但 `NFC(A) == NFC(B)`，触发 **`PATH_POLICY_AMBIGUITY` 错误，作为 B(i) 机械硬拒**，杜绝 Unicode 等价形式的绕过攻击。

---

## 8. 职责边界

### 8.1 四职责不合并

```text
planner          → proposes scope（required / anticipated）
executor         → produces candidate
scope verifier   → approves/denies scope expansion（只答"范围是否必要"）
content reviewer → judges implementation quality（只答"改动好不好"）
trusted importer → applies approved bytes（唯一 writer）
```

- planner 不得同时申请 + 批准 scope（`applicant == approver`）；executor 输出会回流 planner（注入面）。
- verifier 输入是**不可信文本**，必须明确界定、不参与指令；输出**结构化 + 证据**。
- **无合格独立 verifier → fail-closed 到人工门（D）**，绝不降级成作者自批。

### 8.2 增量裁决 + Ledger(证据) + 累积闭包（v5：C1 / C3）

v3 曾提出「增量 delta 判权 / 累积 manifest 提升」。**仅增量 delta 不 sound**：

```text
R1: executor 越界加入 evil.txt → verifier: DENY evil.txt（文件仍在 live candidate）
R2: executor 只改 src/a.js → delta(R1→R2) 看不到 evil.txt ⇒ 只看 delta 会判 R2 合法
    但 baseline→R2 的累积 manifest 里仍有 {ADD evil.txt}
```

**三件套**：

| 机制 | 作用 | 何时用 |
|---|---|---|
| **revision delta** | 发现"这一轮**新增**了什么授权问题"；减少 verifier 调用 | 每出新 revision |
| **Authorization Ledger** | **记录"为什么被授权/拒绝"的证据（provenance）**——**它不自身授予授权**（C1） | 每轮追加 |
| **cumulative closure check** | `∀ entry ∈ cumulative_manifest` 必须在**当前** grant + **当前** policy 下有效，否则 block | **promotion 前** |

```text
每出新 revision：
  delta → 机械分类 → 新路径越界才 scope_rev++ → verifier → 追加 Ledger
  仍在 Grant 内 → 不调用 verifier，只重跑 content review + acceptance

promotion 前：
  对 cumulative_manifest 做完整 authorization closure check
  判据 = Current Policy + Current Grant + Current Manifest Entry
```

**C1 要点**：Ledger 条目记 `{path, decision, grant_revision, policy_digest, selector_id, candidate_revision}`。
当当前 Grant 变成 rev 5 而条目记的是 rev 4，该历史 `allowed` **自动成为 stale evidence**——
**不需要重写整个 ledger**。判别始终针对**当前** grant/policy。

> **Authorization Ledger records *why* an entry was authorized; it does not independently confer authorization.**

### 8.3 DENY 的处理：blocking obligation，不是自动修复（C3）

若只把被拒项"删掉/忽略"，会破坏两条关键关系。**DENY 不自动删 live candidate，也不 promotion-ignore**：

1. **所有权**：`executor owns live candidate mutation; trusted control plane evaluates it.`
   控制面偷改 live candidate，会让 resume 同一会话时出现无法解释的状态
   （"我明明创建了它，为什么没了？"）。
2. **一致性**（更致命）：若 acceptance 仍看到被忽略的文件，而 promotion 又忽略它，则

   ```text
   src/main.js → imports evil.txt
   acceptance: 看到 evil.txt → PASS
   promotion:  忽略 evil.txt → canonical 缺文件
   ⇒ canonical 跑不起来
   ```

**正确流程**：

```text
evil.txt → DENY
   ├─ Ledger = denied
   ├─ promotion BLOCKED
   └─ explicit repair requirement → fix prompt → executor 自行移除/替换 → 下一 revision
```

> **关键规则**：**DENIED entry 不得进入 acceptance staging。**
> staging 只从 **approved cumulative manifest** 重建，**绝不从 live candidate 复制**。
> 若合法代码依赖被拒文件，**acceptance 自然 FAIL**，逼出修复。

> **DENY creates an *unresolved blocking obligation*; the executor must remediate it
> before a promotable revision exists.**（若日后为 UX 加自动修复，须做成**显式**操作并记为控制面 mutation 事件。）

---

## 9. Acceptance：两阶段闭包、受信任验收资产与干净提升

### 9.1 两阶段闭包与流水线时序（P0 补丁 / 1.5 裁决）

旧流程试图在存在 DENY 时仅靠“剔除被拒文件”跑验收，导致验收对象与 Candidate Revision 脱节。
v5.2 确立**两阶段闭包机制**并解耦**沙箱诊断运行（Diagnostic Dry-run）**：

```text
               ┌─ unresolved DENY == 0 ──> PRE-ACCEPTANCE CLOSURE ──> PROMOTION ACCEPTANCE ──> CAS PROMOTION
               │
Capture / Scan ┤
               │                           ┌─ Exact-Candidate Diagnostic (含 DENY 项，反馈完整编译/运行报错)
               └─ 存在 unresolved DENY ──> ┤
                                           └─ Promotable-View Diagnostic (剔除未授权项，反馈合规视图状态)
                                           （仅产生诊断日志喂回 executor，绝不触发提升）
```

- **诊断运行与门禁提升彻底解耦（1.5 裁决）**：
  - 当存在未解决的 blocking obligation（DENY）时，**绝对阻断 Promotion Acceptance 与提升**；
  - 但**允许在隔离沙箱中执行 Diagnostic Dry-run**，给 executor 产生编译器/测试失败堆栈反馈，彻底解决“盲人修车”死锁；
  - 诊断输出遵循 A2 秘密治理原则：无密测试反馈白名单诊断，含密测试原始日志进入 Trusted Quarantine。
- **Evidence Record 修订强绑定（Soundness，防重放）**：
  任何测试 PASS 或评审签名，必须自证是对哪一次修订产生的证据。所有 Evidence Record 强制绑定：
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
  Tier C 额外绑定：`{review_decision_id, reviewed_test_blob_digests, reviewed_snapshot_digest}`。
  修订变动 $\rightarrow$ 历史 Evidence 隐式失效（stale）；Final Revalidation 逐项比对哈希，不符则拒绝提升。

不变式：**`canonical` 永远只包含「在完整闭包校验下通过验收的 revision」**。

### 9.2 Acceptance 绝不见 canonical `.git`（修 v2 漏洞）

```text
canonical/.git  ──X──  acceptance
```

- acceptance **根本不需要 Git** → **不提供** `.git`；
- 只需要 commit hash / branch / version → 通过**受控环境变量**提供；
- 测试工具确实要求一个 Git 仓库 → 在 staging 里 `git init` 一个**一次性消毒仓库**：
  `no canonical remotes / no canonical hooks / no canonical config / no canonical refs / no credentials`。
- 能力差异记录：依赖真实 commit/remote 的测试行为不同，应显式记录或注入 mock commit-ish。

### 9.3 Acceptance Trust Closure（命令与运行闭包）

命令锚定保护的是命令字符串；闭包至少含：① acceptance command；② runner 可执行文件；③ 关键 runner/config（`package.json#/scripts`、测试框架配置）。这些由 **trusted policy 的 `protected_paths`** 严格保护。

### 9.4 Promotable Acceptance View 构造与依赖装配（P0 补丁 / 1.3 裁决）

- **验收物化视图完整构成**：
  ```text
  Promotable Acceptance View
  =
  Projected Baseline (RO)
  +
  Fully Authorized Cumulative Patch (RO)
  +
  Trusted Dependency Fixture (RO, lockfile-hashed)
  +
  Runtime Scratch (RW, tmpfs / volume)
  ```
- **Trusted Dependency Fixture 通用生命周期（1.3 / 1.5 裁决）**：
  - 严禁将宿主 `node_modules` 直接挂入验收环境（防本地链接、ABI 漂移、恶意生命周期脚本）；
  - 通用抽象哈希锁定：
    ```text
    dependency_fixture_id = H(
        dependency_input_digest
      + runtime_image_digest
      + platform_arch
      + installer_policy_digest
    )
    ```
    由生态适配器计算 `dependency_input_digest`（Node 为 lockfile+package.json+workspaces；Rust 为 Cargo.lock+Cargo.toml；Python 为 poetry.lock/requirements）。
  - **安全定性**：“Trusted”仅指由受信任 harness 构建并哈希锚定，其内部第三方包依然遵循 hostile-code 假设，构建过程绝不注入生产密钥与高权限凭据。
  - 若 Candidate 更改了依赖输入，旧 fixture 立即失效，必须由受信任 harness 在受信沙箱中执行安全受限的依赖重构。
- **测试完后绝不将 Staging 搬进 Canonical**：测试会生成 `coverage/`、`dist/` 临时文件，甚至恶意改写源码。提升只取 Manifest 里批准的原始 blob。

### 9.5 Acceptance Evidence 三级分层证据模型（1.2 裁决）

针对实际工程中测试大多位于仓内的现实，不强求每个普通任务都具备仓外 hidden tests，而是确立 **三级证据模型**：

1. **Tier A: External Trusted Acceptance Assets（外部强门禁证据）**：
   - 由控制面外部只读挂载的独立验收套件（适用于强安全或基准评测场景）；
   - **效力**：最高等级 independently trusted oracle。
2. **Tier B: Baseline-anchored Repository Tests（基线仓内回归证据）**：
   - **Baseline Regression Closure（测试闭包隔离，Soundness）**：为防止 Candidate 篡改测试辅助文件（如 `tests/helpers/**`、`jest.config.js`）造成虚假 PASS，Tier B 运行的是**基线测试闭包**——由控制面从 `refs/afr/canonical` 快照中整体提取测试目录与配置，以只读视图（RO）覆盖 Candidate 测试目录；
   - 运行组合：`Candidate 业务源码 + Baseline Regression Closure (RO)`；
   - **效力**：Trusted Regression Evidence，用于证明改动未破坏既有契约与功能。
3. **Tier C: Candidate-authored / Modified Tests（评审背书证据）**：
   - 针对“新增功能并补单测”的任务，Candidate 编写的新测试属于不可信资产；
   - **效力**：必须配合 **Content Reviewer（审查者）专门签名背书**，形成“Review-backed Evidence”，严禁单独作为自证 Oracle。

---

## 10. Promotion 与 canonical 真源

### 10.1 架构决定：Hard G 与 Target Canonical Tree 构造公式（P0 补丁 / 1.6 裁决）

> **正式定义**：`canonical truth = refs/afr/canonical`（accepted Git ref/tree）；
> `workspace/` 只是它的 **derived materialized cache**。
> **非 Git 工作区：任务准入期即拒绝**（`TASK_ADMISSION_FAIL`），**绝不保留双模型退化**。

#### Target Namespace Preflight（1.6 联合预检）

在进入 Scope Verifier 之前，Mechanical Gate 必须对全局目标命名空间执行预检（$\text{Target Namespace} = \text{Baseline Canonical Namespace} + \text{Candidate Structural Patch}$），命中者一律判为 **B(i) 硬拒**：
1. **前缀冲突**：任何新增/修改文件的路径前缀不得为现有普通文件（如已存在 `a`，新增 `a/b.txt`）；
2. **同名冲突**：任何新增普通文件不得与现有目录同名（如已存在目录 `a/`，新增普通文件 `a`）；
3. **Hidden Subtree 碰撞**：若 Baseline 存在被排除的 `secret/token.txt`，Candidate 新增普通文件 `secret` 立即 B(i) 硬拒；
4. **跨集合 A6 路径碰撞**：若 Baseline 与 Candidate 之间出现 `raw A != raw B` 但 `NFC(A) == NFC(B)`，触发 `PATH_POLICY_AMBIGUITY` 机械硬拒，防止 Git tree 提升时发生崩溃或歧义。

#### Target Canonical Tree 构造公式（P0 缺口修复）

若提升直接由“批准的 candidate blobs 构造树”，被 `projection.exclude` 排除的敏感文件（如 `.env`, `secret/**`）将从新 tree 中彻底丢失。
Promotion 目标树构造公式钉死为：

```text
TARGET_CANONICAL_TREE
=
BASELINE_CANONICAL_TREE
+
AUTHORIZED CUMULATIVE PATCH
```

- **Candidate-visible 路径**：根据批准的 `ADD / MODIFY / DELETE / MODE` 写入新 tree entry；
- **Excluded / Masked 路径**：**精确继承 Baseline Canonical Tree 的原始 tree entry**；
- **Unaffected Canonical 路径**：精确继承 Baseline Canonical Tree 的原始 tree entry。

真正保证：`projection.exclude` 意味着**执行器既看不见它，也绝无可能因看不见而删掉它**。

### 10.2 Trusted Worktree Materializer（从 Git Raw Bytes 派生物化）

在 Hard G 架构下，多文件原子的 security-critical promotion **已经在 Git object 数据库中由 `build tree → build commit → update-ref CAS` 彻底完成**。工作区只是只读派生缓存。

- **职责**：将新 Commit 对应的 tree 解包物化到宿主 `workspace/`。
- **原生 Raw Bytes 重建**：直接从 trusted Git blob 按原始字节写入，**不经由 `.gitattributes` / smudge 转换**。
- **安全属性**：每个文件**新建 inode**（普通文件 `0644`，可执行 `0755`，目录 `0755`），不继承原 candidate 的 uid/gid/ACL/xattr/capability/hardlink。
- **故障隔离**：物化失败不影响 `refs/afr/canonical` 的权威正确性，控制面可安全报错并择机触发 rematerialize。

### 10.3 并发下的 stale baseline：重基，不是丢弃

```text
Task B: baseline=R10, candidate=C-B
Task A: promotion → canonical = R11
B 尝试 promotion: expected R10, actual R11 → STALE_BASELINE
```

**不能**"重新物化 = 扔掉 B 的 candidate"（那会丢掉 B 的全部工作）。
正确行为：**保留 B 的 candidate delta，对 R11 做 rebase/replay**；干净 → 新 revision 走
review/acceptance/promotion；冲突 → resume author 对新 baseline。
`update-ref <ref> <new> <old>` 正好作为最终 **CAS barrier**：旧 ref 不匹配 → promotion 失败，而不是覆盖别人。

---

## 11. 与现有模块的映射

| 机制 | 复用什么 |
|---|---|
| QUIESCE 的进程/孤儿确认 | `lib/child-process.mjs#killPidTree`、`lib/orphan-reaper.mjs` |
| Git object / CAS promotion | `lib/rollback.mjs`（plumbing 模式）、`lib/worktree.mjs#runGit` |
| FS 扫描 / 路径规范化 | 复用 `intent/asset-classifier.mjs` 的 `realpathSync` 思路，但**独立全树实现** |
| gate 语义 | `contracts/action-types.json` 的 `AUTO_ALLOW/WAITING_HUMAN/DENY` |
| 人工门与审批落库 | `approval/intent-gate.mjs` |
| 锚定与三点校验 | `lib/acceptance.mjs` 的 `acceptance_binding` |
| 环境白名单 | `lib/executor-env.mjs` |
| 沙箱构建 | `lib/sandbox.mjs`（candidate 挂载 + `AF_SANDBOX_EXECUTORS=required`，§12.1） |
| 契约读取 | `intent/action-contract.mjs`（fail-closed） |

---

## 12. 两个前置与一个纵深

### 12.1 V1 硬前提：executor 容器化

把 `cwd` 指到 candidate **不是安全边界**——裸宿主 executor 可 `cd ..` 摸到 canonical。
所以 V1 必须明确：

```text
AF_SANDBOX_EXECUTORS = required
executor 运行在受信容器边界内
candidate 是唯一的 RW 项目挂载
canonical state 未挂载且不可写（仅暴露 projection 派生视图） / control plane absent / docker.sock absent / 非特权容器
```

**per-executor image 是部署决策，不是安全前提**（共享 runner 镜像同样满足 invariant）。

### 12.2 UID 分离 = defense in depth

即使本机做不到 `control-plane UID ≠ executor UID`，只要 executor 只能操作 disposable candidate，
主模型仍成立。未来有 root 时再补 `af-exec` UID + 控制面 `0700`。

---

## 13. 威胁模型与已知限制

- **能防**：未授权字节以任何方式进入 canonical；symlink/hardlink/xattr/mode/特殊 inode 载体；
  控制面被间接改写；越界后静默继续；超量 DoS；`gitignore` 隐藏文件被漏扫；非规范路径攻击。
- **不能防**：**已授权范围内**的错误/恶意改动（内容评审 + acceptance 兜）；裁决被理由文本注入；
  同 uid 提权（§12.2）。
- **能力差异（显式记录）**：`openat2` 未用（§6.3）；V1 禁用 `projection.redact`（§7.5.2）；
  xattr/capability 清不掉 → 改为"只收新 inode"（§10.2）；一次性验收仓库降低保真度（§9.2 注）；
  非 Git 工作区在准入期即拒绝（§10.1）。
- **成本**：candidate 物化；QUIESCE/CAPTURE/SNAPSHOT；FS 受限全树扫描；staging/acceptance/promotion 往返。

---

## 14. 测试计划（TI-x）

| 用例 | 断言 |
|---|---|
| TI-1 | baseline↔revision 差异被**准确完整**描述（ADD/MODIFY/DELETE/MODE/TYPE） |
| TI-2 | manifest 由受信 FS 扫描计算；executor 无法影响其内容 |
| TI-3 | QUIESCE 未证明（容器/进程未确认）→ **拒绝进入 scan/import** |
| TI-4 | A 带：range 内且非 protected → 放行，不调用模型 |
| TI-5 | B(i)：`contracts/`、新 symlink、hardlink、device、setuid、超限、非法路径(A6) → 确定性拒绝，**不调用 verifier** |
| TI-6 | B(ii) 为空：任何未声明变更都不会被机械放行 |
| TI-7 | C 带：每 revision **一次**裁决；准/驳都写证据 |
| TI-8 | D 带：控制面/提权/**protected selector** → 人工门 |
| TI-9 | Scope Grant：plan_rev / canonical_oid / granted_write_set / scope_digest 变化 → invalidate（C5） |
| TI-10 | staging 只由已批准 blob 重建；acceptance 产生的 `coverage/` 等**不进 canonical** |
| TI-11 | Acceptance Trust Closure：改 `package.json#/scripts` → 被拦（命令锚定挡不住） |
| TI-12 | promotion 只应用原始已批准 blob；mode/uid/xattr/setuid 不被继承（新 inode） |
| TI-13 | promotion 崩溃 → CAS 语义下无半应用；非 Git 工作区准入即拒（`TASK_ADMISSION_FAIL`） |
| TI-14 | post-commit/materialize 哈希核对失败 → 显式失败 |
| TI-15 | executor-facing candidate **不共享** canonical `.git` |
| TI-16 | rename 归一化为 DELETE+ADD（授权语义） |
| **TI-17** | **`.gitignore` 忽略的文件仍出现在 manifest**（FS 扫描是真源） |
| **TI-18** | acceptance **挂不到** canonical `.git`；需要 Git 时用一次性仓库 |
| **TI-19** | `protected_json`：**仅重新格式化** `package.json` 不触发保护（需规范化） |
| **TI-20** | Scope Grant 内的新 revision **不调用** verifier；只有新路径才 `scope_rev++` |
| **TI-21** | stale baseline → **保留** B 的 candidate delta 并 rebase，而非丢弃 |
| **TI-22** | 无合格 verifier → fail-closed 到 D，不自动放行 |
| **TI-23** | Pre-acceptance closure：存在 unresolved DENY 项时，门禁验收直接阻断 |
| **TI-24** | A6 路径契约：非法 UTF-8、`..` 穿越、NUL 字节在 Capture 阶段 B(i) 拦截 |
| **TI-25** | Promotion Target Tree：未暴露于 Candidate 的 excluded 敏感文件在提升后完整继承 |
| **TI-26** | **Evidence Replay**：R1 acceptance PASS → 产生 R2 → R1 Evidence 自动标记 stale，绝不允许跨 revision 重放 |
| **TI-27** | **Tier B Closure**：Candidate 篡改 `tests/helpers/**` 或测试配置 → Tier B 仍强制只读注入 Baseline Regression Closure → 杜绝伪造 PASS |
| **TI-28** | **Dependency Fixture**：`dependency_input` / runtime image / arch / installer policy 任一变化 → `fixture_id` 改变，旧 fixture 绝不复用 |
| **TI-29** | **Target Namespace Cross Collision**：Baseline hidden NFD 路径 + Candidate NFC 等价路径 → Target Namespace Preflight 机械拦截（`PATH_POLICY_AMBIGUITY` / B(i)） |
| **TI-30** | **Runtime Scratch**：Scratch 命名空间中生成 1000 个构建产物 → 不进入 Candidate Snapshot / CAS / Manifest |
| **TI-31** | **Diagnostic vs Promotion**：存在 unresolved DENY 项 → Diagnostic Dry-run 可以执行获取诊断堆栈 → Promotion Acceptance 与 CAS `update-ref` 必须绝对阻断 |

---

## 15. 未决问题

**正式架构选择已定案**：canonical 真源 = **Hard G**（`refs/afr/canonical`；非 Git 工作区准入即拒绝）。见 §10.1。

### 15.1 架构裁决与补丁归档（C1–C7、A1–A6、P0–P2 已全部定案闭合）

| 编号 | 项 | 最终定案与写入位置 | 属性 |
|---|---|---|---|
| **C1** | Ledger 黏性 | Ledger 作为 provenance 记录，授权动态评估，旧条目自动 stale（§3, §8.2） | Soundness |
| **C2** | exclude 双向 | `projection.exclude` 与 `import.deny` 拆为独立双轴（§7.5.2） | Soundness |
| **C3** | denied livelock | DENY 产生 blocking remediation obligation，不自动删（§7.5.1, §8.2） | Soundness |
| **C4** | revision identity | 拆解为纯内容 `snapshot_digest` + 外挂 Revision Context（§3, §7.4） | Soundness |
| **C5** | policy 分家 | 收敛为 Policy Bundle (`bundle_digest`) + Section Digests（§3, §7.5） | 架构简化 |
| **C6** | acceptance 秘密 | 假设测试代码敌对，stdout/stderr/日志属外带通道，生产秘密永不注入（§7.5.3） | 安全基线 |
| **C7** | baseline 来源 | 只能从 `refs/afr/canonical^{tree}` 物化，绝不从 worktree 拷贝（§3, §7.5.1） | Soundness |
| **A1** | baseline 只读视图 | 派生自同一 `baseline_oid + projection policy` 的 Repair Baseline View（§3, §7.5.4） | 可修复性/活性 |
| **A2** | acceptance 输出脱敏 | 区分 Diagnostic 与 Opaque Acceptance；含密日志隔离入 Trusted Quarantine（§7.5.3） | Soundness/纵深 |
| **A3** | 空目录语义 | 引入 `synthetic_dirs` 运行时物化策略，拒绝默认 `.gitkeep` 篡改语义（§3, §7.5.5） | 语义完整 |
| **A4** | bootstrap 机制 | `afr adopt` 锁定 OID + Canonical Admission Scan + zero-OID CAS 创建（§3, §7.5.6） | 启动安全 |
| **A5** | 文件系统契约 | Canonical Filesystem Contract：收窄仅支持普通文件/执行位/目录结构（§3, §7.5.7） | 底层语义前提 |
| **A6** | 路径双身份契约 | Raw Path 保持 Git 字节身份 + NFC 仅用于 Policy Match Key，碰撞时 fail-closed（§7.5.8） | 跨平台一致性 |
| **P0** | Capture/Seal 拓扑 | `BOUNDED FS CAPTURE → SEAL SNAPSHOT`，前置防 DoS 限额（§4, §7.2） | 流水线闭合 |
| **P0** | Manifest 基准 | `Projected Baseline ↔ Candidate Snapshot`（§3, §7.2） | 语义正确 |
| **P0** | Target Tree 公式 | `Target Canonical Tree = Baseline Tree + Authorized Cumulative Patch`（§3, §10.1） | 防文件丢失 |
| **P0** | Redact 禁用 | V1 显式禁止 `projection.redact`，整文件排除（§7.5.2） | 消除空洞 |
| **P0** | 两阶段闭包 | Pre-acceptance closure（无 DENY 准入）+ Final Revalidation（§9.1） | 闭包闭环 |
| **E1** | Scratch 物理隔离 | Candidate Source 与 Runtime Scratch 物理切分，防构建产物污染（§7.5.5） | 运行可用性 |
| **E2** | 验收三级证据 | Tier A 外部强门禁、Tier B 仓内基线回归、Tier C 业务测试审查背书（§9.5） | 现实工程可用 |
| **E3** | 依赖受信任装配 | Trusted Dependency Fixture 哈希锁定 lockfile + runtime + arch（§9.4） | 依赖防污染 |
| **E4** | 诊断与门禁解耦 | 存在未决 DENY 时允许 Diagnostic Dry-run 沙箱运行调试，仅阻断提升（§9.1） | 避免盲修死锁 |
| **E5** | 命名空间结构检查 | 前置 Namespace Structural Check，B(i) 硬拒文件目录前缀冲突与 hidden 碰撞（§10.1） | Git 数据底层防崩 |

### 15.2 实现细节（各有默认）

2. `protected_json` 的语法与规范化（JSON Pointer 子集；解析失败 = B(i)）。
3. candidate 物化方式（普通目录拷贝；overlay 非特权不可用）。
4. 内容评审时序（import 前对 revision；§4 第 9 步）。
5. 与 `intent/action-validator.mjs` 的合并方式（扩展 gate vs 并列）。
6. 人工门（D）的操作面（`af-admin` vs `intent-gate`）。
7. 一次性验收仓库的保真度替代方案（env 注入 commit-ish 的清单）。

---

## 16. 实现阶段规划（Implementation Phases）

架构与实现规范已正式全量冻结。工程实现严格遵循“先建立不可变事实源，再做机械授权，再做 Hard G 提升，最后接入运行时证据与智能门禁”的原则，分五阶段有序推进：

| Phase | 阶段名称 | 核心建设内容 | 验证与完成标志 | 对应测试 |
|---|---|---|---|---|
| **Phase 1** | **Capture Truth（事实捕获底座）** | • `afr adopt` 入仓扫描与 zero-OID CAS 创建<br>• Candidate Projection 隔离挂载与 Source/Scratch 切分<br>• QUIESCE 判定（容器停止 + 子/孤儿进程清理，确认无非受信写者）<br>• **Bounded FS Capture + DoS 限额前置拦截**（inode 过滤、A5/A6 路径契约）<br>• Seal Snapshot（raw bytes 入 Trusted CAS，密封生成 snapshot_digest）<br>• Manifest 机械差异计算（对齐 Projected Baseline） | 实际变化被准确完整描述，限额在 CAS ingest 前生效，未暴露文件不算 DELETE，FS 扫描与快照不受模型干扰 | TI-1 ~ TI-6, TI-15, TI-17, TI-24 |
| **Phase 2** | **Mechanical Authorization（机械授权与预检）** | • Scope Grant 机械模式匹配<br>• A 带放行与 B(i) 确定性硬拒<br>• Protected Selector 识别（protected_json 规范化）<br>• **Target Namespace Preflight 联合预检**（前缀冲突、Hidden 碰撞与 A6 跨集合 NFC 歧义拦截）<br>• Authorization Ledger 证据存证<br>• 累积闭包初校验（无未决 DENY） | 机械策略门生效，任何未授权或结构冲突条目在 B(i) 阶段被确定性拦截，绝不调用模型 | TI-7 ~ TI-9, TI-16, TI-19, TI-20, TI-29 |
| **Phase 3** | **Hard G Promotion（受信导入与提升）** | • Target Canonical Tree 构造（Baseline Tree + Authorized Cumulative Patch，保留未暴露敏感文件）<br>• Git Tree / Commit 受信对象构造<br>• CAS 原子 `update-ref`（`refs/afr/canonical`）<br>• Trusted Worktree Materializer（新 inode 物化，安全元数据净化） | 安全模型主体成立：实现真正的 Hard G 提升，不可变版本库原子前进，崩溃具备事务自愈性 | TI-10, TI-12, TI-13, TI-14, TI-25 |
| **Phase 4** | **Runtime + Evidence（运行时支持与分层证据闭环）** | • Runtime Scratch Namespace 独立挂载（物理隔离，不入快照）<br>• **Trusted Dependency Fixture** 构建与哈希标识绑定（lockfile 锚定，适配多语言）<br>• **Diagnostic Dry-run** 运行调试支持（Exact-Candidate 与 Promotable-View）<br>• Tier A / Tier B / Tier C 三级验收执行管道<br>• **Baseline Regression Closure（RO 测试集注入）**<br>• **Evidence Record 7元组强绑定**<br>• Pre-acceptance closure 与 Final Revalidation 门禁 | 现实工程构建与测试跑通；证据严格绑定特定 Revision，杜绝旧凭证重放与测试 helper 篡改漏洞 | TI-11, TI-18, TI-23, TI-26, TI-27, TI-28, TI-30, TI-31 |
| **Phase 5** | **Intelligent / Operational Gates（智能门禁与深度防御）** | • Scope Verifier 模型接入与 C 带单次裁决<br>• Human D Gate 人工审批流与交互面集成<br>• Stale Baseline 自动 Rebase 处理<br>• `af-exec` UID 隔离运行与控制面权限剥离<br>• 严格 Docker seccomp / apparmor profile 与网络防御 | 智能语义门禁与人工审批闭环；部署期深度防御全面就位，不阻塞主安全模型成立 | TI-21, TI-22 |

> **落地策略**：
> 坚决先完成 **Phase 1（事实捕获底座）** 并**只靠机械门与单元测试验证**，不急着上 verifier。
> 下一阶段重点是由 Phase 1 的代码、真实故障注入和对抗性测试暴露问题，而非停留在纸面上增加新概念。
