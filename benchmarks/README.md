# 固定任务模型对照

比较 weak-baseline（较弱模型直接实现）、weak-harness（同一较弱模型使用本项目）、strong-reference（较强模型直接实现）。模型角色是实验配置，不能保证所选模型在每题的能力排序。

三个零依赖 Node.js 项目：CSV 记录解析、精确整数分配、增量事件合并。每题公开规格、初始实现、调用方和公共测试相同；每组一个临时 Git 仓库和独立会话。CSV/分配是开发集，事件合并为留出题。每题12个隐藏验收，只有模型退出后才复制实现到另一目录运行；判定器和参考实现不会随 Harness 安装给参与者。

```powershell
# 不调用模型的框架测试
node --test benchmarks/tests/runner.test.mjs benchmarks/tests/multifile.test.mjs benchmarks/tests/resume.test.mjs benchmarks/tests/status.test.mjs benchmarks/tests/report.test.mjs benchmarks/tests/spec-guidance.test.mjs

# 真实调用；复用现有 Codex CLI 登录，运行前应取得模型调用授权
node benchmarks/run.mjs --cli 'D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js' --weak gpt-5.6-luna --strong gpt-5.6-sol --out .ai-harness/work-items/MODEL-BENCHMARK-001/pilot
# 检查九项结果、输入/判定/代码哈希及统计一致性（不再次调用模型）
node benchmarks/audit.mjs .ai-harness/work-items/MODEL-BENCHMARK-001/pilot
```

`--cli` 为实际二进制或 Node CLI 入口，不使用 shell 拼接或 Windows `.cmd` 回退。`--client codex|claude|gemini` 选择驱动，默认codex。每次180秒、观察到80次工具调用时中断；不自动重试。按任务轮换三组顺序，共9次模型调用；CLI上报用量不等于货币费用。不修改全局凭据或模型配置。

`1.3.0` 保留上述默认配置，并支持先比较同模型两组及重复试次。下面只预览计划，不检查登录、不创建输出目录、不调用客户端：

```powershell
node benchmarks/run.mjs --cli '<CLI路径>' --weak '<模型标识>' --comparison paired --repetitions 5 --timeout-ms 180000 --max-tools 80 --out .ai-harness/work-items/<工作项>/comparison --dry-run
```

正式执行前确认费用授权，再使用同一参数去掉 `--dry-run`。`paired` 为两组，`reference` 为原三组且要求 `--strong`；默认重复1次，可设1–100次。三个固定题、两组、重复5次共30个独立会话。每个试次使用新临时仓库，目录包含 trial 编号，顺序按题目与轮次轮换；预算在运行前冻结。重复试次不是失败后的自动重试，不遗漏失败样本。真实仓库任务仍需后续独立题集，原三题的适用范围没有扩大。

## Core Harness任务入口

1.9.0仅对core题的Harness组，在参与者的固定Git基线建立后，生成`.ai-harness/work-items/benchmark-begin-spec.json`供`begin --spec`读取。它只从公开任务文件预填任务ID、授权来源、允许修改的入口与可选自测文件、公共测试命令和无数据库依据；`risk`与`approach`为空，参试模型须按实际任务填写，未填写时Runtime拒绝创建工作项。创建后仍用原`guide`、`run --all`与`finish`登记真实验证和收尾；不会自动将功能通过视作工作项完成。

1.9.1把core Harness组的结构化入口提示写入固定基线`AGENTS.md`：使用项目相对路径，仅填写`risk`和`approach`，保留公开预填字段及`docsImpact`的N/A理由。提示也要求真实`finish`与`check --ci`通过后尽快返回结构化最终答复；如果客户端到时未正常完成，仍算超时，不能由工作项DONE自报替代。普通baseline和project题规则不变；这是评测引导变化，尚无真实模型收益结论。

1.9.2仅在评测自身创建的临时沙箱清理遇到`ENOTEMPTY`时进行最多三次尝试，解决Git pack目录瞬时并发导致的测试环境清理失败；非归属路径拒绝删除，其他错误和持续失败继续显式暴露。不会重试模型会话或改变任务结果。已有真实实验仍需按原始冻结源码审计。

输入文件不是`state.json`、`plan.json`或执行证据，不能替代CLI维护控制面。原流程组和project题的提示与输入保持原样；core题的公开规格、隐藏用例、判定器、预算及已完成实验的审计语义不变。本地模拟用例验证了占位字段拒绝、结构化输入成功到DONE及两组隔离，但并不证明较弱模型在180秒内会完成流程；真实复测需要新的模型费用授权。

## 多文件工程题集

从 `1.5.0` 起可显式选择 `--suite project`。默认 `core` 保持原三题，不自动增加调用次数。1.5.0的core/project分别使用协议版本2/3；1.6.0新建实验统一使用版本4，旧协议保留审计。project目前只有一个开发题 `archive-pagination`，它是按公开规格构造的工程BUG夹具，不来自生产事故记录，也不能单独代表真实仓库任务的整体难度。

题目要求协同修复 `src/repository.mjs` 的归档筛选、稳定排序和输入不可变，以及 `src/pagination.mjs` 的排他游标、分页大小和末页游标。固定 `src/caller.mjs`、`src/limits.mjs`、原公共测试与规格只读；另可新增 `test/extra.test.mjs`。共有12个隐藏验收，覆盖调用方及两个模块的直接契约，完整参考修复通过、只修任一模块均不足。Harness组使用BUGFIX，保留复现、根因及static/sandbox/reproduction/regression阶段，复现和回归引用真实命令。

project组的完整交付还要求：至少一个开发工作项，所有开发项均为题目冻结的BUGFIX且已DONE，已完成任务的写入范围并集覆盖全部可写实现文件。可以保留已ANSWERED分析项；普通ITERATION或无关BUGFIX不能代替。Runtime原有CI继续校验状态、阶段、当前源码和证据，评分保存类型/范围契约；v3审计再与归档state.json、plan.json交叉核对。此映射不证明模型在每一步作出了正确的业务判断，也不代替隐藏功能验收。

```powershell
# 仅预览一个project题、同模型两组、重复一次，共2次拟调用；不启动客户端
node benchmarks/run.mjs --cli '<CLI路径>' --weak '<模型标识>' --suite project --comparison paired --repetitions 1 --out .ai-harness/work-items/<工作项>/project-comparison --dry-run
```

v3在协议中冻结题目入口、导出、类型和精确可写清单，并保留源码、题目、判定器和预算哈希。各试次保存 `candidate-files.json`，逐文件记录present正文及原字节SHA-256，或missing/invalid状态；result保存规范化manifest的整体哈希。路径父组件和文件都不能经过链接/junction，无效UTF-8拒绝，BOM及换行字节保留；非预期IO错误中断并保留不完整实验。候选必须恰好覆盖声明文件，不接受只读文件或额外路径。

判定器从冻结题目恢复只读依赖，再放入本次候选；可写基线实现不会进入判定目录，缺失候选不会回退。候选缺失、非普通文件或非法编码均判scope/grade失败。参与者修改原测试或固定依赖同样scope失败，判定仍使用原文件。新审计检查全部manifest、文件哈希、题目清单和原始协议/摘要/统计；旧v1/v2及candidate.mjs格式保持。审计验证记录一致性，不构成外部可信执行证明或重新执行隐藏判定。

`multifile.test.mjs` 使用模拟驱动覆盖两组、实际复现/修复/回归、Harness门禁和完整审计，结果始终标为simulated；不会访问模型服务。真实模型收益需要另行授权、冻结配置后实跑，不能从模拟通过推断。

Codex与Claude请求medium推理档；Gemini CLI没有对应参数，因此记录为null，不声称跨客户端推理预算相同。Codex使用workspace-write沙箱；Claude采用dontAsk及明确的文件/验证工具允许列表，不声称提供操作系统沙箱；Gemini要求sandbox与auto_edit，环境或权限不满足时明确失败，不自动改成yolo。不同客户端的统计分开，不能把这些权限条件视为完全相同。

`run.timing` 记录本地收到的工具开始/结束事件，重叠区间合并为toolActiveMs，未配对事件和中断区间明确标记。otherElapsedMs包含模型、网络、客户端启动和收尾，不等于纯推理耗时。Claude用量将输入、缓存读取、缓存写入合并为总输入，同时保留原值；Gemini保留rawUsage，共同用量字段暂记未知，避免猜测计费语义。

工具区间新增基于可见工具名/命令文本的 reading、editing、planning、guidance、verification、completion 等类别，无法确定时为 unknown；类别内重叠合并，类别之间可能重叠，不直接相加。统计同时给出功能、两组共同交付和含 Harness 门禁的完整交付，报告 Wilson 95% 区间、耗时中位数/p95、协议失败、无效最终结构和已返回用量的样本数。区间仅描述这些试次，同题重复不是独立任务；超时是时间截断，p95不代表未截断的真实完成时长。

接口依据：[Codex事件流](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude非交互模式](https://code.claude.com/docs/en/headless)、[Gemini非交互模式](https://geminicli.com/docs/cli/headless/)。驱动存在不等于已验证本机登录、沙箱和真实任务；具体环境检查与实跑记录保存在对应工作项中。

首次运行的输出目录必须不存在，避免覆盖旧实验；协议v4可通过下述 `--resume` 继续。保存协议/源码/任务哈希、prompt、脱敏JSON事件和stderr、结构化自报结论、候选代码、退出码、耗时、工具数和用量、文件范围检查、Harness工作项记录、隐藏用例结果及统计。`summary.complete` 仅在计划内全部试次都有可信结果且源版本未变化时为true；失败样本仍参与统计。模型功能通过、正常完成、流程终态、误称完成分别统计。

## 只读实验状态与续跑预览

1.7.0提供独立状态入口，从冻结协议读取模型、题集和预算，无需重新填写实验参数：

```powershell
node benchmarks/status.mjs --out .ai-harness/work-items/<工作项>/project-comparison
# 可选：只读取明确指定的CLI入口指纹，不执行CLI、不检查登录
node benchmarks/status.mjs --out .ai-harness/work-items/<工作项>/project-comparison --cli '<CLI实际文件路径>'
```

输出JSON：`observed`保留磁盘中的pending/started/completed/interrupted计数；`recoveryPreview`是在内存中按实际续跑规则核验后推导的状态，`needed`表示started需要登记恢复结果。列表最多展示20项，`omittedTrials`说明省略数量，计数覆盖完整计划。`integrity`表示记录校验结果，源码/身份由`source`和`driver`单独说明；`blockers`列出未满足条件。报告不输出候选正文，字符串递归脱敏。

默认身份为`unverified`，不会根据协议中自报的外部CLI路径读取文件。API `inspectExperiment({sourceRoot, outputDirectory, cliPath?, driverIdentity?})`还允许为模拟实验传入`driverIdentity`，标记`basis: caller-declared`；该值只表示调用方声明，不能证明真实客户端或函数闭包一致。

仅在记录完整、源码与显式身份匹配、读取稳定且锁为free或本机stale时，`resume.canResume`为true，并提供`remainingCalls`（仅pending）；否则为null。started有可信结果可预览为completed，确实缺结果则预览为interrupted，不自动重试。因此`remainingCalls: 0`不等于`recoveryPreview.complete: true`，completed也可能包含功能失败样本。

状态检查不创建目录或锁、不回收失活锁、不补写ledger或summary、不启动模型。stale仅标记`lockRecoveryRequired`；active、foreign、unknown、changed或legacy锁只做结构观察，`recoveryPreview`为null。前后复查协议/ledger原字节、锁代次、源码和显式身份；观察到变化便撤销可续跑结论。读取结束后的变化仍须由实际`--resume`获取锁后重新核验，`validationRequiredOnExecution`始终为true，预览不提供执行授权或未来调用数保证。

摘要缺失或损坏不妨碍可信v4记录的预览；损坏证据和内部链接明确拒绝。旧v1/v2/v3返回`unsupported`，仍使用原审计。CLI退出码0表示得到可续跑观察，2表示锁、漂移、身份未确认或旧协议阻塞，1表示参数、实验文件缺失或证据损坏。模拟及合成CLI测试不代表实际模型客户端已验证。

## 只读实验收益对照

1.8.0 对单个已完成、完整审计通过的 v4 实验生成 JSON 或 Markdown 报告，无需再次填写模型、题集、预算或 CLI 路径：

```powershell
node benchmarks/report.mjs --out .ai-harness/work-items/<工作项>/project-comparison
node benchmarks/report.mjs --out .ai-harness/work-items/<工作项>/project-comparison --format markdown
```

按冻结的 taskId/trial 将 weak-baseline 与 weak-harness 配对；reference 实验的 strong-reference 仍经完整审计，但不进入弱模型配对分母。功能通过、两组相同条件的共同交付、额外包含 Harness 流程门禁的完整交付分别计数。逐题列出结果相对路径、可观察的失败条件、度量与差值。失败条件可能重叠，不代表模型或网络根因；模拟结果始终标为 simulated，不能当作真实模型收益。

差值方向统一为 Harness 减 baseline，先计算每对差值再取中位数；Markdown逐题展示耗时、工具次数及Token差值。每项度量分别列出有效与未知配对；缺失 Token 或耗时不按零计算。超时/工具预算截断及截断标志未知单独标记，观测区间更短不等于实际完成更快；工具分类活跃时间可能重叠，不相加。相同任务的重复试次不作为独立任务证明通用能力或因果效果。

入口通过与现有审计共享的严格证据读取器读取并前后核对所有实际用到的文件及锁；缺文件、链接、损坏、未完成、变化中的实验和非法度量都不会生成半份配对报告。仅允许 free 或本机 stale 锁，检查不创建或回收锁，不写实验文件、不读取协议自报的外部 CLI、不执行客户端。审计证明记录内部一致性，不验证当前客户端或报告返回后的文件状态。

CLI 默认输出 JSON；`--format markdown` 使用同一脱敏报告模型并转义可渲染的用户字段。退出码 0 表示报告成功，2 表示未完成、旧协议、锁或并发变化，1 表示参数或证据无效。旧 v1-v3 仍可使用原审计路径；本报告不对其重建缺失的历史信息。真实参试模型的收益需另行授权运行并验证。

## 实验续跑与中断记录

1.6.0新实验使用协议v4。续跑时使用原参数、原输出目录和原源码，只增加 `--resume`；真实调用仍须已有对应费用授权：

```powershell
node benchmarks/run.mjs --cli '<CLI实际文件路径>' --weak '<原模型标识>' --suite project --comparison paired --repetitions 1 --out .ai-harness/work-items/<工作项>/project-comparison --resume
```

恢复先核对源码、完整计划、题目/判定器、客户端/模型/预算、运行模式及驱动指纹，再验证所有已有试次。任一处漂移、损坏、缺失完成结果、候选/协议不一致或pending已有目录时，在新调用前失败。旧v1/v2/v3没有启动记录，只支持原审计，不能推断历史调用或补造状态来续跑。初始化protocol/执行记录不完整的目录也明确拒绝恢复。

`execution.json` 按冻结schedule保存pending→started→completed或interrupted。started在调用驱动前原子登记；因此它表示可能已调用。completed表示有可信结果，包含模型失败样本，恢复时不重复调用。started有完整结果时复用共同审计并恢复completed；只有确实缺少结果时才保留interrupted及未知用量，不自动重试。其他pending可继续执行。若仍存在interrupted，最终输出 `incomplete` 且CLI退出非零；完整审计仍拒绝把它视为完成实验。

摘要丢失或损坏可由可信执行记录及结果重建。`notRun`只列pending，`interrupted`单独列出中断试次及usage:null；`progress`按组给出scheduled/completed/interrupted/pending/usageUnknown。groups统计只基于已完成结果，其通过率不能解释为全部计划的通过率。`--resume`与`--dry-run`不能共用，避免将全计划调用数误报为剩余调用数。

每个目录一次只允许一个执行者。活锁、异机或未知锁拒绝续跑；同机确定已退出的所有者可在完整只读校验后恢复锁，再获取独占锁重新校验。仅凭经过时间或PID复用不回收。协议、执行记录、结果和摘要使用同目录临时文件原子替换；这保证进程中断边界的完整可见性，没有fsync/断电持久性或恰好调用一次的承诺。发生未确认调用时保留未知比重复调用更保守；孤儿临时工作区不参与续跑。

`--cli`应指向实际存在的二进制或Node入口文件，记录realpath、文件SHA-256和Node版本，并在试次前后重验。API的真实驱动需显式提供该身份；模拟默认使用函数源码SHA-256，也可声明固定模拟指纹。入口指纹不覆盖加载的全部依赖、函数闭包、全局客户端配置或远端模型别名实现，不能据此证明完整运行环境一致。输出目录放在工作项控制面或源码目录外，避免实验产物本身造成源码漂移。

协议版本2/3/4的审计重建完整试次集合，从原始事件日志重算客户端协议状态，并核对 Codex 最终文件、逐条摘要和聚合统计；v4另校验执行记录、协议/结果原字节哈希及试次源码快照。空日志、未解决终态失败、损坏 JSONL 或非法最终结构不能支持完成。正常警告会保留。版本1的历史九样本记录沿用原统计格式，不改写历史事实。模拟驱动实验始终标注 simulated，测试夹具不作为真实模型效果证据。

持久化协议按字段递归脱敏并保持 JSON 结构，最终结果使用相同规范；无法解析的行保留明确失败标记和数量，原始敏感正文不落盘。审计使用这份结构化脱敏记录，不宣称逐字保存客户端原始字节流。

隐藏判定在 Node 权限模式下仅开放判定目录读取，有5秒超时；必须收到随机完成标记及完整、无重复的用例ID集合。单纯退出0、提前退出或缺失日志都不算通过。这是功能实验，不是抵抗恶意参试者的远程安全隔离系统。

`tasks.mjs` 中参考解和隐藏用例只供框架作者验证判定器；实验前冻结任务，不能按某组输出修改验收。修改辅助后使用相同任务和预算重新跑全部三组，开发集失败用于调整，留出题结果不用于调参。小样本只说明这些题在本次配置下的表现，不能证明通用模型能力等价。
