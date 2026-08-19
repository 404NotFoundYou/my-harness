# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> 上面的 `@AGENTS.md` 导入是**唯一事实源**（AI 治理运行时契约）。请勿在本文件中复制或改写那些规则——AGENTS.md 明确禁止形成「第二套事实源」。
> 以下内容仅补充 AGENTS.md 未覆盖的部分：**如何开发 harness 本仓库自身**。AGENTS.md 是给「接入方项目」用的运行时契约，不含本仓库的构建/测试/架构说明。

## 本仓库是什么

这是 **AI Harness Runtime 的源仓库**（发布物本身），不是一个被 harness 治理的业务项目。它把 `AGENTS.md` 的规则落地为一个**零依赖、纯 Node.js 标准库**的 CLI，通过结构化工作项 + 确定性状态门禁 + 命令策略 + 证据记录 + CI 拒绝条件来强制执行 AI 开发流程。

- 运行要求：Node.js 20+、Git。**不得引入任何 npm 依赖**（见 `docs/architecture/decisions/0001-portable-zero-dependency-node.md`）——所有源码均为 `.mjs` ES module，只 import `node:*`。
- 该约束是架构决策，不是偶然：新增功能时用标准库实现，不要 `npm install`。

## 常用命令

```bash
# 运行全部测试（node --test 跑 .ai-harness/tests/*.test.mjs）
node .ai-harness/tests/run.mjs

# 运行单个测试文件
node --test .ai-harness/tests/workflow.test.mjs

# 自检 runtime / 适配器 / Git / 初始化状态
node .ai-harness/bin/harness.mjs doctor --json

# CI 门禁：校验所有工作项状态、门禁证据、Git 写入范围（非 DONE/ANSWERED 即失败）
node .ai-harness/bin/harness.mjs check --ci --json

# 查看 CLI 全部命令
node .ai-harness/bin/harness.mjs help
```

CI 由 `.github/workflows/ai-harness.yml` 触发，本质是跑上面的 `tests/run.mjs` + `doctor` + `check --ci`。改动源码后这三条是最小验证集。

## 代码架构

CLI 入口 `.ai-harness/bin/harness.mjs` 转发到 `.ai-harness/src/`。核心分层（大图，需跨文件阅读才能理解）：

- **`cli.mjs`** — 参数解析 + 命令分发。每个子命令是一层薄封装，调用 `workflow.mjs`/`checker.mjs`/`installer.mjs`/`evidence.mjs`。`--` 之后为透传命令（供 `guard`/`run`）。
- **`workflow.mjs`** — 工作项生命周期的**唯一写入路径**：创建、基线、技术设计、数据库决策、计划/任务、状态迁移、记录结果。所有工作项状态都落在 `.ai-harness/work-items/<ID>/` 下的 `state.json`、`plan.json`、`events.jsonl`、`evidence.jsonl`。**禁止绕过 CLI 直接编辑这些文件**——校验器会拒绝。
- **`constants.mjs`** — 状态机的真相：`WORK_STATUSES`、`TASK_STATUSES`、`BASE_TRANSITIONS`、`TASK_TRANSITIONS`、终态集合。改状态流转从这里开始。
- **`validator.mjs`** — 纯函数门禁：工作项/计划 shape 校验、状态迁移是否允许（`assertTransitionAllowed`）、迁移门禁证据是否齐全（`assertTransitionGates`）、任务依赖与写入范围（`fileMatchesScope`）。这是「确定性拒绝非法状态」的核心。
- **`checker.mjs`** — `doctor`（环境自检）与 `check`（聚合校验所有工作项 + Git 写入范围 + CI 门禁）。
- **`policy.mjs`** — `classifyCommand` 把命令判为 `allow`/`ask`/`deny`（基于可执行名白/灰/黑名单 + 危险文本模式，如 `git reset --hard`）。`shell:false`，绝不拼 shell 字符串。
- **`evidence.mjs`** — `runRecordedCommand` 只执行 `allow` 命令，记录退出码/时长/脱敏输出/截断/哈希；`redact` 负责敏感信息脱敏。
- **`installer.mjs`** — `install`/`uninstall`/`init`。把 runtime payload 复制进目标项目，用 **managed-block** 机制无损合并已有 `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`；卸载严格按 `install-receipt.json` 逐项核验回滚。
- **`managed-block.mjs`** — 在既有指令文件末尾维护带版本 + SHA-256 的托管块，保证幂等安装与升级、且不覆盖托管块外的项目规则。
- **`model.mjs`** — 工作项/计划/任务/Review Batch 的构造函数（数据形状定义）。
- **`filesystem.mjs`** / **`git.mjs`** — 原子写、JSONL 追加、文件锁、项目根定位；Git 基线与指纹。
- **`errors.mjs`** — `HarnessError` + `invariant`，全程用错误码而非裸字符串。

### 策略路由（`.ai-harness/policies/`）

`policies/index.json` 把「工作类型 + 业务标志」确定性映射到策略 markdown（`always` 始终加载 core/security/documentation；`byType` 按 NEW_PROJECT/ITERATION/BUGFIX/ANALYSIS；`byFlag` 按 database/frontend/mobile/api/multi-agent）。`policies` 命令读此索引，**不用模型做路由**（AGENTS.md 不可削弱原则第 5 条）。

### Schemas（`.ai-harness/schemas/`）

`work-item.schema.json`、`plan.schema.json`、`evidence.schema.json` 定义持久化结构；`validator.mjs` 是它们的执行者。改动数据形状时三处（schema / model / validator）要同步。

## 修改本仓库时的要点

- 状态机/门禁改动：`constants.mjs`（转移表）→ `validator.mjs`（门禁断言）→ 对应 `tests/*.test.mjs`，三者必须一致。
- 命令策略改动：`policy.mjs` 的白/灰/黑名单与 `DENY_TEXT_PATTERNS`，配套 `policy.test.mjs`。
- 测试写在 `.ai-harness/tests/`，用内置 `node:test` + `node:assert`（无第三方测试框架）。
