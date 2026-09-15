# 固定任务模型对照

比较 weak-baseline（较弱模型直接实现）、weak-harness（同一较弱模型使用本项目）、strong-reference（较强模型直接实现）。模型角色是实验配置，不能保证所选模型在每题的能力排序。

三个零依赖 Node.js 项目：CSV 记录解析、精确整数分配、增量事件合并。每题公开规格、初始实现、调用方和公共测试相同；每组一个临时 Git 仓库和独立会话。CSV/分配是开发集，事件合并为留出题。每题12个隐藏验收，只有模型退出后才复制实现到另一目录运行；判定器和参考实现不会随 Harness 安装给参与者。

```powershell
# 不调用模型的框架测试
node --test benchmarks/tests/runner.test.mjs

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

Codex与Claude请求medium推理档；Gemini CLI没有对应参数，因此记录为null，不声称跨客户端推理预算相同。Codex使用workspace-write沙箱；Claude采用dontAsk及明确的文件/验证工具允许列表，不声称提供操作系统沙箱；Gemini要求sandbox与auto_edit，环境或权限不满足时明确失败，不自动改成yolo。不同客户端的统计分开，不能把这些权限条件视为完全相同。

`run.timing` 记录本地收到的工具开始/结束事件，重叠区间合并为toolActiveMs，未配对事件和中断区间明确标记。otherElapsedMs包含模型、网络、客户端启动和收尾，不等于纯推理耗时。Claude用量将输入、缓存读取、缓存写入合并为总输入，同时保留原值；Gemini保留rawUsage，共同用量字段暂记未知，避免猜测计费语义。

工具区间新增基于可见工具名/命令文本的 reading、editing、planning、guidance、verification、completion 等类别，无法确定时为 unknown；类别内重叠合并，类别之间可能重叠，不直接相加。统计同时给出功能、两组共同交付和含 Harness 门禁的完整交付，报告 Wilson 95% 区间、耗时中位数/p95、协议失败、无效最终结构和已返回用量的样本数。区间仅描述这些试次，同题重复不是独立任务；超时是时间截断，p95不代表未截断的真实完成时长。

接口依据：[Codex事件流](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude非交互模式](https://code.claude.com/docs/en/headless)、[Gemini非交互模式](https://geminicli.com/docs/cli/headless/)。驱动存在不等于已验证本机登录、沙箱和真实任务；具体环境检查与实跑记录保存在对应工作项中。

输出目录必须不存在，避免覆盖旧实验。保存协议/源码/任务哈希、prompt、脱敏JSON事件和stderr、结构化自报结论、候选代码、退出码、耗时、工具数和用量、文件范围检查、Harness工作项记录、隐藏用例结果及统计。`summary.complete` 仅在计划内全部试次执行完且源版本未变化时为true；失败样本仍参与统计，异常中断保留不完整 summary 和 notRun。模型功能通过、正常完成、流程终态、误称完成分别统计。

新协议版本2的审计重建完整试次集合，从原始事件日志重算客户端协议状态，并核对 Codex 最终文件、逐条摘要和聚合统计；空日志、未解决终态失败、损坏 JSONL 或非法最终结构不能支持完成。正常警告会保留。版本1的历史九样本记录沿用原统计格式，不改写历史事实。模拟驱动实验始终标注 simulated，测试夹具不作为真实模型效果证据。

持久化协议按字段递归脱敏并保持 JSON 结构，最终结果使用相同规范；无法解析的行保留明确失败标记和数量，原始敏感正文不落盘。审计使用这份结构化脱敏记录，不宣称逐字保存客户端原始字节流。

隐藏判定在 Node 权限模式下仅开放判定目录读取，有5秒超时；必须收到随机完成标记及完整、无重复的用例ID集合。单纯退出0、提前退出或缺失日志都不算通过。这是功能实验，不是抵抗恶意参试者的远程安全隔离系统。

`tasks.mjs` 中参考解和隐藏用例只供框架作者验证判定器；实验前冻结任务，不能按某组输出修改验收。修改辅助后使用相同任务和预算重新跑全部三组，开发集失败用于调整，留出题结果不用于调参。小样本只说明这些题在本次配置下的表现，不能证明通用模型能力等价。
