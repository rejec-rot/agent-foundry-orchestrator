# af-exec 权限域分离：root-only 部署模板（方案 A）

来源决策：`docs/PRIVILEGE-SEPARATION.md`（§5 方案 A / §8）与 `docs/design/ADR-AF-EXEC-ISOLATION.md`。
**本目录只提供模板、探测与握手代码，不安装、不启用、不提权。** 所有 root 专属步骤由**管理员手动**执行。

## 为什么需要 root

方案 A 要求**控制面 root 所有、执行器以专用 `af-exec` 身份运行**。创建系统用户、改宿主文件属主、
安装 setuid 启动器这三件事**必须有 root**；当前环境（`sudo -n` 不可用）**无法验证**，因此：

- 代理侧**只实现不需要 root 的部分**：能力探测、**能力握手**、**父进程拥有的产物边界**、fail-closed 拒绝、模板与文档；
- 任何"无 root 就降级为以控制面身份运行执行器"的做法**被明确拒绝**（绝不降级）。

## 内容

| 文件 | 作用 |
|---|---|
| `provision.sh` | **root-only** 模板：默认 **dry-run**（只打印计划）；非 root 直接 **exit 3** 且零改动；`--apply` 才执行；幂等；写 **root:0600 的 isolation claim**；安装 **root:0755 启动器**；打印回滚 |
| `af-exec-run.sh` | **特权启动器模板**：唯一做身份下降的地方；非 root 拒绝（exit 3）、目标 uid=0 拒绝（exit 4）；以 `setpriv --reuid/--regid --clear-groups` 执行 |
| `../../lib/af-exec-isolation.mjs` | 能力探测 + fail-closed 闸门（`probeAfExecIsolation` / `assertAfExecIsolation`） |
| `../../lib/af-exec-handshake.mjs` | **运行时握手复验**（H1–H7）+ `buildExecutorDispatch()`（握手不过即拒绝，绝不降级）+ `assertParentOwnedArtifact()`（父进程拥有的产物边界） |

## 管理员操作顺序

```sh
# 1) 先看计划（不改任何东西）
sudo sh deploy/af-exec/provision.sh

# 2) 确认无误后执行
sudo sh deploy/af-exec/provision.sh --apply --workspace /srv/af-workspace

# 3) 复跑能力探测与握手，把结果记录下来（这是启用执行器的前置）
node -e "import('./lib/af-exec-isolation.mjs').then(m=>console.log(JSON.stringify(m.probeAfExecIsolation(),null,2)))"
```

**只有探测返回 `capable: true` 且 `verifyIsolationClaim()` 全部 H1–H7 通过，才可启用**；否则
`assertAfExecIsolation()` / `buildExecutorDispatch()` 会**拒绝**，且**不得**以任何形式降级。

## 机制说明（握手 + 父进程拥有的边界）

1. **握手**：`provision.sh --apply` 写一份 **root:0600** 的 claim（`/etc/af-exec/claim.json`），记录执行器身份、
   工作区、启动器与控制面表面。运行时 `verifyIsolationClaim()` 逐条**对照活文件系统**复验：
   schema / 身份确有分离 / 用户解析一致 / claim 自身受保护 / 工作区归执行器 / 控制面 root 且组与他人不可写 / 启动器 root:0755。
   **任一未知即拒绝**（未知绝不当作通过）。
2. **父进程拥有的产物**：执行器**只能**在自己的工作区内产出；产物是"候选"，由 `assertParentOwnedArtifact()`
   做**路径感知包含**校验（拒相对路径/NUL/前缀陷阱）并**禁止落在控制面表面内**；随后**由父进程自己**写任务状态、
   锁与运行时证据——执行器**从不直接**写控制面状态，这就是"父进程拥有的 IPC 边界"。

## 未验证项（必须如实记录，不得当成已完成）

- 本机**无** `af-exec` 账户、无 claim、无启动器 → `A2`=false，握手 `H3/H4/H5/H7` 无法通过；
- 控制面属主/模式**未变更**（代理不提权）→ `A3`/`H6` 视检出而定；
- "以另一 UID 派发"**未实测**（未安装启动器）→ `A4`=unknown；
- 因此**方案 A 在本机不可验证**，必须在有 root 的部署环境执行并回报探测+握手结果。

## 回滚

见 `provision.sh` 末尾打印的回滚块：删除 claim 与启动器 → （必要时）`userdel -r` → 恢复控制面属主 → 清理工作区。
**回滚前先确认没有正在运行的执行器**，并保留证据目录。

## 启用派发（默认关闭）

派发接线由环境变量控制，**默认 `off`（行为完全不变）**：

```sh
AF_EXEC_ISOLATION=off       # 默认：argv 原样，不做握手（既有行为）
AF_EXEC_ISOLATION=require   # 要求隔离：先握手，通过则经 af-exec-run 以 af-exec 身份运行；不可验证即【拒绝】
```

`require` 下若 claim 缺失/不可读/身份未分离/控制面未受保护/启动器非 root:0755，执行器**不会被启动**，
该次运行以 `EXECUTOR_ISOLATION_REQUIRED` 失败——**没有降级路径**。切换前请先用探测与握手确认环境已就绪。
