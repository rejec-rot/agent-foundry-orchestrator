# 第三轮讨论：对第二轮反馈的观点

> **性质**：讨论记录（每轮讨论一份）。本轮只表达**我方观点**，不改动 v3 架构正文；
> 待你裁决后再写回 `docs/WRITE-SCOPE-ENFORCEMENT.md`。
>
> **上游**：`docs/design/TRUSTED-IMPORT-LINUX-ACCEPTED-AND-CORRECTIONS.md`（含第二轮结论）、
> `docs/WRITE-SCOPE-ENFORCEMENT.md`（v3）。

---

## 0. 总体判断

第二轮**修对了两处 soundness 问题**（这是它的价值所在，不是修辞）：

1. `git add -A` 不能当扫描器 → **FS 全扫描 = 安全真源**；
2. acceptance 永不接触 canonical `.git`（它对我"前后 hash"的反驳成立）。

但它在**三处不够精确**（照写会埋雷）、**漏了三处**（其中"baseline 泄密面"是 candidate 模型
自己引入的新风险）、**有一处我明确反对**（非 git 的弱化处理）。

---

## 1. 我完全同意的两点（第二轮的真正价值）

### 1.1 FS 扫描是安全真源，不是优化

`git add -A` 会跳过 ignored 文件，于是 manifest ≠ 实际产出。这是**正确性**问题：
manifest 的定义是"executor 实际产生了什么"，而不是"git 眼中产生了什么"。

### 1.2 acceptance 永不接触 canonical `.git`

第二轮对我的"`.git` 副本 + 前后哈希"的反驳是对的：
恶意测试可以 **改 `.git` → 使用修改结果 → 还原 `.git`**，前后哈希一致。
所以**前后哈希是审计，不是边界**。一次性 `git init` 的消毒仓库是更干净的解法。

---

## 2. 三处需要精确化（照第二轮的写法会埋雷）

### 2.1 `protected_*` 归 policy 是对的，但 **policy 还必须界定 planner 的 `required`**

第二轮只说"protected selector 不能由 planner 定义"，**没说 planner 的 `required` 也要有上界**。

一个被注入的 planner 只要声明：

```yaml
required: ["**"]
```

就在**合法范围内**全放行了——保护项没被绕过，但整个漏斗被架空。

> **补充规则**：`required ⊆ policy.allowed_root`，且 `required ∩ (forbidden ∪ protected_*) = ∅`，
> 由 **trusted policy** 校验，planner 无权扩大。

### 2.2 Snapshot 的"不可变"是**内容寻址**意义上的，不是物理冻结目录

第二轮说 revision「对一切 model-facing 组件不可变」，**但没说如何做到**——目录本身锁不住
（root / 后续进程都能改）。若"snapshot"= 冻结的目录，这个不可变是假的。

> **建议**：`Candidate Revision Snapshot ≡ {(path, blob-hash, mode)} + 内容寻址的 blob 存储`。
> "不可变"由**哈希身份**保证；后续 review/acceptance 读 **blob**，不读那个可能被再改的目录。
> 附带收益：**消灭一整类 TOCTOU**。

### 2.3 "canonical absent" 措辞不精确

executor 要工作，**baseline 的内容必然以 candidate 形式存在**。
真正 absent 的是 canonical 的**身份 / ref / 控制面**，不是它的字节。

> 建议 invariant 写成：**no path to canonical *state***（而非 canonical absent），否则测试会写歪。

---

## 3. 漏掉的三处（我认为是真问题）

### 3.1 baseline 物化 + executor 需要网络 = **新泄密面**（优先级最高）

executor 必须联网调模型；candidate 是 baseline 的拷贝。
**若 baseline 含密钥（`.env`、凭据、私有配置），把它拷进一个能上网的容器，executor 就能外带。**
这是 candidate 模型**自己引入**的风险——v1 挂载原工作区时也存在，但新模型让它**每次物化都发生**。

> 必须进 V1：**baseline 物化遵守密钥排除策略**——敏感文件不进 candidate，或以占位符进入。

### 3.2 判权用**增量**，提升用**累积**

第二轮说"每修订对**累积 manifest** 重分类"。累积对（promotion 要它），但**判权只需增量 delta**：
路径在 Grant 内 → 放行；不在 → C 带。逐修订重扫整树是浪费。

> 拆法：**增量 delta 对 Grant 判权；累积 manifest 供 promotion。**（v3 §8.2 已部分体现，此处明确。）

### 3.3 `.gitignore` 只是"git 视图 ≠ 文件系统真相"的**第一个**实例 → 应升为第一原则

更隐蔽的第二类：**`git-lfs` 与 `.gitattributes` filter**——
`git add` 在 tree 里存的是**指针 / 规范化后的字节**，不是工作树真实内容（CRLF 规范化同理）。

> 因此把 **「文件系统是唯一安全真源」升为第一原则**（git 只是它的一种存储视图），
> 而不是"因为 gitignore 所以要全扫"。`hash-object --no-filters` 是该原则下的具体手段。

---

## 4. 我明确不同意的一点

### 4.1 "非 git 工作区 → 退化为逐文件 journal" 是**静默降级**，不接受

这会造成**两套 canonical 模型**（git 原子 / journal 尽力），而
**审计上最糟的恰恰是"同一系统里有两套信任语义"**——操作者与攻击者都可能不知道当前适用哪套。

> 按本项目「不静默降级」原则，应是二选一：
> **(a) canonical 工作区必须是 git 仓，否则 fail-closed 拒绝；或 (b) 统一走 journal，不用 git 原子性。**
> **混合是三种里最差的。**

---

## 5. 关于 G/F 选择：我主张"硬 G"

第二轮把 G/F 留作待裁；我不留：

> **主张 G，且是"硬 G"**：canonical truth = `refs/afr/canonical`，worktree 是派生的 materialization；
> 非 git 工作区**拒绝**，不退化为 journal。

理由不止原子性：
- **G 顺带把并发解干净**——`update-ref <ref> <new> <old>` 天然是 CAS barrier，
  stale baseline 变成**显式 rebase** 而不是覆盖；
- **F 会把这套复杂度永久留在系统里**；G 的迁移（`fixture_dir` 语义、`PRESERVE.md` 资产 1、P7 对齐）
  虽然波及面大，但是**一次性的**。
- 命名上也自洽：P7 已在用 `refs/af-restore/*`。

---

## 6. 结论与待确认

一句话：第二轮把「扫描器」和「acceptance 边界」两个**正确性**问题修对了；我补的是
**「谁管住 planner 的 required」「snapshot 凭什么不可变」「非 git 不能弱化」**
**「baseline 泄密面」「增量判权 / 累积提升」「LFS 属同一类 → 第一原则」**，
其中"非 git 弱化"我明确反对。

**待你确认后写回 v3 的条目**：

| # | 内容 | 落点 |
|---|---|---|
| 1 | policy 界定 `required` 上界 | §5.1 |
| 2 | Snapshot = 内容寻址（blob 哈希 + 存储），非物理冻结 | §3 / §6 |
| 3 | invariant 改述为 "no path to canonical state" | §0 / §12.1 |
| 4 | **baseline 物化的密钥排除策略（V1 必做）** | 新增 §12.3 |
| 5 | 增量 delta 判权 / 累积 manifest 提升 | §8.2 |
| 6 | 「文件系统是唯一安全真源」升为第一原则（含 LFS/filter 实例） | §7.1 |
| 7 | 非 git 工作区：**硬拒绝**，不退化为 journal | §10.1 |
| 8 | §10.1 的 G/F 从"待裁"改为**建议硬 G** | §10.1 |
