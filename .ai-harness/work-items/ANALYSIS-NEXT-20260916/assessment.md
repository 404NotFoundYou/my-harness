# 1.5.0后的下一轮方向

基线main@800ed3e619255fceff7e8ab08b45ee49df0ba962，Runtime1.5.0，初始产品工作区干净，doctor通过。本轮为技术咨询，只读复核当前源码及已完成CI记录。

## 优先建议：实验断点续跑与可靠保存

PROVEN：benchmarks/experiment.mjs:29仍以mkdir(outputDirectory)拒绝已有目录；summary保留notRun，尚无resume入口。循环中只有runCase返回后才把结果加入results；onProgress的started不是持久化的试次状态。benchmarks/runner.mjs:36的saveJson直接writeFile，协议、单项结果和摘要未采用原子替换。

INFERRED：进程中断可能落在模型调用后、result/summary写入前；仅以notRun或缺失result推断“从未执行”会有重复调用和遗漏用量的风险。半写JSON也需要明确诊断。本轮未注入断电或杀进程，不把具体数据损坏描述为已复现事故。

PROPOSAL：下一轮做一个纵向目标：显式resume入口，复用冻结协议，验证源码/题库/判定器/客户端与模型配置/预算不变；启动调用前原子记录started，结果原子落盘，summary从可信试次记录重建。已完成试次包括失败样本都不再调用；确定未启动的试次可继续；started但无可信终态的试次保留为中断/用量未知，不能静默当作未启动重试。每个实验目录保持单写者，重复resume并发应拒绝，避免重复调用。保留v1/v2/v3历史审计，不改旧统计。

验收：用模拟驱动在启动前、调用中、结果后、摘要前等边界中断并续跑；已完成试次调用计数不增加；版本/预算漂移、损坏记录、并发续跑被拒绝；失败与未知用量保留。先证明框架恢复行为，无需真实模型费用。

## 随后验证新增题集的真实收益

PROVEN：新增project题集已经有两个实现文件、精确候选、独立隐藏验收、BUGFIX类型/范围和v3审计；上轮只进行了模拟框架验证，没有新增付费模型对照。不能把模拟通过解释为真实能力收益。

PROPOSAL：续跑可靠后，冻结同一模型和任务，做baseline/Harness两组的小规模对照，观察功能通过率、完整交付率、误称完成、耗时和Token开销。每个条件重复试次可用于观察波动，但同一题重复不能证明跨任务泛化；不要由一题少量样本宣称通用收益。真实调用需用户明确费用和模型授权，本轮不发起。

## 第三方向：缩短CI反馈时间

PROVEN：本轮通过GitHub API重新读取提交800ed3e的source-tests运行，Windows Runtime从2026-09-15T10:05:38Z到10:12:06Z，共388秒，结论success。链接：https://github.com/404NotFoundYou/my-harness/actions/runs/34955978247 。tests/helpers.mjs反复安装临时Runtime并初始化Git；installer.mjs先递归列举再过滤work-items/backups。

UNKNOWN：尚无当前分段profiling，不能将388秒归因于某一函数。PROPOSAL：先测安装、Git初始化、快照和测试执行，再按热点优化。候选包括安装遍历提前排除历史目录、准备只读夹具后独立复制、按实测调整测试并发；只有保持隔离、完整覆盖和证据一致的优化才接受。以同一runner条件重复测量前后耗时，不以删测试或跳过验证获得提速。

优先级以前提“下一轮继续代码优化”为准：续跑与可靠保存优先；若近期不安排批量模型实验、主要日常痛点是等待CI，可将CI profiling提前。默认继续避免增加没有实测收益依据的流程阶段或多AI编排。

本轮未执行新的产品回归或模型实验。分析ANSWERED只表示建议已经证据化，不表示以上功能已实现或已测得收益。
