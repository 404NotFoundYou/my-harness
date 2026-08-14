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

## 2. 工作类型与参数

先运行策略路由并完整读取返回文件：

```text
node .ai-harness/bin/harness.mjs policies --type <TYPE> [--flag <FLAG>] --json
```

标志可重复：`database`、`frontend`、`mobile`、`api`、`multi-agent`。

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

BUG 每个任务的批次大小应为 1；每次修改或返工后重新验证并 Code Review。

### 项目分析

```text
node .ai-harness/bin/harness.mjs start --id ANALYSIS-001 --type ANALYSIS --title "分析问题" \
  --input "用户问题" --acceptance "结论有状态和证据" \
  --authorization approval-required --authorization-source "只读询问" --json
```

`ANALYSIS` 只允许控制面状态写入，不创建开发计划。

## 3. 开发型状态流

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
  --writes "src/module/**" --verify "项目测试命令" --docs "docs/相关文档.md" \
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

无文档影响时使用 `documentation --status not-applicable`，但仍需给出理由。`check --ci` 拒绝所有非 `DONE`/`ANSWERED` 工作项。

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
