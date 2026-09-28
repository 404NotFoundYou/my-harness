# P3：版本化工程题集

## 现状与冲突

`project` 当前固定为一个开发集 BUGFIX；`auditExperiment` 和 v4 `validateExperimentProtocol` 用当下的任务清单重建历史计划、任务/判定摘要。因此直接向 `projectTasks` 追加会使已有同套件历史协议不可复核。

## 设计

保留 `core`/`project` 任务、计划、审计和预算语义不变；增加显式 `--suite project-v2`。新目录 `project-tasks-v2.mjs` 复用原题并追加一题配置层叠（development）与一题半开区间窗口（holdout），每题有两个可写模块、固定只读调用方与公共测试、12项隐藏判定和可验证的参考解。`task-contract` 按suite选择冻结目录，`audit`/`audit-trial` 按v4 suite识别工程题。协议schemaVersion仍4，但suite值使新旧审计完全分流；不兼容的旧`project`扩题方案不实施，未来可在有真实数据与独立审查后评估旧目录清理。

新增suite从2次配对会话增为6次，只有显式选择才改变拟调用数；默认core仍9次reference、6次paired，真实模型调用与费用不在本项范围。先本地模拟验证计划、参考解、部分修复失败、历史审计、范围及候选文件审计，再进行独立审查。无数据库/Schema/生产数据影响。
