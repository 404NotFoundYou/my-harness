# Runtime 1.11.0 交互摩擦优化设计

日期：2026-09-23

## 目标与边界

在不改变现有权限、状态机、验证快照或模型预算的前提下，减少固定 core Harness 题中已经由真实 benchmark 证明的命令探索和 Windows 参数传输浪费。保持零依赖 Node.js、`shell:false`、旧完整 spec 和显式 `--task` 路径兼容。

不增加超时、重试、后台自治、多代理编排或模型调用；不修改 baseline/project 题组契约；不提交或推送。

## 接口设计

1. `begin --spec <file> --risk <low|medium> --approach <text>`
   - `--spec` 只额外允许 `--risk` 和 `--approach`；其他任务定义参数仍以 `SPEC_OPTION_CONFLICT` 拒绝。
   - spec 必须保留这两个字符串字段。CLI 值只填充空字符串；字段已有非空值时以 `SPEC_JUDGMENT_CONFLICT` 拒绝，即使值相同也不视为可覆盖。
   - 未通过 CLI 填完的空 judgment 继续由现有校验拒绝，完全填写的旧 spec 保持可用。
   - schema 允许 benchmark 骨架中的空 judgment，但 Runtime 调用仍负责最终非空校验。

2. `run --all` 单任务推断
   - 显式 `--task` 行为不变。
   - 省略时按现有 `runRecordedCommand` 门禁筛选：`IMPLEMENTING` 仅 `IN_PROGRESS`，`VERIFYING` 仅 `COMPLETED`。
   - 恰好一个候选时选择它；零个或多个候选以 `TASK_SELECTION_REQUIRED` 返回候选与状态，不猜测所有者或推进任务状态。

3. `finish` 命令帮助
   - `finish --help` 与 `help finish` 在项目根解析前返回同一份参数说明并退出 0。
   - 帮助不加载工作项、不校验 `--id`、不写状态。只增加 finish 的最小映射，不建设通用帮助框架。

4. 过期验证恢复
   - `VERIFICATION_NOT_CURRENT` 保留 missing/failed 事实，并在能唯一确定任务时增加 `details.next = { executable: "node", args: [...] }`。
   - 参数固定为 `run --id <ID> --task <TASK> --all --json`，重新执行全部已批准检查；不绕过源码摘要、计划摘要、任务尝试或后续失败失效规则。
   - guide 明确最后一次源码修改后再验证，验证通过后不得继续修改产品文件；若修改则重新验证。

5. benchmark 引导
   - core Harness 的预填 spec 保持公开范围、检查和空 judgment；模型通过 CLI 参数提交 risk/approach，不编辑 JSON。
   - 固定提示使用 `guide --brief`；建项后先完成实现和必要额外测试，最后调用一次 `run --all`。通过后不再改产品文件，立即 finish 和 check。
   - baseline 与 project 题组不变，隐藏判定、预算和真实模型授权边界不变。

## 修改范围

- Runtime：`.ai-harness/src/cli.mjs`、`input.mjs`、`guide.mjs`、`verification.mjs`、`schemas/begin-spec.schema.json`、`manifest.json`
- 测试：`spec-input.test.mjs`、`cli.test.mjs`、`compact.test.mjs`、`guidance-tools.test.mjs`、`benchmarks/tests/spec-guidance.test.mjs`
- benchmark：`benchmarks/runner.mjs`
- 文档：`README.md`、`docs/guides/usage.md`、`benchmarks/README.md`

如实现证明某个列出的测试文件无需修改，则不为凑范围改动；不得触碰无关工作项目录。

## 验证意图

- structured spec：空 judgment 可由 CLI 填充，非空不可覆盖，其他混用仍拒绝；BOM、Unicode、数组、逗号/空格路径保持。
- run inference：单候选成功，零候选和多候选拒绝。
- help：两种 finish 帮助从非项目目录也成功且无状态副作用。
- stale recovery：错误包含可复制参数数组，guide 同步说明修改/验证顺序。
- benchmark：模拟 core Harness 不编辑 spec，begin/run/finish/check 各一次到 DONE；baseline/project 提示不变。
- 最后执行聚焦测试、Runtime 全量、benchmark 全量、doctor、`git diff --check`、独立审查及 `check --ci`。

## 数据库判断

仅修改本地 CLI 参数解析、工作项选择、错误/引导文本、benchmark 提示、版本和测试，不涉及 Schema、持久化、查询、迁移、事务或生产数据，数据库影响为 `none`。
