# 模型固定任务对照

本项目使用相同公开规格、初始代码、独立验收与预算，对照较弱模型原流程、同模型加 Harness、较强模型参考。实验程序与复跑方式见 [benchmarks](../../benchmarks/README.md)。

本次实验的事实和原始证据集中保存在工作项中：

- [完整结果、差异与限制](../../.ai-harness/work-items/MODEL-BENCHMARK-001/comparison.md)
- [先导轮统计](../../.ai-harness/work-items/MODEL-BENCHMARK-001/pilot/summary.json)
- [辅助改进决定](../../.ai-harness/work-items/MODEL-BENCHMARK-001/intervention-decision.md)
- [复验轮统计](../../.ai-harness/work-items/MODEL-BENCHMARK-001/followup/summary.json)

统计分别报告功能通过、预算内完整完成、超时、误称完成、工具调用和CLI返回的用量。超时且没有返回用量的记录保留为未知，不按零成本统计。模型标识来自现有CLI配置，不能验证自定义服务的实际后端权重；每题每组一次的样本不支持通用能力等价或统计显著性结论。
