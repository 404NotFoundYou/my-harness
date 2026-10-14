# 2026-10-14 project-v2 六会话真实配对试验

六个计划内独立 Codex CLI 会话均已结束并留存完整结果，新增真实模型会话6个、无重试或追加轮次。两组功能均3/3通过，每个候选12/12隐藏验收通过，共72/72。直接实现组共同及完整交付3/3；Harness组共同及完整交付0/3，三个会话均在180秒预算到期终止，三个BUGFIX工作项保留IMPLEMENTING及未登记阶段。

已确认的共同收尾阻断：三个Harness会话都曾调用finish，并收到COMMAND_EVIDENCE_INVALID。复现阶段引用的是执行成功的单独公共测试，但该命令不在任务的计划检查列表中；计划仅声明公共与新增测试组合。完成验证和阶段引用均必须匹配计划，所以该诊断命令不能充当完成证据。原始修复前失败、修复后成功及拒绝日志全部保留，不把功能通过写成流程完成。

## 冻结输入

- 用户2026-10-14明确授权本次六个新增独立模型会话及费用；每会话180000ms、80工具调用、medium推理档，不补跑失败样本。
- 同模型gpt-6-astra；Codex CLI0.156.0，Node22.20.0；入口SHA及Node版本与上轮一致。使用现有自定义responses提供方，模型列表只读检查HTTP200且模型存在，未改凭据或模型配置。
- 来源提交55799b280fc5f7079e28a8af90e2101b80b8ba55，源码摘要9d93c4763757e8a01f18f33bb53bd8a67ead48406d1ff83af3a13f747ea3f053。该提交两条CI在运行前均已核验success。
- suite=project-v2，paired，repetitions=1；固定三题、公开输入、只读调用方、可写文件清单、隐藏判定和顺序轮换。weak-*仅为框架组名，不代表此模型被证实属于弱模型。
- archive-pagination与config-layers为开发题；window-intervals为holdout。它们是合成工程BUG夹具，不是生产事故样本。本轮没有利用留出结果修改提示、预算、规格或实现策略。
- 产品源码未修改；两轮历史实验161文件SHA全部保持一致；只写本工作项。

## 实际结果

耗时单位秒；Harness三项均是被预算截断的观测时长，不能作为实际完成时长。

| 题目 | 数据划分 | 直接实现功能 / 交付 | 直接实现耗时 | Harness功能 / 交付 | Harness观测耗时 |
| --- | --- | --- | ---: | --- | ---: |
| archive-pagination | development | 12/12；通过 | 103.310 | 12/12；超时、未完整交付 | 180.394（截断） |
| config-layers | development | 12/12；通过 | 110.866 | 12/12；超时、未完整交付 | 180.401（截断） |
| window-intervals | holdout | 12/12；通过 | 113.378 | 12/12；超时、未完整交付 | 180.416（截断） |

全部候选修改范围合法，无隐藏用例失败或误称完成。Harness三个会话没有完成协议事件，完整交付和流程门禁均未通过；归档BUGFIX均在IMPLEMENTING，static/sandbox/reproduction/regression完成记录均未登记。原始日志中已有实际复现和回归命令，阶段记录缺失不表示所有测试均未执行。

## finish 拒绝与证据引用

三次正式finish尝试都出现在到期之前。复现引用为node --test test/public.test.mjs，状态pass、exitCode0，checkIds为空。各任务计划T1仅有node --test test/public.test.mjs test/extra.test.mjs，最终普通验证及regression引用的组合命令均成功、匹配V1。原始复现失败命令只作为失败历史保留，未被本报告写成通过。

| 题目 | finish开始时间（秒） | 复现引用ID | 命令状态 / 退出码 | 匹配计划检查数 | 拒绝码 |
| --- | ---: | --- | --- | ---: | --- |
| archive-pagination | 167.434 | 5b21b37e-3e9a-4e2c-a22b-2d4f2aa73367 | pass / 0 | 0 | COMMAND_EVIDENCE_INVALID |
| config-layers | 157.297 | 0b12c224-ea31-476c-9139-24dd752ed682 | pass / 0 | 0 | COMMAND_EVIDENCE_INVALID |
| window-intervals | 162.781 | 24ad50fe-45ed-40b8-8533-69ccc7dfe6c9 | pass / 0 | 0 | COMMAND_EVIDENCE_INVALID |

代码依据：当前verification.mjs的assertCommandEvidence要求引用命令同时满足成功、当前计划/代码/修订及matchingChecks(...)非空；compact.mjs对普通命令和stage-command引用都进行此校验。已观察到的阻断是复现引用不匹配计划，规则没有把诊断成功等同于计划验证通过。拒绝后的恢复耗时、模型/网络耗时尚未独立量化，不将三次超时全部归因为某一种外部延迟。

## 生命周期与用量

直接实现组均收到完成事件，完成事件至exit为0.255–0.739秒，exit至close为0–1毫秒。Harness完成事件时间为null；进程exit/close在预算中断后被观测到，exit至close为0–17毫秒。这些被终止会话的退出间隔不能当作自然完成阶段时长，缺失锚点没有补造为0。

直接实现组CLI上报输入token 370037、输出token 8073；Harness三项均无完整用量，输入和输出累计保持未知，未计为0。实际货币费用未核验。

## 验收与限制

- 真实模式审计valid=true，配对报告ok=true、三对齐全、截断配对3。失败与超时均保留在六项分母中。
- V1：node --test verify.test.mjs，1/1通过、零失败零跳过；证据966fe70a-7b21-413e-8e7e-fc4eb46af832。核对六会话冻结参数、候选与原始协议、归档流程与阶段/命令、报告和生命周期一致性及161历史文件不变。
- V2：node --check verify.test.mjs通过；证据5fa865ca-39b9-4c27-9879-7293a2a23bd0。
- 当前数据验收通过不意味着三个参试BUGFIX已经完成；工作项终态区分实验结果交付与参试任务交付。内部审计不是外部可信执行证明，未重新执行隐藏判定或源码全套测试。
- 本轮中风险单AI自查，未进行新的独立复核；样本仅三题各一次，不能证明一般性能、模型能力排序或对生产项目的效果。

产物：[完整配对报告](comparison.md)、[阶段与计时明细](workflow-diagnostics.json)、[收尾拒绝和引用证据](completion-errors.json)、[一致性审计](audit.json)、[冻结基线](experiment-baseline.json)、[宿主执行记录](invocation.json)。

下一步优先基于两个开发题归档做无模型的BUGFIX收尾诊断与提示改进：明确阶段命令也须属于计划，列出可用的成功检查引用，保持当前门禁和预算。此建议由开发题已出现的共同问题支持；holdout只保留为评估结果。本轮未实施提示或Runtime行为修改，未追加模型调用。
