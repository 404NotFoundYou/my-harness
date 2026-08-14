# AI Harness Runtime 托管契约

> 语言：默认使用简体中文
> 详细策略：`.ai-harness/policies/`

本区块只管理跨项目开发流程和安全门禁。区块外的项目业务、技术栈和代码规范继续有效；发现冲突时必须明确列出冲突来源和选择依据，禁止静默折中。

## 强制启动协议

除单一事实查询和不改变行为的单文件机械修改外，所有工作必须：

1. 运行 `node .ai-harness/bin/harness.mjs doctor --json`。
2. 选择唯一主类型：`NEW_PROJECT`、`ITERATION`、`BUGFIX` 或 `ANALYSIS`。
3. 根据业务选择 `database`、`frontend`、`mobile`、`api`、`multi-agent` 标志。
4. 运行 `policies --type <TYPE> [--flag <FLAG>] --json` 并完整读取返回策略。
5. 使用 `start` 创建工作项；状态、计划、任务、证据和 Review 只能通过 Runtime CLI 更新，禁止直接编辑控制面 JSON/JSONL。

## 开发门禁

- 开发型工作依次经过基线、技术设计、数据库判断/设计、批准计划、实施、验证、Code Review 和验收；禁止跳过状态。
- 正式编码和执行计划前必须完成数据库影响判断；影响为 `required` 时必须先完成字段、查询、索引、事务和迁移设计。
- `NEW_PROJECT` 必须记录架构来源与批准；`BUGFIX` 必须记录实际行为、期望行为和复现路径。
- 计划必须包含依赖、写入范围、验证、文档影响、风险、所有者和 Review Batch。计划批准后连续执行所有可执行任务，不逐项询问。
- 阻塞任务记录原因；其依赖任务不得解锁，其他独立任务继续。
- 每个任务验证通过后才能进入 Review，Review 通过后才能完成。BUG 修改或返工后必须重新验证和 Review。
- 高风险批次需要不同上下文或人类独立复核；不可用时不得伪称完成。
- 行为、Schema、API、配置、架构、部署或运维变化必须同任务更新文档。

## 分析、命令与证据

- 业务实现或技术方案询问使用 `ANALYSIS`，以当前检出代码、Schema、配置和测试为证据；事实、推断、建议和未知必须分开。
- 构建和测试优先通过 `harness.mjs run` 执行。`ask` 和 `deny` 命令不会执行；不得改用嵌套 shell 绕过。
- 删除、覆盖、Git 历史修改、部署、发布、生产数据、费用、外部消息和凭据变更需要明确授权。
- 失败、跳过、超时和未运行必须显式记录。没有原始证据不得宣称测试通过或功能完成。
- 最终声明前运行 `node .ai-harness/bin/harness.mjs check --ci --json`；只有相应工作项为 `DONE`/`ANSWERED` 且退出码为 0 才能宣称完成。

## 真实边界

Runtime 能强制自身状态、允许命令、证据和 CI，但不能拦截 AI 客户端绕过 CLI 的专有工具。客户端权限/沙箱、Runtime CLI 和合并前 CI 必须共同生效。
