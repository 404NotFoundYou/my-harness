# 1.4.0后的优化方向

基线main@062ea908bc1ff1a45a29a9851813511e0e07a7c9，Runtime 1.4.0，初始工作树干净，doctor通过。用户本轮询问方向，产品文件只读；不实施或启动真实模型实验。

建议下一轮优先补多文件真实任务评测。此前安装字节、长日志和单项超时已完成，当前三个固定函数题尚不足以说明跨模块工程任务的收益。此顺序以验证日常工程价值为目标；若即将频繁运行较大批量实验，续跑可提前。

| 顺序 | 当前源码事实 | 最小改进与验收 |
| --- | --- | --- |
| 1 多文件真实任务评测 | PROVEN：benchmarks/tasks.mjs只有csv/allocation/events三题；runner.mjs的inspectChanges、participantPrompt、runCase和gradeCandidate围绕单个task.entry，候选只保存candidate.mjs，独立验收只复制一个实现文件 | PROPOSAL：先增加一个2至3文件的BUG修复题，声明明确可写清单，保存全部候选文件，在独立目录恢复完整依赖并验收；禁止修改原规格/测试。旧三题及历史审计保持兼容，之后再做同模型有无Harness配对，观察成功率、误称完成率、耗时和工具/Token消耗。真实效果及费用收益UNKNOWN，需授权实验提供数据 |
| 2 实验断点续跑 | PROVEN：experiment.mjs的runExperiment用mkdir(outputDirectory)拒绝已存在目录；summary保存notRun但没有resume入口，协议保存源码、任务、判定器和预算 | PROPOSAL：复用冻结协议，先校验源码/题目/判定器/客户端模型/预算及结果完整性，再只运行确定未启动试次；已完成失败样本也不重复调用。启动后中断的调用按未知/中断保留，不声称恰好一次或零费用，不自动当作未运行重试；用假驱动证明续跑不重复调用、漂移拒绝、损坏/部分写入可诊断 |
| 3 CI与验证运行开销 | PROVEN：上一轮同会话读取提交062ea90的Windows日志，Runtime160项全部通过，duration_ms=373196.5463；tests/helpers.mjs反复安装临时项目。installationFiles先递归遍历.ai-harness，再过滤work-items/backups | PROPOSAL：先对安装、Git初始化、快照和测试执行计时，按热点优化目录剪枝或只读夹具准备；保持测试隔离和完整覆盖。当前瓶颈UNKNOWN，不直接扩并发或把373秒全归因于安装。必要时再更新Actions版本与Node兼容矩阵，并区分Actions运行时与被测Node版本 |

本轮只读观察：历史work-items目录389个文件、81个目录；安装载荷91文件。当前本地热文件系统3次installationFiles耗时13/9/9毫秒。此数据只证明重复扫描的存在，不支持其为Windows CI主因。

不建议在没有上述效果数据前优先扩展更多流程阶段或多AI编排；先用可重复的工程任务验证现有Runtime的收益，再由失败分布决定下一项产品改进。此为优先级裁量，非已实现能力。

本轮没有重跑产品测试或付费模型。上一轮本地175项及两条远端工作流通过是同会话已核验的历史事实，不作为新实验效果证明。
