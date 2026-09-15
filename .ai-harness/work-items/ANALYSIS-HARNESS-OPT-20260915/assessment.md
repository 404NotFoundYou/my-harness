# AI Harness 1.2.0 后续优化调研

调研日期：2026-09-15（北京时间）。基线：`main@a5c1bee279f2e204724cfb34ad00287bb585b8ef`；产品快照：`d9757a23f48542e1a3990d503a594328637428988ca8b50dbe0020bf0e2ff45c`。本次环境为 Windows、Node.js 22.20.0。

建议下一阶段围绕**评测可信性、异常恢复、交付效率**展开。继续保持仓库内、零依赖、跨客户端的 Runtime 定位，让代码处理状态和证据，让模型承担方案、审查与验收判断。

本次只开展调研，产品文件没有修改。新增内容仅在本 ANALYSIS 工作项内；探针只操作自行创建的系统临时目录，退出时清理。下文 `PROVEN` 表示本次源码或运行证据已证实；`INFERRED` 表示推断；`PROPOSAL` 表示待实施方案；`UNKNOWN` 表示尚无证据。

## 当前基础与优化依据

**PROVEN：1.2.0 已经实现一批关键改进。** `begin --spec`、计划命令与源码快照绑定、失败证据失效、`reopen/replan`、合法中间状态继续 `finish`、按数据库影响加载策略、`guide --context-since` 都已存在。本次 Runtime 131/131、评测框架 8/8 通过，均为零失败、零跳过。这些能力应作为下一轮改动的回归基线。

**PROVEN：此前模型对照尚未证明交付收益。** 本次重新审计了两轮共 18 个样本，结果与保存的统计一致。旧版本复验中：

| 同一模型的组别 | 功能通过 | 预算内完整交付 | 平均耗时，含超时 |
| --- | --- | --- | --- |
| 原流程 | 3/3 | 3/3 | 130.3 秒 |
| Harness | 3/3 | 1/3 | 176.0 秒 |

这组对照对应旧产品快照 `625f0fa8…`，每题每组只有一次，且 Harness 完整交付还包含工作流终态检查。它是调查流程成本的线索，不能推断当前 1.2.0 的效果，也不能证明普遍退化。

**PROVEN：1.2.0 有一次 Codex 小型任务实跑记录，但没有同条件效果对照。** 保存记录约 114.8 秒，工具事件区间约 11.2 秒，其余约 103.6 秒包含模型、网络和客户端等待。**INFERRED：**减少模型需要判断或读取的往返，可能比单独优化 Node 命令执行更有收益；现有样本不能确定各部分的因果贡献。

证据：[历史对照](../MODEL-BENCHMARK-001/comparison.md)、[1.2.0 交付记录](../HARNESS-USABILITY-001/delivery.md)、[客户端实跑边界](../HARNESS-USABILITY-001/client-verification.json)。上述是本次核验的历史记录，本次没有重新调用真实模型；也没有重新检查 Claude/Gemini 的安装或登录状态。

## 优化优先级

这里的 P0/P1/P2 表示建议实施顺序。

| 优先级 | 优化项 | 当前证据 | 最小验收条件 |
| --- | --- | --- | --- |
| P0 | 统一评测驱动的完成判定，补源仓库 CI | Codex 模拟异常轨迹仍返回 `completed: true`；现有 CI 未运行 benchmarks 测试 | 三个驱动均拒绝损坏协议与未解决的终态失败；正常轨迹仍通过；源仓库 CI 覆盖相关测试 |
| P1 | 增加进程中断后的恢复机制 | 持锁子进程退出后，下一次获取锁仍为 `LOCK_TIMEOUT` | 能诊断失效锁并恢复合法进度；存活进程的锁不会被误抢占；已有证据不会重复登记 |
| P1 | 建立当前版本的效果与耗时闭环 | 旧评测三题单次；已有 timing 未归因到具体工作流环节 | 固定版本和验收，重复采样，分别报告功能、交付、协议、耗时与未知用量 |
| P1 | 改善明确文件的上下文读取 | Java/Python/Dart/Vue/JSON 被过滤且无遗漏说明 | 显式文件要么有界返回，要么解释遗漏原因；保留哈希、截断和路径校验 |
| P2 | 继续减少模型交互，并加强验收证据对应 | BUGFIX 尚无与 ITERATION 相同的主收尾建议；部分阶段只要求说明性证据 | 模型往返减少且原门禁不退化；验收项能对应实际检查或可核验产物 |

### 1. 先修评测驱动，再衡量优化收益

**PROVEN：**[codex-driver.mjs](../../../benchmarks/codex-driver.mjs:31) 对损坏 JSON 行直接忽略；虽然收集 `error` / `turn.failed`，最终 `completed` 判定没有使用这些错误。相比之下，[client-drivers.mjs](../../../benchmarks/client-drivers.mjs:101) 会检查损坏行数量和协议成功状态。

本次用本地模拟 CLI 验证了两个场景，均没有调用模型服务：

| 输入轨迹 | 当前 Codex 驱动结果 |
| --- | --- |
| 一行损坏 JSON，随后正常完成事件、最终文件和退出码 0 | `completed: true`，未记录损坏行数量 |
| `turn.failed`，随后完成事件、最终文件和退出码 0 | `completed: true`，同时 `errors` 非空 |

因此协议异常可能被后续完成声明掩盖。**这不表示历史 18 个样本已经发生误报**：本次额外扫描了这 18 份事件日志，均存在，未发现损坏 JSON 行或 `error` / `turn.failed` 事件；独立功能判定也是另一层证据。

**PROPOSAL：**保留各客户端独立事件解析器，统一“允许报告完成”的条件：有效最终结构、有效终态、无未解决的致命错误、无损坏协议、正常退出、未超预算。按具体客户端协议区分警告、重试过程和终态失败，不把所有告警都判成失败。以同一组模拟场景约束三个驱动的共同语义。

当前 8 项框架测试中，致命错误和损坏流测试主要覆盖 Claude/Gemini，未覆盖上述 Codex 路径。另外，[源仓库 CI](../../../.github/workflows/ai-harness.yml:21) 只运行 Runtime 测试、doctor 和工作流检查。应增加源仓库专用的评测测试工作流，并覆盖 Windows 与 Linux。标准 `ai-harness.yml` 会被安装器复制到目标项目，源仓库专用测试应与该安装载荷分开，避免要求目标项目也具有 `benchmarks/`。

### 2. 将“步骤之间可继续”扩展到“进程突然退出后可恢复”

**PROVEN：**[withFileLock](../../src/filesystem.mjs:159) 使用独占文件，记录 PID 和时间，仅在 `finally` 删除锁；遇已有锁只等待并超时。本次在隔离子进程持锁后直接退出，确认锁的 PID 属于已退出子进程，随后获取锁仍失败。

现有 [finish-resume 测试](../../tests/finish-resume.test.mjs:35) 已覆盖多个完整步骤边界的续跑。此次发现的是另一种恢复条件。

**PROPOSAL：**先增加失效锁诊断和受控恢复入口，记录足够的所有者身份。只有能证明原持有者已结束、目标版本仍匹配时才回收；仅凭锁的年龄不能判断失效。恢复过程保留原因与记录。

**INFERRED：**进一步需要检查多文件提交的中断一致性。[workflow.mjs](../../src/workflow.mjs:487) 会依次写证据、计划和状态；单文件原子替换不能保证这几项同时完成。可以在现有文件持久化方式上增加操作 ID、提交代次和未完成操作诊断；先用故障注入确定具体缺口，再决定是否需要最小事务日志。

验收应覆盖：持锁进程结束、存活持有者、证据追加后中断、计划写入后中断、重复恢复、旧源码证据失效。**UNKNOWN：**本次未逐个注入多文件写入窗口，没有宣称已复现状态损坏或断电后的数据丢失。

### 3. 用当前版本的完整轨迹驱动下一次精简

**PROVEN：**[timing.mjs](../../../benchmarks/timing.mjs) 已合并重叠工具区间；[runner.mjs](../../../benchmarks/runner.mjs:164) 已分别统计功能、完成和超时。优化应在这些数据上继续增加解释能力。

**PROPOSAL：**先比较“同模型原流程”和“同模型当前 Harness”，冻结题目、环境、客户端、推理配置、工具权限及时间预算。原三题保留为回归集，另选 6–10 个有独立验收的真实任务作为起点，例如跨文件 BUG、现有模块迭代、续接中断任务、前端核心流程；每题每组重复约 5 次。这个规模是本项目的起步建议，不是统计充分性的保证。

记录两组共同的功能与有效交付指标，另列 Harness 合规指标；保留超时及失败样本，报告成功率区间、耗时中位数和尾部、模型往返、参数错误、重复读取、人工纠正和缺失用量。短预算与长任务预算在实验开始前分别设定，避免看到失败后单独延长某组预算。

把已有工具区间与确定性分类关联：源码读取、建项、执行检查、guide、收尾、协议错误。Runtime 命令的执行时间与整个 CLI 时间分别记录；[evidence.mjs](../../src/evidence.mjs:75) 当前 `durationMs` 不包含前后的源码快照操作，不能拿它代表命令全程。

每次只验证一个主要假设，例如“减少重复正文是否降低模型往返”。记录实际效果后再继续压缩流程。当前根契约约 5.7 KB，源码快照也已复用 Git 对象标识并只重新哈希改动文件；现有证据不足以把全量哈希或根提示词长度认定为主要瓶颈。

### 4. 先让明确文件读取完整可解释，再扩展语言分析

**PROVEN：**[context.mjs](../../src/context.mjs:9) 当前支持 JS/TS/Markdown，最多返回 8 个文件、16,000 字符；关联分析仅检查有限的字面导入和邻近目录。

本次显式指定 `.mjs`、`.java`、`.py`、`.dart`、`.vue`、`.json` 六个普通文件，只返回 `.mjs`，`omitted` 与 `notReturned` 均为空。后者原本用于前次 manifest 的对比，因此解决此次遗漏需要明确的请求文件诊断，不能简单更改其含义。

**PROPOSAL：**把“读取用户明确指定的普通文本文件”与“自动发现语言依赖”分开。前者先提供有界原文；不支持、超限或被排除时给出原因。后者继续保持可选，并按实际使用的语言增补，不要求一次构建完整调用图。保留现有路径、脱敏、读取预算与增量哈希规则。

验收包含：显式多语言源码、达到文件数量上限、变化文件、上次被截断的文件、相同完整文件、被排除的文件。每一个请求路径都应有可解释结果。该限制属于上下文辅助能力，不代表 Runtime 无法管理 Java 等项目。

### 5. 精简模型需要处理的接口，同时让证据直接对应验收

**PROVEN：**[guide.mjs](../../src/guide.mjs:203) 的主 `finish` 建议只针对 ITERATION；[completion.mjs](../../src/completion.mjs:17) 和 `finish` 实际已支持符合条件的 BUGFIX。当前输出还会将相同的收尾建议同时放入 `next` 与 `shortcuts`。

**PROPOSAL：**沿用 `begin/run/guide/finish` 的现有结构，在 BUGFIX 已具备真实阶段证据时也提供统一的下一步，并明确缺少哪些 `stage-evidence` / `stage-command`。为机器调用增加可选的精简响应，只回传发生变化的状态、必须处理的缺口和唯一建议；保留完整响应兼容现有调用方。真正的复现、回归、审查与授权仍需满足。

**PROVEN：**[constants.mjs](../../src/constants.mjs:135) 目前只有 reproduction/regression 强制绑定真实 run 命令；static、sandbox、contract、eval、browser 仍可使用说明性阶段证据。源码和计划绑定已经解决“证据属于哪个版本”，业务语义是否正确仍需检查。

**PROPOSAL：**下一步让验收项关联检查 ID；外部执行结果按需附产物路径、摘要、哈希和执行来源。使用 `验收项 → 检查 → 命令/产物 → 源码快照` 建立追踪。优先使用确定性功能测试，模型评判用于确需裁量的语义部分。扩展证据格式时给新记录明确版本，保留旧终态事实和原有兼容规则。

验收重点是：有语法检查却缺少关键功能测试时能暴露覆盖缺口；失败或过期产物不能用于完成；合法已有证据可复用；外部不可用明确保持未验证。执行器优化须以测量为前提；长测试确需实时进度时再考虑流式输出和中断处理。

## 建议的演进边界与落地顺序

| 层次 | 继续保留的职责 | 建议增量 |
| --- | --- | --- |
| Codex/Claude/Gemini 客户端 | 模型循环、实际工具调用、客户端权限 | 按协议报告事件、终态和可用能力 |
| 仓库 Runtime | 输入、计划、状态、证据、下一步与 CI 门禁 | 失效锁恢复、可解释上下文、精简响应和验收对应 |
| 源仓库评测 | 独立验收、任务隔离、效果对照 | 统一完成判定、重复采样、环节耗时和异常轨迹回归 |

第一批先完成评测驱动一致性与源仓库 CI，确立可信的测量基础。第二批处理已复现的锁恢复和上下文遗漏，各自以最小改动交付。随后用当前版本和真实任务重复对照，依据轨迹决定 BUGFIX 收尾、响应精简及证据产物的实施顺序。

成功标准应同时包含交付质量与使用成本：在功能和证据门禁不退化的前提下，减少协议误报、不可恢复中断、模型往返和预算内未完成。具体性能目标应在新的基线测量后确定，当前没有依据承诺提升百分比。

## 官方资料与本项目的对应关系

以下页面均于本次调研实际读取，访问日期为 2026-09-15。资料证明的是公开设计方法；本项目中的效果仍须实验验证。

| 来源 | 可借鉴内容 | 本项目接入位置 |
| --- | --- | --- |
| [OpenAI：Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals) | 用轨迹定位工作流问题，再用数据集重复评测 | benchmarks 的完成判定、轨迹分类与固定题集 |
| [OpenAI：Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md) | 指令分层、项目范围和简洁的审查规则 | 保留现有根契约与按需策略，控制重复输入 |
| [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 最小有效上下文、按需读取、清晰且少重叠的工具接口 | context 的明确文件读取、guide 的唯一下一步 |
| [Anthropic：Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 增量推进、跨会话交接、真实端到端验证 | 现有工作项与 guide 的恢复，补进程中断验证 |
| [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 独立 outcome、重复 trial、确定性优先的判定与平衡题集 | 分开功能/流程指标，加入真实任务和重复采样 |
| [LangGraph：Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) | 明确失败来源、恢复条件，以及运行时限与空闲时限的区别 | 借鉴失败诊断与恢复语义，以现有持久化方式实现所需部分 |

## 本次验证及限制

| 实际执行 | 结果 |
| --- | --- |
| `node .ai-harness/bin/harness.mjs doctor --json` | 通过，无错误或警告 |
| `node .ai-harness/tests/run.mjs` | 131/131 通过，0 失败、0 跳过，约 96.9 秒 |
| `node --test benchmarks/tests/runner.test.mjs` | 8/8 通过，0 失败、0 跳过 |
| `node benchmarks/audit.mjs .ai-harness/work-items/MODEL-BENCHMARK-001/pilot` | 9 个样本一致性审计通过 |
| `node benchmarks/audit.mjs .ai-harness/work-items/MODEL-BENCHMARK-001/followup` | 9 个样本一致性审计通过 |
| 对上述 18 份 CLI 事件日志另行扫描 | 0 缺失，0 损坏 JSON 行，0 error/turn.failed 事件 |
| `node .ai-harness/work-items/ANALYSIS-HARNESS-OPT-20260915/probes.mjs` | 正常执行并清理夹具；复现失效锁、上下文遗漏和两种 Codex 协议异常完成判定 |

已有测试通过与新探针发现缺口可以同时成立：当前测试没有覆盖这些具体异常场景。探针是观察与复现工具，其退出码 0 不代表产品已修复。

本次没有运行新的真实模型对照，没有验证远端 CI、其他操作系统、生产环境或多文件写入时的断电恢复。没有修改产品代码，没有安装依赖、提交、推送或发布。模型效果和性能收益仍为 UNKNOWN。

工作项 `ANALYSIS-HARNESS-OPT-20260915` 用于通过 CLI 登记分析结论和收尾门禁；`ANSWERED` 只表示调研回答完成。
