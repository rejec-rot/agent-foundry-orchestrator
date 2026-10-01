# V2 流程管线原型 B（纯前端 · 模拟数据）

对应设计书：`docs/design/V2-FRONTEND-DESIGN-B-PIPELINE.md`。
**不依赖后端**：全部数据为内置模拟值，仅用于评审视觉与交互方向。

## 运行

```bash
cd /home/reject/DSHWorkSpace/agent-foundry-next/prototypes/pipeline-b
python3 -m http.server 8931 --bind 127.0.0.1
# 打开 http://127.0.0.1:8931/
```

（任意静态服务器均可；无构建步骤，无依赖安装。）

## 可以体验什么

| 操作 | 说明 |
|---|---|
| 点击阶段节点 / Tab + Enter | 打开右侧抽屉：任务定义、manifest 摘要、评审证据、四带门待决项与 CLI 批准提示、验收/提升说明 |
| 点击 worker 行（w1/w2/w3） | 查看分工、最近活动、注入指令三档状态（排队/已接收/已落实） |
| 切到写模式 → 选中「编写」或某 worker | 底部指令条升起，可注入指令（模拟 2s 已接收、5s 已落实） |
| 列表 / 管线切换 | 语义化表格视图，与管线信息逐项等价（可访问性要求） |
| 底部「原型演示控制」 | 模拟实时事件流：批准闸门 → 验收 → 提升 → 评审失败，看图随进程更新（**演示专用，不属于设计**） |
| 切换任务（顶栏 TASK） | 二号任务演示「验收进行中 + 不可核验来源」状态 |

URL 直达参数：`?task=2` `?view=list` `?mode=write` `?node=gate` `?demo=approve,accept`（可组合）。

## 与设计书的对应

- 蓝图风：`#0b1d3a` 底 + 40px 工程网格；Unbounded / JetBrains Mono / 思源黑体；直角节点 + 切角标记。
- 节点形态六态：空心未到达 / 流动描边进行中 / 实心通过 / 红叉失败 / 琥珀等待人工 / 灰线框不可核验。
- 诚实纪律：无百分比进度；`as_of` 时钟；不可核验来源显式计数；页尾密钥声明。
- `prefers-reduced-motion` 下全部动效收敛。
