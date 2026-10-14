# 实验收益对照报告

模式：real；题集：project-v2；客户端：codex；样本：6；配对：3。
冻结源码：b7bcb820cf7a84c0a914c48304629b610b3d3059d5dfebba48c2dd0da5e07719
模型：gpt-6-astra
差值方向：Harness − baseline；确认截断的配对：3；截断状态未知的配对：0。

| 口径 | 仅baseline通过 | 仅Harness通过 | 都通过 | 都失败 |
| --- | ---: | ---: | ---: | ---: |
| 功能通过 | 1 | 0 | 2 | 0 |
| 共同交付 | 2 | 0 | 0 | 1 |
| 完整交付 | 2 | 0 | 0 | 1 |

| 度量 | 有效配对 | 未知配对 | 每对差值的中位数 |
| --- | ---: | ---: | ---: |
| 观测区间差(ms) | 3 | 0 | 17965 |
| 工具次数差 | 3 | 0 | 1 |
| 输入Token差 | 0 | 3 | 未知 |
| 输出Token差 | 0 | 3 | 未知 |

## 逐题配对

| 题目 / 轮次 | 组别与证据 | 功能 / 共同 / 完整 | 观测ms / 差值 | 工具次数 / 差值 | 输入 / 输出Token或差值 | 失败类型 |
| --- | --- | --- | ---: | ---: | --- | --- |
| archive-pagination / 1 | [baseline](<./archive-pagination-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 162405 | 5 | 123074 / 2829 | 无 |
| archive-pagination / 1 | [harness](<./archive-pagination-weak-harness/result.json>) | 通过 / 失败 / 失败 | 180370（截断） | 8 | 未知 / 未知 | timeout, execution-failed, run-incomplete, workflow-incomplete |
| archive-pagination / 1 | 差值(Harness−baseline) | - | 17965 | 3 | 未知 / 未知 | - |
| config-layers / 1 | [baseline](<./config-layers-weak-baseline/result.json>) | 通过 / 失败 / 失败 | 180295（截断） | 6 | 未知 / 未知 | timeout, execution-failed, run-incomplete |
| config-layers / 1 | [harness](<./config-layers-weak-harness/result.json>) | 失败 / 失败 / 失败 | 180366（截断） | 6 | 未知 / 未知 | functional-failed, timeout, execution-failed, run-incomplete, workflow-incomplete |
| config-layers / 1 | 差值(Harness−baseline) | - | 71 | 0 | 未知 / 未知 | - |
| window-intervals / 1 | [baseline](<./window-intervals-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 161574 | 5 | 125982 / 2922 | 无 |
| window-intervals / 1 | [harness](<./window-intervals-weak-harness/result.json>) | 通过 / 失败 / 失败 | 180357（截断） | 6 | 未知 / 未知 | timeout, execution-failed, run-incomplete, workflow-incomplete |
| window-intervals / 1 | 差值(Harness−baseline) | - | 18783 | 1 | 未知 / 未知 | - |

## 工具阶段

| 组别 / 类别 | 次数 | 活跃ms | 有计时 / 未知样本 |
| --- | ---: | ---: | --- |
| baseline / unknown | 16 | 4783 | 3 / 0 |
| harness / runtime-other | 3 | 801 | 3 / 0 |
| harness / planning | 6 | 2575 | 3 / 0 |
| harness / verification | 7 | 12018 | 3 / 0 |
| harness / completion | 1 | 306 | 3 / 0 |
| harness / guidance | 2 | 1251 | 3 / 0 |
| harness / unknown | 1 | 223 | 3 / 0 |

## 会话结束时间点

本地接收时间，单位ms；终态事件收到不等于完整交付。

| 题目 / 轮次 / 组别 | 首个协议事件 | 完成协议事件 | 进程exit | 进程close |
| --- | ---: | --- | ---: | ---: |
| archive-pagination / 1 / baseline | 1116 | 162135（已收到） | 162405 | 162405 |
| archive-pagination / 1 / harness | 1186 | 未知（未收到） | 180370 | 180370 |
| config-layers / 1 / baseline | 1102 | 未知（未收到） | 180295 | 180295 |
| config-layers / 1 / harness | 1114 | 未知（未收到） | 180366 | 180366 |
| window-intervals / 1 / baseline | 1123 | 161309（已收到） | 161574 | 161574 |
| window-intervals / 1 / harness | 1096 | 未知（未收到） | 180347 | 180357 |

| 题目 / 轮次 / 组别 | 最后已结束工具 | 工具后观测间隔 | 完成事件至exit | exit至close |
| --- | ---: | ---: | ---: | ---: |
| archive-pagination / 1 / baseline | 139643 | 22762 | 270 | 0 |
| archive-pagination / 1 / harness | 179368 | 1002 | 未知 | 0 |
| config-layers / 1 / baseline | 162669 | 17626 | 未知 | 0 |
| config-layers / 1 / harness | 156334 | 24032 | 未知 | 0 |
| window-intervals / 1 / baseline | 137262 | 24312 | 265 | 0 |
| window-intervals / 1 / harness | 177073 | 3284 | 未知 | 10 |

未记录的时间点保持未知；事件接收顺序反转时不计算该间隔。旧样本的工具后间隔可由已有spans恢复，不能解释为纯模型或网络耗时。

## 解释边界

- 仅描述本次冻结实验；同题重复不是独立任务，不能据此证明通用能力或因果收益。
- 共同交付条件对两组相同；完整交付另含Harness流程门禁。strong-reference不计入配对分母。
- 耗时是观测区间；超时/工具预算截断不表示更快完成。缺失度量为未知，Token不换算货币费用。
- 失败类型可重叠，仅反映记录中的条件，不等于模型或网络根因。
- 工具类别区间可重叠，不相加为总耗时；其余耗时包含网络、启动和收尾，不等于纯推理耗时。
- 审计核验记录内部一致性；本报告不启动模型、不验证当前客户端或返回后的文件状态。
