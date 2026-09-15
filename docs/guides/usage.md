# Harness 安装与工作流

## 1. 项目接入

从 Harness 源仓库执行。实际写入只需第二条 `install` 命令，第一条 `--dry-run` 是可选预检：

```text
node <HARNESS_REPO>/.ai-harness/bin/harness.mjs install --target <TARGET> --dry-run --json
node <HARNESS_REPO>/.ai-harness/bin/harness.mjs install --target <TARGET> --json
```

- `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 已存在时，默认保留原文并追加 Harness 托管块；原文逐字保留在托管块外。
- `CLAUDE.md` 已有独立行 `@AGENTS.md`，或 `GEMINI.md` 已有独立行 `@./AGENTS.md` 时，适配器保持字节不变。
- 托管块带 Runtime 版本和正文 SHA-256。重复安装为 `skip`；升级只更新托管块，不从安装源根规则复制项目私有内容。
- 修改已有文件前先备份到 `.ai-harness/backups/<ID>/`；成功结果中的 `backup` 给出相对路径。备份目录不会被再次分发。
- 普通 Runtime/CI 文件内容不同时为 `conflict`，默认在任何写入前失败；`--dry-run` 只返回完整操作计划。
- 托管块内容被改动时默认报 `MANAGED_BLOCK_MODIFIED`；`--force` 只修复该块。标记缺失一半、重复或不独占一行时报 `MANAGED_BLOCK_MALFORMED`，`--force` 也不覆盖。
- `--force` 可在明确授权后备份并替换普通冲突文件，但不会替换托管块外的项目规则。
- 新项目使用 `init --mode new --docs default`。
- 已有项目使用 `init --mode existing --docs existing`。
- 运行开发工作项前，先建立包含 Harness、初始代码和文档的 Git 提交。

托管块形态如下；项目规则写在块外，不要手工编辑块内正文或标记：

```text
<!-- AI-HARNESS:BEGIN file=AGENTS.md version=1.0.0 sha256=<HASH> -->
<Runtime 标准载荷>
<!-- AI-HARNESS:END file=AGENTS.md -->
```

安装报告中的 `preservedExisting: true` 表示原文已保留；`conflictReviewRequired: true` 表示仍需在后续任务中显式处理项目规则与 Harness 规则的语义冲突，不代表需要手工拼接文件。合并后的 `AGENTS.md` 超过 `config.json` 的 `rootInstructionsMaxBytes` 时，安装在写入前失败。

### 安全卸载

```text
node <HARNESS_REPO>/.ai-harness/bin/harness.mjs uninstall --target <TARGET> --dry-run --json
node <HARNESS_REPO>/.ai-harness/bin/harness.mjs uninstall --target <TARGET> --confirm --json
```

- `--dry-run` 不写入，返回托管块、安装收据、Runtime、CI 和 `project.json` 的完整操作计划。
- 命令必须从独立 Harness 源仓库执行；目标项目不能使用自身 Runtime 自卸载。
- 卸载清单来自安装时生成的 `.ai-harness/install-receipt.json`；独立源和目标文件都必须与收据哈希一致，当前源中的额外文件不会进入删除清单。
- 正式卸载必须提供 `--confirm`；所有待变更文件会先备份到结果中的 `.ai-harness/backups/<ID>/`。
- 备份后和每项变更前都会复核目标快照；内容漂移、冲突、版本不一致、篡改或路径异常会显式失败。
- 项目规则的非托管内容、业务文件、项目文档、`.ai-harness/work-items/` 和已有备份不会删除。
- 卸载后可重新运行 `install`；需要继续运行状态机时再执行 `init` 重建 `project.json`。

## 2. 工作类型与参数

运行任何 Runtime 命令前先判断规模：

| 规模 | 边界 | 执行方式 |
| --- | --- | --- |
| `TRIVIAL_READONLY` | 单一事实，可由直接读取或少量无副作用确定性命令回答 | 直接检查并报告；不运行 Runtime 命令，不创建工作项 |
| `TRIVIAL_EDIT` | 单文件机械修改，且不改变行为、API、Schema、依赖、配置、安全或发布 | 读取上下文、修改、运行一个最窄验证并报告；不运行 Runtime 命令 |
| `NON_TRIVIAL` | 其他工作，以及所有 BUG | 普通 ITERATION/BUGFIX 默认使用下述精简入口；复杂/高风险和其他类型使用完整流程 |

先读相关代码判断风险；影响仍不清楚时使用完整流程。禁止将同一目标拆成多个轻量任务规避门禁。删除、覆盖、Git 历史修改、部署、发布、生产数据、费用、外部消息和凭据变更的授权要求不因规模分类而改变。

仅 `NON_TRIVIAL` 先运行策略路由并完整读取返回文件：

```text
node .ai-harness/bin/harness.mjs policies --type <TYPE> [--flag <FLAG>] --json
```

标志可重复：`database`、`frontend`、`mobile`、`api`、`multi-agent`。
需要完整代码生成验证流水线时另加 `codegen`，使用完整工作流。

### 普通任务默认路径

边界明确、单 AI、单纵向任务、low/medium 风险且无数据库影响的迭代或 BUG，使用 `begin`。不按文件数限制任务；已有自主授权可用于整个目标，普通实现选择无需重复确认。`begin` 内置 `doctor`，无需再单独调用。以下为 PowerShell 示例，替换路径与命令后使用：

```powershell
node .ai-harness/bin/harness.mjs begin `
  --id ITER-001 --type ITERATION --title "完善本地输入校验" `
  --input "用户本次实现请求" --acceptance "有效输入保持兼容，错误输入有明确反馈" `
  --authorization-source "用户授权完成本地实现和验证" --risk low `
  --approach "沿用现有校验函数，补充目标边界处理与回归测试" `
  --database-evidence "只修改内存输入校验，不涉及持久化或查询" `
  --writes "src/validation/**" --writes "tests/validation.test.mjs" `
  --verify "node --test tests/validation.test.mjs" --docs "N/A: 原有约定不变" --json

# 完成范围内代码修改，执行实际验证并读取结果
node .ai-harness/bin/harness.mjs run --id ITER-001 --task T1 --json -- node --test tests/validation.test.mjs

# 审查完整差异后，引用上一步返回的证据 id；结论必须如实填写
node .ai-harness/bin/harness.mjs finish --id ITER-001 `
  --command "<成功命令证据ID>" --verification "目标回归和兼容输入验证通过" `
  --review "已检查根因、调用方与完整差异，未发现需要返工的问题" `
  --documentation "N/A: 原有约定仍正确" --acceptance "用户请求的验收条件均已验证" --json

node .ai-harness/bin/harness.mjs check --ci --json
```

`begin` 默认为 `autonomous`，必须有真实授权来源。`start` 的默认值仍为 `approval-required`，其参数和行为兼容旧版。BUGFIX 额外提供 `--actual`、`--expected`、`--reproduction`；精简入口可带局部 UI 的 `--flag frontend`，其余业务标志要求完整流程。

BUGFIX 保留远端引入的完整验证流水线。完成实际验证后，在上述 `finish` 命令中一次补充各阶段证据：

```text
--stage-evidence "static=实际静态检查结果"
--stage-evidence "sandbox=实际隔离编译执行环境与结果"
--stage-evidence "reproduction=原复现路径已转绿"
--stage-evidence "regression=受影响回归测试通过"
--stage-command "reproduction=<本任务成功的复现命令ID>"
--stage-command "regression=<本任务成功的回归命令ID>"
```

这是参数清单，追加到同一条 `finish` 命令；PowerShell 换行时仍需反引号。带 `frontend` 时还需 `--stage-evidence "browser=实际浏览器探针结果"`。Runtime 先检查全部必需阶段和命令引用，再按原流水线顺序登记；缺失时在更新结果前拒绝，不把普通测试推断为隔离或浏览器验证。同一个命令确实覆盖复现和回归时可复用其 ID。

方案保存在 `.ai-harness/work-items/<ID>/solution.md`，任务固定为 T1、审查批次 R1。`--verify` 提供实际验证命令，或包含 `command` / `args` 的 JSON 字符串；Runtime 编译为 V1、V2 等检查，不执行 shell 展开。可用 `run --id <ID> --task T1 --check V1` 直接执行计划，或通过原有透传方式执行完全匹配的命令。诊断命令可以留证，但不能代替未运行的计划检查。

也可以执行 `begin --spec task.json --json`，读取项目内UTF-8 JSON（允许BOM），避免路径列表和命令参数的shell转义。定义字段如下；授权来源与验收必须填写本次真实信息：

```json
{
  "schemaVersion": 1,
  "id": "ITER-001",
  "type": "ITERATION",
  "title": "实现输入校验",
  "references": ["TASK.md"],
  "acceptance": ["有效输入保持兼容，非法输入明确报错"],
  "authorizationSource": "用户本次明确授权实现TASK.md",
  "risk": "low",
  "approach": "复用现有校验入口并补边界测试",
  "databaseEvidence": "纯内存校验，无持久化影响",
  "writeScopes": ["src/validation.mjs", "tests/validation.test.mjs"],
  "verification": [{"command": "node", "args": ["--test", "tests/validation.test.mjs"]}],
  "docsImpact": ["N/A: 保持已记录契约"]
}
```

Schema位于 `.ai-harness/schemas/begin-spec.schema.json`。不与CLI任务定义参数混用，未知字段在创建前拒绝。旧CLI继续使用重复 `--writes` / `--verify`；疑似把多个完整路径拼成一个逗号字符串时会在创建前提示纠正。确为包含逗号的字面路径，可在JSON数组中明确保留为一个元素。`N/A：理由` 会规范化为 `N/A: 理由`。

新项使用策略路由版本2，确定无数据库影响且无显式database标志时不加载完整数据库细则；影响未知或required时仍加载。用 `policies --id <ID>` 查看实际列表。建项前已完成影响判断时可用 `policies --type ITERATION --database-impact none`；该参数不替代工作项中的正式判断。旧项沿用原路由，不改写历史记录。

一次执行本任务所有已声明检查可用 `run --id <ID> --task T1 --all --json`。检查逐条经过原权限与证据执行器；遇失败停止，响应的 `notRun` 列出未执行项。`--all` 不能与 `--check` 或透传命令混用。

`finish --command` 可以重复。所引证据必须属于当前任务、匹配计划签名和任务执行次数，并对应当前代码快照；验证过程中代码变化、验证后修改产品内容或出现新失败，都不能继续使用旧的通过结论。审查、文档、验收仍须是实际结论，Runtime 不从退出码推断业务语义。

新项目、数据库、公共 API、跨端、多 AI、高风险或需要逐步批准的任务使用下述完整流程。安全/权限、支付、并发、全局 UI/路由和破坏性影响也必须升级，不能以缺少业务标志为由归为低风险。

精简命令依次调用原有门禁，不是跨多个文件的原子事务。运行中断时保留真实阶段；用 `guide` 查看尚缺的实际结论，再调用 `finish` 继续。已经完成且绑定当前代码的结论不重复登记；省略 `--command` 时只复用本项当前通过的计划检查，未运行检查不会被自动补做。已到DONE的重复调用只核对冻结记录，不覆盖证据。需要返工时使用 `reopen`，需要调整计划时使用 `replan`；失败审查、旧代码证据或高风险任务不能通过恢复入口绕过。最终仍须通过 CI。

```powershell
node .ai-harness/bin/harness.mjs reopen --id ITER-001 --reason "修复最终审查发现的边界问题" --json
node .ai-harness/bin/harness.mjs task-update --id ITER-001 --task T1 --status IN_PROGRESS --json
# 修改后重新执行计划检查
node .ai-harness/bin/harness.mjs run --id ITER-001 --task T1 --check V1 --json

# 需要改变任务定义时，先保存旧计划并解除批准
node .ai-harness/bin/harness.mjs replan --id ITER-001 --reason "补充验证与写入范围" --json
node .ai-harness/bin/harness.mjs task-edit --id ITER-001 --task T1 --writes "src/validation/**" --writes "tests/validation.test.mjs" --verify "node --test tests/validation.test.mjs" --json
node .ai-harness/bin/harness.mjs plan-approve --id ITER-001 --approval-ref "已有范围内授权或实际新增批准" --json
node .ai-harness/bin/harness.mjs transition --id ITER-001 --to PLANNED --json
node .ai-harness/bin/harness.mjs transition --id ITER-001 --to IMPLEMENTING --json
```

旧状态和计划保留在工作项的 `revisions/`，当前验证、审查、验收全部失效。`approval-required` 的工作项必须给出真实 `--approval-ref` 才能返工。replan 保留现有技术和数据库设计；需要改变时在重新批准计划前通过 solution/database 更新。

### 新项目

```text
node .ai-harness/bin/harness.mjs start --id NEW-001 --type NEW_PROJECT --title "项目名称" \
  --input "已批准 PRD" --acceptance "端到端验收条件" \
  --architecture-source HUMAN_PROVIDED --architecture-approval "架构批准记录" \
  --authorization autonomous --authorization-source "端到端授权" --json
```

架构来源只能是 `HUMAN_PROVIDED` 或 `AI_RECOMMENDED`。默认文档版本为 `v1.0`。

### 版本迭代

```text
node .ai-harness/bin/harness.mjs start --id ITER-001 --type ITERATION --title "版本需求" \
  --input "批准 PRD/Issue" --acceptance "新旧行为验收" \
  --authorization autonomous --authorization-source "批准记录" --json
```

### BUG 修复

```text
node .ai-harness/bin/harness.mjs start --id BUG-001 --type BUGFIX --title "修复问题" \
  --input "Issue/日志" --acceptance "原复现路径恢复" \
  --actual "当前错误行为" --expected "既定正确行为" --reproduction "环境和复现步骤" \
  --authorization autonomous --authorization-source "修复授权" --json
```

一个根因修复可包含多个直接关联文件，作为一个任务；完成修复或审查返工后重新验证并 Code Review，不为每次保存文件重复运行全量检查。

### 项目分析

```text
node .ai-harness/bin/harness.mjs start --id ANALYSIS-001 --type ANALYSIS --title "分析问题" \
  --input "用户问题" --acceptance "结论有状态和证据" \
  --authorization approval-required --authorization-source "只读询问" --json
```

`ANALYSIS` 只允许控制面状态写入，不创建开发计划。

## 3. 开发型状态流

需要辅助判断下一步时，可在任意已创建的工作项阶段运行 `guide --id <ID> [--task <TASK_ID>] --json`。它提供当前目标、任务与证据、命令参数模板和需要实际判断的内容；不写状态、不执行命令。引导会沿用数据库设计、授权、验证流水线、任务依赖及独立审查门禁。具体使用和模型效果对照方法见[模型任务引导](model-guidance.md)。

按需增加 `--context` 会读取有界的明确源码、测试和公开文档，标记路径、哈希、截断与遗漏。普通已验证迭代还会提供 `shortcuts` 中的 `finish` 建议，需填真实审查和验收结论。实施中修正实现或自测后直接复验；需要整体 `reopen` 时，响应会列出重置后的任务状态与准确下一步，不能把 `READY` 当作 `IN_PROGRESS`。

### 基线与设计

```text
node .ai-harness/bin/harness.mjs transition --id <ID> --to BASELINING --json
node .ai-harness/bin/harness.mjs baseline --id <ID> --evidence "仓库/代码/文档基线" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to SOLUTION_DESIGN --json
node .ai-harness/bin/harness.mjs solution --id <ID> --document <SOLUTION_DOC> --evidence "业务、接口和查询写入设计" --json
```

无数据库影响：

```text
node .ai-harness/bin/harness.mjs database --id <ID> --impact none --evidence "无持久化或查询路径变化" --json
```

有数据库影响：

```text
node .ai-harness/bin/harness.mjs database --id <ID> --impact required --evidence "需要 Schema/查询变化" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to DATABASE_DESIGN --json
node .ai-harness/bin/harness.mjs database --id <ID> --impact required --complete \
  --document <DATABASE_DOC> --evidence "字段、查询、索引、事务和迁移已设计" --json
```

`required` 未完成时，Runtime 拒绝创建计划和进入 `PLANNED`。

### 计划

```text
node .ai-harness/bin/harness.mjs plan-init --id <ID> --mode single --rationale "模块存在连续依赖" --json
node .ai-harness/bin/harness.mjs batch-add --id <ID> --batch R1 --title "业务模块" --risk medium --json
node .ai-harness/bin/harness.mjs task-add --id <ID> --task T1 --title "纵向任务" --module <MODULE> \
  --writes "src/module/**" --verify "npm test" --docs "docs/相关文档.md" \
  --batch R1 --risk medium --owner primary-ai --json
node .ai-harness/bin/harness.mjs plan-approve --id <ID> --approval-ref "计划批准或端到端授权" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to PLANNED --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to IMPLEMENTING --json
```

任务依赖通过重复 `--blocked-by` 声明。`multi` 计划必须在创建工作项时带 `--flag multi-agent`，至少包含两个不同所有者，且无依赖的并行任务写入范围不得重叠。

### 自动实施、任务验证和 Review

计划批准后连续推进所有可执行任务，不逐项询问。阻塞任务使用 `BLOCKED` 并提供原因；不依赖它的任务继续。

```text
node .ai-harness/bin/harness.mjs task-update --id <ID> --task T1 --status IN_PROGRESS --json
node .ai-harness/bin/harness.mjs run --id <ID> --task T1 --json -- <COMMAND> [ARGS...]
node .ai-harness/bin/harness.mjs record --id <ID> --task T1 --kind verification --status pass --evidence "命令事件和结果" --json
node .ai-harness/bin/harness.mjs task-update --id <ID> --task T1 --status IMPLEMENTED --json
node .ai-harness/bin/harness.mjs task-update --id <ID> --task T1 --status IN_REVIEW --json
node .ai-harness/bin/harness.mjs record --id <ID> --task T1 --kind review --status pass --evidence "审查范围和结论" --json
node .ai-harness/bin/harness.mjs task-update --id <ID> --task T1 --status COMPLETED --json
```

`--json` 必须位于命令分隔符 `--` 之前。高风险 Review Batch 创建时添加 `--independent-required`，最终工作项 Review 使用 `--independent` 记录独立复核。

### 工作项完成

```text
node .ai-harness/bin/harness.mjs transition --id <ID> --to VERIFYING --json
node .ai-harness/bin/harness.mjs record --id <ID> --kind verification --status pass --evidence "完整验证结果" --json
node .ai-harness/bin/harness.mjs record --id <ID> --kind documentation --status pass --evidence "文档同步结果" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to CODE_REVIEW --json
node .ai-harness/bin/harness.mjs record --id <ID> --kind review --status pass --evidence "最终差异审查" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to READY_FOR_ACCEPTANCE --json
node .ai-harness/bin/harness.mjs record --id <ID> --kind acceptance --status pass --evidence "有权验收记录" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to DONE --json
node .ai-harness/bin/harness.mjs check --ci --json
```

无文档影响时使用 `documentation --status not-applicable`，但仍需给出理由。`check --ci` 拒绝所有非 `DONE`/`ANSWERED` 工作项；该命令是非琐碎工作项和合并前门禁，不用于轻量任务的局部结果报告。

上述工作项 verification 单条记录适用于普通 ITERATION。BUGFIX 或带 codegen 标志时，应改为按 `.ai-harness/policies/verification.md` 及 `bugfix.md` 的适用阶段逐段 `record --kind verification --stage <stage>`；复现/回归还需 `--command <ID>`。精简 BUGFIX 的 finish 会完成同样的顺序登记。

## 4. 分析型状态流

```text
node .ai-harness/bin/harness.mjs transition --id <ID> --to BASELINING --json
node .ai-harness/bin/harness.mjs baseline --id <ID> --evidence "检出代码、配置、Schema 和测试入口" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to ANALYZING --json
node .ai-harness/bin/harness.mjs analysis-add --id <ID> --status PROVEN --conclusion "已证实结论" --evidence "文件:行或命令结果" --json
node .ai-harness/bin/harness.mjs analysis-add --id <ID> --status UNKNOWN --conclusion "无法确认事项" --unknown "不可访问的环境或证据" --json
node .ai-harness/bin/harness.mjs record --id <ID> --kind analysis --status pass --evidence "回答已区分事实、推断、建议和未知" --json
node .ai-harness/bin/harness.mjs transition --id <ID> --to ANSWERED --json
```

结论状态为 `PROVEN`、`INFERRED`、`PROPOSAL` 或 `UNKNOWN`。除 `UNKNOWN` 外必须提供证据。

### 验收项与检查对应

从 `1.3.0` 起，结构化验证命令可添加 `acceptance` 数组，引用工作项验收条件按顺序生成的 `A1`、`A2` 等编号：

```json
{"command":"node","args":["--test","tests/validation.test.mjs"],"acceptance":["A1","A2"]}
```

该对象可放入 `begin --spec` 的 `verification` 数组，或作为 `--verify` 的 JSON 字符串。启用映射后，建项预检/计划批准要求所有验收项有对应检查且编号有效。映射参与计划签名，修改后需要重新验证。未提供映射的旧工作项保持原行为；`guide.coverage` 展示对应关系。Runtime 只校验声明与证据归属，测试断言能否保护业务意图仍需审查。

### 验证产物

在实际执行和阅读结果后，可通过原有 `record` 入口附加本地产物：

```powershell
node .ai-harness/bin/harness.mjs record --id ITER-001 --task T1 `
  --kind verification --status pass --evidence "说明实际检查及其边界" `
  --artifact .ai-harness/work-items/ITER-001/test-output.txt `
  --artifact-source "实际执行工具或 CI 运行地址" --json
```

最多8个普通文件，每个最多16 MiB；需要来源说明。Runtime 将内容保存为工作项内按 SHA-256 命名的副本，证据保存 `version/path/sha256/bytes/source`。重新生成原文件不会改写已归档证据；副本丢失、越界或哈希变化会被验证/CI拒绝。路径不得经过链接或指向凭据/Git元数据。`source` 是调用方的来源声明，不是远端执行证明或独立复核凭证。产物也不替代既有复现/回归的真实命令要求。

新可选字段要求使用 1.3.0 或更新的 Runtime 校验；历史记录不补写或重新解释。`run.command.timing` 分开记录准备、实际执行及证据准备，观测截至最终追加证据前，不包括进程启动和最后的持久化；完整 CLI 区间由客户端事件计时。原 `durationMs` 语义保持不变。

工作项证据按原始字节计算哈希。随 Runtime 安装的 `.ai-harness/.gitattributes` 对默认 `work-items/**` 禁用 Git 文本转换，使 LF、CRLF 和二进制产物在提交及跨平台检出后保持不变。使用自定义工作项目录时，应在该目录的 Git 属性中设置同等保护。已被换行转换破坏的旧工作副本应从可信提交重新检出，不修改证据哈希来迁就变化后的内容。

### 锁诊断与恢复

```powershell
node .ai-harness/bin/harness.mjs lock-status --id ITER-001 --json
# 仅当状态为 stale，使用上一步 owner.token 和实际中断原因
node .ai-harness/bin/harness.mjs lock-recover --id ITER-001 --token '<owner.token>' --reason '实际中断原因' --json
```

新锁携带版本、主机、PID 和随机代次标识。恢复只针对本机进程已不存在且 token 匹配的锁；仅凭经过时间不回收，PID 已被复用也会保守拒绝。恢复先认领锁并保留排他性，验证状态、计划及事件/证据日志完整性，成功后才记录恢复事件并释放。正常释放先整体移走锁目录，清理中断留下的 `.tmp` 目录不阻塞后续工作。

旧文件锁为 `legacy`；未知、存活和异地主机锁不能自动回收。本机制面向单机本地文件系统，不能据此证明共享盘或跨容器 PID 命名空间的所有权。遇 `LOCK_STATE_INCONSISTENT` 时保留原记录和认领锁，退出非零；不会拼接损坏日志、编造 pass 或自动修复部分写入。需先保留现场并从已验证备份/提交恢复完整控制面，再继续正常流程，不手工补造状态。恢复锁不等于业务操作、验证或验收已经完成。

## 5. 命令与退出码

```text
node .ai-harness/bin/harness.mjs guard -- <COMMAND> [ARGS...]
```

- `0`：命令判定为 `allow`，或普通命令成功。
- `1`：参数、结构、状态门禁、`doctor`/`check` 或 Runtime 执行失败。
- `2`：`guard` 判定为 `ask`，Harness 不执行。
- `3`：`guard` 判定为 `deny`，Harness 不执行。
- `run` 成功执行后返回子进程退出码。

`run` 使用 `shell:false`，只允许验证型命令；显式可执行文件路径除当前 Node 运行时外默认 `ask`。依赖安装、Git 写入、部署和发布需要在 Runtime 外取得明确授权，之后将结果作为证据记录。

## 6. CI

仓库自带 GitHub Actions 示例：

```text
node .ai-harness/tests/run.mjs
node .ai-harness/bin/harness.mjs doctor --json
node .ai-harness/bin/harness.mjs check --ci --json
```

其他 CI 平台调用相同命令即可。CI 是合并门禁，不替代客户端权限、代码托管分支保护或人工独立复核。

Harness 源仓库另有 `source-tests.yml`：Windows/Linux 执行评测框架测试，Windows 执行 Runtime 回归；Linux Runtime 仍由标准工作流覆盖。源仓库专用工作流不会复制到目标项目，测试不会调用真实模型。

CI 检出需保留完整 Git 历史（GitHub Actions 示例使用 `fetch-depth: 0`），以确定旧终态记录的真实归档提交。新工作项保存交付内容快照；历史范围不再授权新的修改，合法分析控制面单独处理。

代码快照基于 Git 跟踪及未忽略文件，包含删除、重命名、配置与测试，排除工作项控制面；暂存不会改变等价内容的标识。被忽略文件、外部服务和环境变化不属于代码快照，必要时应增加实际环境验证。未冻结的子模块变更会明确失败。

同一项目根目录通过 Windows 短路径或目录别名访问时，Runtime 会统一根目录表示后生成相对文档、快照和日志引用。根目录内部的符号链接/联接仍按原写入规则拒绝，不会因路径规范化而获得额外权限。
