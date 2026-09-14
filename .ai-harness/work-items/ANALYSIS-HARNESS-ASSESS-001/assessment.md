# AI Harness 当前实现评估

- 基线：main / a40af12c7f7a7d03bee37173f4bfcd83a24a6da0，2026-09-14，本轮开始时工作树干净。
- 范围：当前产品源码、策略、Schema、使用文档和测试；不修改产品代码。
- 复现：probes.mjs 在独立临时 Git 仓库中执行 7 个场景，并做 1 个纯命令分类对照；原始结果见 probe-results.json。临时仓库已清理。
- 未验证：真实弱/强模型效果对照、生产环境、其他操作系统。本轮未重复运行既有全量测试。
- 下文的 CI 指 Runtime 的 check --ci 门禁，不代表远端 CI 流水线或业务项目的全部测试已经运行。反例中的审查/验收文字是有意构造的测试输入，用来检查门禁能否独立识别不成立的完成声明。

## 判断

当前实现可以帮助保存目标、维护任务和导航流程，但验证可信度、变更归属和失败恢复仍有实质缺口。它还不能作为可靠的自动验收依据，也没有证据证明能让较弱模型达到较强模型的任务完成率。

此前 99 项测试通过证明的是已有测试覆盖的行为；本次反例说明负面路径覆盖不足。下面的 P1 问题应优先于继续增加引导字段或流程规则。

## P1：验证证据未绑定待验收代码与实际验证计划

已复现：

1. 语法检查通过后，把同一个文件改为语法错误；当前代码再次检查退出 1，但引用旧命令的 finish 仍将工作项置为 DONE，check --ci 返回通过。
2. 计划声明 node --test case.test.mjs，验收测试实际失败；只在 Runtime 内运行 node --version，就能用该命令完成 finish 并通过 CI。
3. 在 VERIFYING 记录 pass 后，又执行一条真实失败的命令；guide 仍建议进入 CODE_REVIEW，原状态门禁允许进入，后续填入审查与验收结论后 CI 仍通过。

来源：.ai-harness/src/evidence.mjs:75 记录输出哈希但不记录验证时的代码指纹；compact.mjs:109-119 只核对命令与任务启动时间，没有校验测试计划或随后代码变化；guide.mjs:137-147 在 verification 已 pass 时忽略新失败；validator 的 CODE_REVIEW 门禁与 checker 也未使旧 pass 失效。

建议：把可执行验证计划保存为结构化命令，关联验收目标；每次验证记录相关代码/测试/配置的内容指纹。代码变化或新失败使后续验证、审查及验收失效。不能仅靠模型自填 pass 来闭环。

## P1：写入范围检查同时存在漏报与误报

已复现：

- 删除未在任务范围内的已跟踪 unrelated.txt，Git 显示 D，但 checker 的 changedFiles 不包含它，CI 仍通过。git.mjs:34-35、72、79-80 使用的 diff-filter 缺少 D。
- 旧任务已完成并提交；新任务只允许 new.mjs，却修改了旧任务曾允许的 old.mjs。旧范围仍存在于 allowedScopes，CI 通过。checker.mjs:179-204 合并所有工作项范围，:340-341 又包含 DONE 历史任务。
- 本次仅创建 ANALYSIS 工作项时，check 已把其合法 state.json/events.jsonl 判为越界。分析没有开发计划，而 plannedScopes 在无计划时返回空，控制面记录没有得到适用豁免。

建议：包含删除、重命名等全部需要审查的变更；区分当前交付与历史范围，把已完成任务的内容边界固定下来；合法控制面路径按已校验工作项单独处理。不能通过放开整个仓库范围解决。

## P1：最终审查失败后缺少可用的返工与重新计划路径

已复现：CODE_REVIEW 记录 fail 后，返回 IMPLEMENTING 得到 INVALID_TRANSITION，运行验证得到 WRONG_STAGE，补任务得到 PLAN_LOCKED；guide 仍推荐 record-review。

来源：constants.mjs:71-105 的工作项状态只向前推进；workflow.mjs:254/263 锁住批准计划；evidence.mjs:40 限制运行阶段。任务级 REWORK 不能解决已经离开 IMPLEMENTING 的工作项返工。

建议：增加显式、可审计的 reopen/replan 路径，保存原计划版本和授权来源，同时作废受影响的完成证据。失败后应回到修改、重测、复核，不应只能再次填写审查结论。

## P1：命令分类的版本参数快捷规则过宽

纯分类对照已确认：node 的 --eval 默认得到 ask，但增加一个位置参数 version 后变成 allow。未执行此内联代码。

来源：policy.mjs:100 在检查 --eval 等选项前，发现任意 --version/-v/version 参数就直接返回 true。

建议：按真实参数结构判断命令，先执行限制规则，版本查询仅接受明确的查询形态。shell:false 不能替代对子进程解释器参数的判断。

## P2：本机 Windows 下常见包管理器命令无法通过 Runtime 执行

PowerShell 中 npm --version 正常返回 10.9.3。临时项目中，Runtime 将 npm 与 npm.cmd 的版本查询都判为 allow，但执行分别返回 spawnSync npm ENOENT 与 spawnSync npm.cmd EINVAL。

来源：evidence.mjs:61-68 对所有程序统一使用 spawnSync(command, args, shell:false)。现有 Node 测试不能证明 Windows 的 .cmd 包管理器启动兼容性。

建议：增加明确的 Windows 启动适配或直接调用已定位的包管理器 Node 入口，继续保留参数边界；补上真实 npm/pnpm 项目的验证用例，不笼统放开嵌套 shell。

## P2：弱模型增强的关键判断仍主要留给模型

guide.mjs:190 的 resources 主要给出输入与文件路径；它不提取具体实现、调用方、接口约束或相关测试。begin 又要求先提交方案、写入范围、数据库判断与验证方式，模型在获取引导前就要完成一部分较难的工作。

这是产品能力缺口，不是“引导完全无用”的结论。流程导航可以减少状态错误，但不能据此推断代码理解、拆解和修复能力已提升。

建议：在可信验证基础上增加按目标提取的代码上下文和结构化验收样例；让模型围绕少量明确证据做判断。避免继续扩大根提示词和通用检查清单。

## P2：验证成本尚未真正按风险分级

bugfix.md:24 对所有 BUGFIX 都要求 static/sandbox/reproduction/regression，frontend 还需 browser。阶段选择主要按类型和 flag，low 风险并不减轻流水线；verification.md:9 又把实际执行交给外部工具，Runtime 本身没有提供这些执行器。

建议：以实际影响和已有可靠测试决定验证强度，明确哪些证据能由本地工具直接生成，哪些确需外部隔离、浏览器或独立评估。为阶段供给可运行的工具与真实输出，减少只填写文字声明的空间。

## P2：尚无模型效果基线

model-guidance.md:58-68 明确尚未做外部模型对照。本次也没有调用模型服务。不能用 Runtime 的测试数量、规则变少或命令变少，替代模型完成率和总成本的测量。

建议：固定代码基线、任务集、工具权限和预算，对比弱模型原流程、同一弱模型加 Harness、强模型参考三组。优先统计独立验收通过率、回归失败、误称完成、人工纠正和总 token/时间成本，并保留失败样例。

## 建议实施顺序

1. 修复验证/范围误判、命令分类及返工路径，并把本次反例转成必须阻止错误完成的回归测试。
2. 补齐 Windows 常见项目的实际命令执行及验证器适配。
3. 建立模型效果对照，再依据失败样例补代码上下文、验收样例和局部修复引导。

## 本轮命令与状态说明

- node .ai-harness/bin/harness.mjs doctor --json：退出 0。
- node .ai-harness/work-items/ANALYSIS-HARNESS-ASSESS-001/probes.mjs：退出 0；表示诊断场景执行完毕，不表示产品行为正确。ANALYSIS 不支持 harness run，本轮只在临时夹具中通过客户端执行探针。
- npm --version：本机 PowerShell 退出 0，版本 10.9.3。
- git diff --exit-code：退出 0，未修改已跟踪产品文件。
- check / check --ci：合法的新增分析控制面记录被误判越界，门禁失败；该问题本身已列入范围检查缺陷，不能宣称本轮 CI 通过。

本目录仅保留分析记录、复现脚本及结果；未修复上述问题，未提交或推送。
