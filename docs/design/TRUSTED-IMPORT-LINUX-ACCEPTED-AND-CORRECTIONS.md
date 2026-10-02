# 受信导入：采纳清单与纠正（Linux 约束版）

> **目的**：把这一轮评审的**采纳项**与**我方纠正/补充项**合并成一份可执行记录，
> 并说明**哪些是由 Linux 的机制与限制决定的**（因此文件名含 `Linux`）。
>
> **上游文档**：
> `docs/WRITE-SCOPE-ENFORCEMENT.md`（v2 架构）、
> `docs/design/AFR-TRUSTED-IMPORT-ARCHITECTURE-REVIEW.md`（外部评审）、
> `docs/design/ASSESSMENT-OF-TRUSTED-IMPORT-REVIEW.md`（我方评估 + §7 三点正式答复）、
> `docs/PRIVILEGE-SEPARATION.md`（同 uid 根因）。
>
> **状态**：设计输入（不含实现）。本文不推翻 v2，只标出实现前**必须定死**的点。

---

## 0. 一句话

主模型（`executor = candidate 生产者` / `Trusted Importer = 唯一 writer`）**采纳**；
但外部评审里有 **1 处内部矛盾、1 处真实漏洞、1 处未言明前提、3 处未定义**，
其中第一条有一半责任在我方 v2 文档。以下逐条给出**我的提案**。

---

## 1. 采纳清单（无保留）

| # | 采纳项 | 来源 |
|---|---|---|
| A1 | `executor` 不是 canonical 的 writer，只产出 candidate；`Trusted Importer` 是唯一 writer | 评审 §1 |
| A2 | 授权对象是 **candidate manifest**，不是整个 candidate 文件系统 | 评审 §15 |
| A3 | 三类信息拆开：`candidate_manifest` / `requested_scope_expansion` / `denied_write_events` | 评审 §3 |
| A4 | 「申请不需要可信，批准才需要可信」 | 评审 §3.2 |
| A5 | 四带漏斗保留：A 放行 / B(i) 硬拒 / **B(ii) 空** / C verifier / D 人工门 | 评审 §6 |
| A6 | `Scope Grant` 绑定 **`scope_revision`**，不绑单次 run、不绑整个 task；任一要素变化即失效 | 评审 §5 |
| A7 | `required / anticipated / forbidden` 三列表提升了可用性 | 评审 §9 |
| A8 | Importer 只写**新 inode**、不继承 uid/gid/ACL/xattr/capability/setuid | 评审 §11–12 |
| A9 | rename **不作为授权语义**，归一化为 `DELETE A + ADD B` | 评审 §（答复） |
| A10 | `openat2` 从 V1 硬前提**降为** defense in depth | 我方 4.1 答复 |
| A11 | **Freeze 升级为正式安全状态**；无法证明 freeze 则不得进入 diff/import | 我方 4.1 答复 |
| A12 | `trusted staging → acceptance → promotion`（**不是** import → acceptance → rollback） | 我方 4.2 答复 |
| A13 | 引入 **Acceptance Trust Closure** | 我方 4.2 答复 |
| A14 | promotion 只应用**原始已批准 blob**，不是 acceptance 后的 staging | 我方 4.2 答复 |
| A15 | 拒绝 executor-facing linked worktree；Git 只在**受信侧**用临时 index | 我方 4.3 答复 |
| A16 | `No model-facing component may directly mutate the canonical workspace` 作为 invariant | 评审 §18 |
| A17 | UID 分离降级为 defense in depth，不再阻塞 V1 | 评审 §19 / 我方评估 §2 |

---

## 2. 我方纠正与补充（含默认提案）

### ② -1【真矛盾】`Acceptance Trust Closure` 与 `anticipated` 冲突

- **问题**：评审 §9.2 要求把 `package.json` 的 `scripts` 列为 protected，而其 §5.1 的
  `anticipated` 例子正是 `package.json`。**同一条路径不能既 immutable 又任务可改。**
- **根因**：这是**粒度**问题——`目录/glob` 粒度无法同时表达「`dependencies` 可改、`scripts` 不可改」。
- **我的提案（默认）**：scope 增加一个**字段级**维度：

  ```yaml
  required:      [src/auth/**]
  anticipated:   [tests/auth/**]
  protected_fields:            # 新增：即使落在可写范围内，这些字段/子树不可改
    - package.json#/scripts
    - .github/workflows/**
    - package.json#/packageManager
  ```

  机械门在 A 带之前先算 `protected_fields` 命中：命中 → **D（人工门）**，不进 verifier。
- **本提案同样适用于我方 v2 文档**（我原样继承了该矛盾，需一并修）。

### ② 0【真漏洞】验收执行 candidate 的测试代码，而验收需要 `.git`

- **问题**：`npm test` / `node --test` 常常要读 `.git`（版本、hooks、快照）。
  而**测试文件本身是 candidate 里被 `ADD` 进来的、攻击者可控的代码**。
  于是只要测试代码里写 `.git/config`、跑 `git config`，就**改到了 canonical 的 `.git`**。
  这直接反驳"candidate → canonical 无直接路径"。
- **我的提案（默认）**：验收沙箱**绝不挂 canonical `.git`**：
  1. staging 内放 **`.git` 的副本**（或只读挂载）；
  2. 验收前后对 staging 的 `.git` 做**哈希核对**，任何写入 → **验收判失败**；
  3. `.git` 在 Acceptance Trust Closure 里列为 protected（配合 ②-1）。
- **说明**：AFR 现状（工作区含 `.git`）本来就有这个问题，但新模型必须显式封堵，否则 invariant 不成立。

### ② 1【未言明前提】模型要求"executor 只能碰 candidate"，这**要求容器化**

- **问题**：在裸宿主机上把 `cwd` 指到 candidate 无效——executor 可以 `cd ..` 摸到 canonical。
  所以"executor 只能产出 candidate"隐含 **executor 必须被隔离**。
  而本项目 **executor 沙箱默认 OFF**（`AF_SANDBOX_EXECUTORS`），
  **每执行器一个镜像**的策略仍是未决部署决策（ROADMAP §六① / `P2-FEASIBILITY.md` §四）。
- **我的提案（默认）**：把 **V1 前置**写成一句明话：
  > **Trusted Import 模型的 V1 前置 = executor 容器化 + 每执行器镜像策略已拍板。**
  未拍板前，V1 只能先在**验收路径**（已有沙箱）上验证 manifest/importer 部分，
  不能宣称"executor 已被隔离"。

### ② 2【未定义】Freeze 的"candidate write lease revoked"在本项目不存在

- **问题**：本项目 executor 是普通 CLI 进程，**没有"candidate write lease"这种对象**；
  留着一个不可判定的条件会让 `FROZEN` 永远无法证明。
- **我的提案（默认）**：删掉该条，`FROZEN` 的判据只保留**可验证**三项：
  1. executor 容器已停止（沙箱存在时）；
  2. 子/孤儿进程**确认已死**（复用 `lib/child-process.mjs#killPidTree` + `lib/orphan-reaper.mjs`）；
  3. 确认无其他 RW 消费者（candidate 目录在本进程外无打开者）。
  （若将来真的引入租约，再作为第 4 条加回。）

### ② 3【未解决】promotion 的多文件原子性

- **问题**：POSIX 上**多文件无法真正原子应用**；逐文件 `rename` 原子，整份 manifest 不是。
  "all-or-fail 或至少可恢复 journal"没有解决冲突。
- **我的提案（默认）**：**把原子单位接到 git 上**——
  Importer 先 `hash-object -w` 写入已批准 blob，再**单次 `update-ref`/`commit`** 移动引用；
  写 object + 移 ref 是原子的。工作树更新是幂等的第二次 pass（失败可重放）。
  这正好复用 `lib/rollback.mjs` 已有的 plumbing，不需要新依赖。
- **注意**：这要求 canonical 是 git 仓库（AFR 的 `fixture_dir` 通常就是，P7 也依赖这点）；
  非 git 工作区需显式降级为"逐文件 + journal"，并**记录能力缺失**。

### ② 4【未定义】candidate 生命周期 / fix 循环 / 并发

- **问题**：
  - AFR 的 fix 要 **resume 同一会话、跨修订累积**。每轮从 baseline 重物化会丢前一轮；
    若累积，则 manifest 是**累积 diff**，`Scope Grant` 必须在**每轮对累积 manifest 重估**。
  - 并发：多任务各自物化 candidate，提升串行；**A 提升后 B 的 `baseline_digest` 失效**，
    B 必须重物化。评审否掉了 worktree ⇒ **每任务一份完整物化**，成本与失效策略未提。
- **我的提案（默认）**：
  1. **candidate 跨修订存活**（一个任务一个 candidate，直到 promotion 或任务终止）；
  2. manifest 始终是 **baseline → candidate 的累积 diff**，**每修订重估**（防"本轮新增"绕过上轮判断）；
  3. promotion 前重核 `baseline_digest`；不匹配 → **fail-closed，物化重来**；
  4. 多任务并发时，**promotion 串行化**并记录"因 baseline 失效而重物化"的事件。

---

## 3. Linux 约束如何塑造这份设计（为什么名字里要有 Linux）

| Linux 事实（本机实测 / 通用） | 对设计的影响 |
|---|---|
| `node:fs` **不暴露** `openat`/`openat2`/dirfd-relative（有 `O_NOFOLLOW`，无 `RESOLVE_*`） | 采纳 **A10**：V1 用"先冻结、再 diff"；`openat2` 为未来升级项 |
| `O_NOFOLLOW` **只作用于最后一个路径分量**，中间符号链接仍会被跟随 | 必须**全树 `lstat`** + 显式拒绝任何符号链接（B(i)），不能只靠 `O_NOFOLLOW` |
| 非特权 user namespace **被禁**（`bwrap`/`unshare` 失败，`systemd-run` MemoryMax 无效） | 隔离**只能走 Docker**；这直接把 ②1 变成硬前提 |
| `overlayfs` 非特权不可用 | candidate 物化只能用**普通目录拷贝**或 **Docker volume**；不能用 overlay 省拷贝 |
| **hard link** 无法用 flag 拒绝，需 `lstat().nlink > 1` 检出并按内容 materialize | 采纳 **A8**：所有导入新建 inode，绝不 preserve hardlink |
| device/FIFO/socket 由 `S_IF*` 位标识 | B(i) 用 `lstat().mode` 位判断后 HARD DENY |
| **file capabilities / ACL / security xattr 都是 xattr**，而 **Node 无 xattr API** | ⚠️ **纯 Node 无法清除它们**：要么 shell 到 `setfattr`/`setfacl`（需确认本机有），要么**只允许从"新写入的普通文件"导入**（新 inode 天然不带源 xattr）。**默认取后者** |
| `setuid`/`setgid` 是 mode 位，`fs.chmod` 可控 | Importer 显式设置**批准过的 mode**，未包含的位自然被清掉 |
| `rename` **同文件系统内**原子；跨设备 `EXDEV` | 临时同级文件必须与目标同 fs；B(i) 的 **mount crossing = HARD DENY** 同时保证这一点 |
| `fsync(file)` 之后还需 `fsync(dir)` 才是持久化 | Importer 的写入序列必须含 `fsync(parent)` |
| ext4 按**字节**存名，大小写/Unicode 归一化碰撞在 Linux 上少见（macOS 才有） | B(i) 的 case/normalization 碰撞检查保留，但**非 Linux 阻塞项**；记入能力差异 |
| Git `commit` = 写 object + 移 ref，**原子** | 采纳 ②3：promotion 的原子单位用 git，而非 POSIX 多文件 |
| 验收要读 `.git`，而 candidate 的测试代码是 untrusted | 采纳 ②0：`.git` 用副本/只读 + 哈希核对 |

> 一句话：**这份设计里"能不能原子、能不能清 metadata、能不能隔离、能不能用 dirfd"这四件事，
> 全部由 Linux（含本机内核/权限）的机制决定**——所以文件名含 `Linux`。

---

## 4. 因此 v2 文档需修改处（action list）

1. `docs/WRITE-SCOPE-ENFORCEMENT.md` §5.1：增加 **`protected_fields`**（修 ②-1 的继承矛盾）。
2. 同文档 §9.2：`Acceptance Trust Closure` 补 **`.git` 副本/只读 + 哈希核对**（②0）。
3. 同文档 §6：`FROZEN` 判据删掉 **lease**，只保留三项可验证条件（②2）。
4. 同文档 §10：promotion 明确 **git `commit`/`update-ref` 作为原子单位**，非 git 工作区显式降级（②3）。
5. 同文档新增一节 **candidate 生命周期与并发**（②4）。
6. 同文档 §15 未决问题：把 **②1（executor 容器化 + 镜像策略）** 明确为 **V1 前置**。
7. `docs/design/ASSESSMENT-OF-TRUSTED-IMPORT-REVIEW.md`：在 §7 追加"评审仍存在的 6 处问题"指引到本文。

---

## 5. 未决问题（需人裁决，非技术阻塞）

| # | 问题 | 我的默认提案 |
|---|---|---|
| 1 | `protected_fields` 的语法与解析（`package.json#/scripts` 这种 JSON Pointer？） | 用 JSON Pointer 子集；先只支持 `file#/json/path` 与 `dir/**` |
| 2 | xattr/capability：shell 到 `setfattr` 还是"只收新 inode" | **只收新 inode**（新文件天然无源 xattr），不引入外部工具 |
| 3 | 非 git 工作区的 promotion 原子性 | 逐文件 + journal，并**记录能力缺失**，不静默 |
| 4 | content reviewer 在 import 前还是 promotion 后 | import 前（对 candidate），保持"评审独立于作者"不变 |
| 5 | candidate 的物化方式（普通目录 vs Docker volume） | 普通目录拷贝（overlay 非特权不可用） |
| 6 | 并发多任务时的 baseline 失效处理 | promotion 串行 + 失效即重物化 + 记录事件 |

---

# 第二轮：结论收敛（已写回 `docs/WRITE-SCOPE-ENFORCEMENT.md` v3）

## 6.1 第二轮结论表

| 项目 | 结论 | 已落到 v3 的位置 |
|---|---|---|
| ②-1 `protected_fields` | ✅ 问题成立；**拆成 `protected_paths` + `protected_json`，且归属 trusted policy（planner 无权）** | §5.1 |
| ②0 acceptance `.git` | ✅ 漏洞成立；**前后 hash 不是安全边界**（可"改→用→还原"）；**acceptance 永不挂 canonical `.git`**，需要 Git 时用一次性消毒仓库 | §9.2 |
| ②1 executor 容器化 | ✅ **是 V1 硬前提**；但 **per-executor image 是部署决策，不是安全前提** | §12.1 |
| ②2 Freeze | ⚠️ "无其他 RW opener"不可靠（瞬时观测、纯 Node 不可证）→ **改为 Candidate Revision Snapshot**（QUIESCED → SNAPSHOTTED） | §6 |
| ②3 Git promotion | ⚠️ 只有把 **Git ref 定义为 canonical 真源**才成立；否则必须长期保留 journal | §10.1 |
| ②4 candidate 生命周期 | ✅ 主方向成立；**Scope Grant（路径/语义）与 Manifest Approval（revision/hash）必须分离** | §8.2 |
| 并发 stale baseline | ✅ **不能丢弃候选**；应保留 delta 并 rebase，`update-ref` 作 CAS barrier | §10.3 |
| Git index 当扫描器 | ⚠️ **遗漏确认**：`git add -A` 跳过 ignored 文件 → **FS 全扫描 = 安全真源，Git 只做存储/promotion** | §7 |

## 6.2 本轮我额外补充的四点（评审与答复都没覆盖）

1. **`protected_json` 需要内容解析 + 规范化。** 字段级保护超出"路径/glob"能力，
   必须解析 JSON 后比较子树，否则 **executor 只要重新格式化 `package.json` 就会被误判为改了 `scripts`**；
   解析失败应按 B(i) fail-closed。（v3 §5.1 注记 + TI-19。）
2. **`.git/info/exclude` 与 `core.excludesFile` 也会隐藏文件**，且它们位于 **canonical `.git`** 内。
   这比 `.gitignore` 更支持"FS 扫描 = 真源"的结论。（v3 §7.1。）
3. **一次性验收仓库会降低保真度。** 依赖真实 commit hash / remote / hooks 的测试行为会不同，
   必须显式记录并给受控替代（env 注入 commit-ish），或标为"本机不可验证"。（v3 §9.2 注。）
4. **选 G（Git ref 作真源）是迁移，不是加法。** 它波及 `task.fixture_dir` 语义、
   验收"只观察自己的工作区"（`PRESERVE.md` 资产 1）、以及 P7 restore points。
   好的一面：P7 已在用 `refs/af-restore/*`，`refs/afr/canonical` 与既有模式一致。（v3 §10.1。）

## 6.3 现在的状态

- **唯一"正式架构选择"**：canonical 真源 = **Git ref（G）** 还是 **filesystem（F）**。
  选 G → 模型基本闭环；选 F → 多文件 journal/recovery 必须长期保留。
- 其余均为实现细节，各有默认（v3 §15）。
- 下一步：定 G/F，然后落 **Phase 1**（baseline + candidate + QUIESCE/SNAPSHOT + **FS 全扫描** + manifest，
  只配机械门，带 TI-1/TI-3/TI-17 等测试）。
