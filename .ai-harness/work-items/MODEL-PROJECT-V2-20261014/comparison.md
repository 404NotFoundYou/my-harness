# 实验收益对照报告

模式：real；题集：project-v2；客户端：codex；样本：6；配对：3。
冻结源码：9d93c4763757e8a01f18f33bb53bd8a67ead48406d1ff83af3a13f747ea3f053
模型：gpt-6-astra
差值方向：Harness − baseline；确认截断的配对：3；截断状态未知的配对：0。

| 口径 | 仅baseline通过 | 仅Harness通过 | 都通过 | 都失败 |
| --- | ---: | ---: | ---: | ---: |
| 功能通过 | 0 | 0 | 3 | 0 |
| 共同交付 | 3 | 0 | 0 | 0 |
| 完整交付 | 3 | 0 | 0 | 0 |

| 度量 | 有效配对 | 未知配对 | 每对差值的中位数 |
| --- | ---: | ---: | ---: |
| 观测区间差(ms) | 3 | 0 | 69535 |
| 工具次数差 | 3 | 0 | 6 |
| 输入Token差 | 0 | 3 | 未知 |
| 输出Token差 | 0 | 3 | 未知 |

## 逐题配对

| 题目 / 轮次 | 组别与证据 | 功能 / 共同 / 完整 | 观测ms / 差值 | 工具次数 / 差值 | 输入 / 输出Token或差值 | 失败类型 |
| --- | --- | --- | ---: | ---: | --- | --- |
| archive-pagination / 1 | [baseline](<./archive-pagination-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 103310 | 5 | 123553 / 2484 | 无 |
| archive-pagination / 1 | [harness](<./archive-pagination-weak-harness/result.json>) | 通过 / 失败 / 失败 | 180394（截断） | 8 | 未知 / 未知 | timeout, execution-failed, run-incomplete, workflow-incomplete |
| archive-pagination / 1 | 差值(Harness−baseline) | - | 77084 | 3 | 未知 / 未知 | - |
| config-layers / 1 | [baseline](<./config-layers-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 110866 | 5 | 122901 / 2798 | 无 |
| config-layers / 1 | [harness](<./config-layers-weak-harness/result.json>) | 通过 / 失败 / 失败 | 180401（截断） | 11 | 未知 / 未知 | timeout, execution-failed, run-incomplete, workflow-incomplete |
| config-layers / 1 | 差值(Harness−baseline) | - | 69535 | 6 | 未知 / 未知 | - |
| window-intervals / 1 | [baseline](<./window-intervals-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 113378 | 5 | 123583 / 2791 | 无 |
| window-intervals / 1 | [harness](<./window-intervals-weak-harness/result.json>) | 通过 / 失败 / 失败 | 180416（截断） | 11 | 未知 / 未知 | timeout, execution-failed, run-incomplete, workflow-incomplete |
| window-intervals / 1 | 差值(Harness−baseline) | - | 67038 | 6 | 未知 / 未知 | - |

## 工具阶段

| 组别 / 类别 | 次数 | 活跃ms | 有计时 / 未知样本 |
| --- | ---: | ---: | --- |
| baseline / unknown | 15 | 3976 | 3 / 0 |
| harness / runtime-other | 3 | 676 | 3 / 0 |
| harness / planning | 5 | 1975 | 3 / 0 |
| harness / verification | 11 | 17302 | 3 / 0 |
| harness / unknown | 3 | 428 | 3 / 0 |
| harness / guidance | 5 | 2826 | 3 / 0 |
| harness / completion | 3 | 3222 | 3 / 0 |

## 会话结束时间点

本地接收时间，单位ms；终态事件收到不等于完整交付。

| 题目 / 轮次 / 组别 | 首个协议事件 | 完成协议事件 | 进程exit | 进程close |
| --- | ---: | --- | ---: | ---: |
| archive-pagination / 1 / baseline | 1173 | 103050（已收到） | 103310 | 103310 |
| archive-pagination / 1 / harness | 1095 | 未知（未收到） | 180377 | 180394 |
| config-layers / 1 / baseline | 1223 | 110127（已收到） | 110866 | 110866 |
| config-layers / 1 / harness | 1103 | 未知（未收到） | 180401 | 180401 |
| window-intervals / 1 / baseline | 1149 | 113122（已收到） | 113377 | 113378 |
| window-intervals / 1 / harness | 1082 | 未知（未收到） | 180416 | 180416 |

| 题目 / 轮次 / 组别 | 最后已结束工具 | 工具后观测间隔 | 完成事件至exit | exit至close |
| --- | ---: | ---: | ---: | ---: |
| archive-pagination / 1 / baseline | 86426 | 16884 | 260 | 0 |
| archive-pagination / 1 / harness | 168374 | 12020 | 未知 | 17 |
| config-layers / 1 / baseline | 93816 | 17050 | 739 | 0 |
| config-layers / 1 / harness | 166961 | 13440 | 未知 | 0 |
| window-intervals / 1 / baseline | 93764 | 19614 | 255 | 1 |
| window-intervals / 1 / harness | 173675 | 6741 | 未知 | 0 |

未记录的时间点保持未知；事件接收顺序反转时不计算该间隔。旧样本的工具后间隔可由已有spans恢复，不能解释为纯模型或网络耗时。

## 解释边界

- 仅描述本次冻结实验；同题重复不是独立任务，不能据此证明通用能力或因果收益。
- 共同交付条件对两组相同；完整交付另含Harness流程门禁。strong-reference不计入配对分母。
- 耗时是观测区间；超时/工具预算截断不表示更快完成。缺失度量为未知，Token不换算货币费用。
- 失败类型可重叠，仅反映记录中的条件，不等于模型或网络根因。
- 工具类别区间可重叠，不相加为总耗时；其余耗时包含网络、启动和收尾，不等于纯推理耗时。
- 审计核验记录内部一致性；本报告不启动模型、不验证当前客户端或返回后的文件状态。
