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

`--cli` 为实际二进制或 Node CLI 入口，不使用 shell 拼接或 Windows `.cmd` 回退。每次固定 medium 推理档、180秒、观察到80次工具调用时中断；不自动重试。按任务轮换三组顺序。共9次真实模型调用，CLI上报用量不等于货币费用。当前内置 Codex 驱动，可通过 `runCase` 的驱动接口接其他客户端；不修改全局凭据或模型配置。

输出目录必须不存在，避免覆盖旧实验。保存协议/源码/任务哈希、prompt、脱敏JSON事件和stderr、结构化自报结论、候选代码、退出码、耗时、工具数和用量、文件范围检查、Harness工作项记录、隐藏用例结果及统计。`summary.complete` 仅在九项执行完且源版本未变化时为true；失败样本仍参与统计。模型功能通过、正常完成、流程终态、误称完成分别统计。

隐藏判定在 Node 权限模式下仅开放判定目录读取，有5秒超时；必须收到随机完成标记及完整、无重复的用例ID集合。单纯退出0、提前退出或缺失日志都不算通过。这是功能实验，不是抵抗恶意参试者的远程安全隔离系统。

`tasks.mjs` 中参考解和隐藏用例只供框架作者验证判定器；实验前冻结任务，不能按某组输出修改验收。修改辅助后使用相同任务和预算重新跑全部三组，开发集失败用于调整，留出题结果不用于调参。小样本只说明这些题在本次配置下的表现，不能证明通用模型能力等价。
