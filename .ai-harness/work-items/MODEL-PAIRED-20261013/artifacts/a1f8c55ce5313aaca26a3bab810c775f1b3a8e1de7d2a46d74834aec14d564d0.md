# 实验收益对照报告

模式：real；题集：core；客户端：codex；样本：6；配对：3。
冻结源码：1f4a315ae615f170cf4c025d649301cba22802c63ddc6e324b70c8736afbfb7f
模型：gpt-6-astra
差值方向：Harness − baseline；确认截断的配对：2；截断状态未知的配对：0。

| 口径 | 仅baseline通过 | 仅Harness通过 | 都通过 | 都失败 |
| --- | ---: | ---: | ---: | ---: |
| 功能通过 | 0 | 0 | 3 | 0 |
| 共同交付 | 1 | 1 | 1 | 0 |
| 完整交付 | 1 | 1 | 1 | 0 |

| 度量 | 有效配对 | 未知配对 | 每对差值的中位数 |
| --- | ---: | ---: | ---: |
| 观测区间差(ms) | 3 | 0 | -36009 |
| 工具次数差 | 3 | 0 | 2 |
| 输入Token差 | 1 | 2 | 29448 |
| 输出Token差 | 1 | 2 | -264 |

## 逐题配对

| 题目 / 轮次 | 组别与证据 | 功能 / 共同 / 完整 | 观测ms / 差值 | 工具次数 / 差值 | 输入 / 输出Token或差值 | 失败类型 |
| --- | --- | --- | ---: | ---: | --- | --- |
| csv / 1 | [baseline](<./csv-weak-baseline/result.json>) | 通过 / 失败 / 失败 | 180285（截断） | 4 | 未知 / 未知 | timeout, execution-failed, run-incomplete |
| csv / 1 | [harness](<./csv-weak-harness/result.json>) | 通过 / 通过 / 通过 | 135284 | 6 | 161853 / 2746 | 无 |
| csv / 1 | 差值(Harness−baseline) | - | -45001 | 2 | 未知 / 未知 | - |
| allocation / 1 | [baseline](<./allocation-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 174721 | 6 | 131661 / 3193 | 无 |
| allocation / 1 | [harness](<./allocation-weak-harness/result.json>) | 通过 / 通过 / 通过 | 138712 | 6 | 161109 / 2929 | 无 |
| allocation / 1 | 差值(Harness−baseline) | - | -36009 | 0 | 29448 / -264 | - |
| events / 1 | [baseline](<./events-weak-baseline/result.json>) | 通过 / 通过 / 通过 | 163591 | 5 | 114678 / 3664 | 无 |
| events / 1 | [harness](<./events-weak-harness/result.json>) | 通过 / 失败 / 失败 | 180395（截断） | 7 | 未知 / 未知 | timeout, execution-failed, run-incomplete |
| events / 1 | 差值(Harness−baseline) | - | 16804 | 2 | 未知 / 未知 | - |

## 工具阶段

| 组别 / 类别 | 次数 | 活跃ms | 有计时 / 未知样本 |
| --- | ---: | ---: | --- |
| baseline / unknown | 15 | 4055 | 3 / 0 |
| harness / unknown | 6 | 1023 | 3 / 0 |
| harness / planning | 3 | 2248 | 3 / 0 |
| harness / guidance | 1 | 370 | 3 / 0 |
| harness / verification | 6 | 4686 | 3 / 0 |
| harness / completion | 3 | 10209 | 3 / 0 |

## 解释边界

- 仅描述本次冻结实验；同题重复不是独立任务，不能据此证明通用能力或因果收益。
- 共同交付条件对两组相同；完整交付另含Harness流程门禁。strong-reference不计入配对分母。
- 耗时是观测区间；超时/工具预算截断不表示更快完成。缺失度量为未知，Token不换算货币费用。
- 失败类型可重叠，仅反映记录中的条件，不等于模型或网络根因。
- 工具类别区间可重叠，不相加为总耗时；其余耗时包含网络、启动和收尾，不等于纯推理耗时。
- 审计核验记录内部一致性；本报告不启动模型、不验证当前客户端或返回后的文件状态。

