# af-exec 权限域分离：root-only 部署模板（方案 A）

来源决策：`docs/PRIVILEGE-SEPARATION.md`（§5 方案 A / §8）与 `docs/design/ADR-AF-EXEC-ISOLATION.md`。
**本目录只提供模板与探测，不安装、不启用、不提权。** 所有 root 专属步骤由**管理员手动**执行。

## 为什么需要 root

方案 A 要求**控制面 root 所有、执行器以专用 `af-exec` 身份运行**。创建系统用户、改宿主文件属主
这两件事**必须有 root**；当前环境（`sudo -n` 不可用）**无法验证**，因此：

- 代理侧**只实现不需要 root 的部分**：能力探测、fail-closed 拒绝、模板与文档；
- 任何"无 root 就降级为以控制面身份运行执行器"的做法**被明确拒绝**（绝不降级无沙箱/无隔离）。

## 内容

| 文件 | 作用 |
|---|---|
| `provision.sh` | **root-only** 部署模板：默认 **dry-run**（只打印计划）；非 root 直接 **exit 3** 且不改任何东西；`--apply` 才执行；幂等；末尾打印回滚 |
| `../../lib/af-exec-isolation.mjs` | 能力探测 + fail-closed 闸门（`probeAfExecIsolation` / `assertAfExecIsolation`） |

## 管理员操作顺序

```sh
# 1) 先看计划（不改任何东西）
sudo sh deploy/af-exec/provision.sh

# 2) 确认无误后执行
sudo sh deploy/af-exec/provision.sh --apply --workspace /srv/af-workspace

# 3) 复跑能力探测，把结果**记录下来**（这是启用执行器的前置）
node -e "import('./lib/af-exec-isolation.mjs').then(m=>console.log(JSON.stringify(m.probeAfExecIsolation(),null,2)))"
```

**只有探测返回 `capable: true` 才可启用**；否则 `assertAfExecIsolation()` 会拒绝，且**不得**以任何形式降级。

## 未验证项（必须如实记录，不得当成已完成）

- 本机**没有** `af-exec` 用户，也无法创建 → `A2` 探测项为 false；
- 控制面所有权/模式**未变更**（代理不提权）→ `A3` 视当前检出而定；
- "以另一 UID 派发"的能力（setuid/su 路径）**未探测** → `A4` 为 unknown；
- 因此**方案 A 在本机不可验证**，必须在有 root 的部署环境执行并回报探测结果。

## 回滚

见 `provision.sh` 末尾打印的回滚块（`userdel -r`、恢复属主、必要时清理工作区）。
**回滚前先确认没有正在运行的执行器**，并保留证据目录。
