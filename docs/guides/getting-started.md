# 用户使用指南

本指南面向第一次使用 AI Harness Runtime 的项目负责人和开发者，覆盖从 GitHub 获取、接入项目、交给 AI 开发、升级和故障处理。完整状态命令与参数见[安装与工作流手册](usage.md)。

## 1. 先理解两个目录

- **Harness 源仓库**：从 GitHub 下载的 `my-harness`，只作为安装源和升级源。
- **目标项目**：真正要开发的新项目或已有项目，Runtime 会被复制到这里。

不要把业务项目代码写进 Harness 源仓库。安装完成后，AI 应在目标项目目录中工作。

## 2. 环境要求

| 工具 | 要求 | 检查命令 |
| --- | --- | --- |
| Node.js | 20 或更高版本 | `node --version` |
| Git | 可执行，并建议已配置提交身份 | `git --version` |
| AI 客户端 | 能读取仓库规则文件 | Codex、Claude Code、Gemini CLI 等 |

Harness 仅使用 Node.js 标准库，不会修改目标项目的依赖清单。

## 3. 获取 Harness

推荐使用 Git，便于后续升级：

```powershell
$HarnessRepo = "D:\Tools\my-harness"

git clone https://github.com/404NotFoundYou/my-harness.git $HarnessRepo
```

如果仓库是私有的，需要先在 Git Credential Manager、SSH 或其他 GitHub 认证方式中登录有访问权限的账号。

如果已经克隆：

```powershell
git -C $HarnessRepo pull --ff-only
```

也可以从 GitHub 下载 ZIP 并解压，然后把 `$HarnessRepo` 指向解压目录。ZIP 方式不能使用 `git pull`，升级时需要重新下载。

## 4. 接入已有项目

### 4.1 设置路径

```powershell
$HarnessRepo = "D:\Tools\my-harness"
$TargetProject = "D:\Projects\your-project"
```

如果目标项目已经使用 Git，安装前先确认当前状态，避免把已有未提交修改误认为安装结果；尚未使用 Git 时跳过本命令：

```powershell
git -C $TargetProject status --short
```

### 4.2 可选预检

```powershell
node "$HarnessRepo\.ai-harness\bin\harness.mjs" install `
  --target $TargetProject --dry-run --json
```

常见操作类型：

| `action` | 含义 |
| --- | --- |
| `create` | 目标文件不存在，将创建 |
| `merge` | 保留已有规则并追加 Harness 托管块 |
| `skip` | 文件相同或已有兼容导入，不改写 |
| `update-managed` | 只升级已有托管块 |
| `conflict` | 普通 Runtime 文件内容不同，正式安装会失败 |

`dry-run` 不写入文件。报告中的 `conflictReviewRequired` 表示后续需要审查规则语义是否冲突，不表示需要手工拼接文件。

### 4.3 正式安装

```powershell
node "$HarnessRepo\.ai-harness\bin\harness.mjs" install `
  --target $TargetProject --json
```

已有 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 会保留原文。安装器只追加或更新带版本和哈希的托管块；已有 `@AGENTS.md` 或 `@./AGENTS.md` 兼容导入时不会改写适配器。

### 4.4 首次初始化

进入目标项目。如果它还不是 Git 仓库，先初始化 Git：

```powershell
Set-Location $TargetProject

if (-not (Test-Path .git)) {
  git init
}
```

仅在 `.ai-harness/project.json` 不存在时运行：

```powershell
node .ai-harness/bin/harness.mjs init `
  --mode existing --docs existing --json

node .ai-harness/bin/harness.mjs doctor --json
```

`existing` 文档模式会沿用项目现有目录和命名，不会生成另一套默认文档结构。初始化后按项目原有 Git 流程提交 Harness 和项目基线；存在其他未提交修改时不要直接使用无范围的 `git add .`。

## 5. 接入新项目

```powershell
$HarnessRepo = "D:\Tools\my-harness"
$TargetProject = "D:\Projects\new-project"

New-Item -ItemType Directory -Force $TargetProject

node "$HarnessRepo\.ai-harness\bin\harness.mjs" install `
  --target $TargetProject --json

Set-Location $TargetProject
git init

node .ai-harness/bin/harness.mjs init `
  --mode new --docs default --json

node .ai-harness/bin/harness.mjs doctor --json
```

新项目会生成默认 `v1.0` 文档结构。填写模板中的 `HARNESS:REQUIRED` 项后建立初始提交：

```powershell
git add .
git commit -m "chore: initialize project with AI harness"
```

## 6. 日常怎样使用

正常情况下，你不需要手工逐条执行状态命令。打开目标项目，让 AI 读取仓库规则，然后直接给出任务和授权边界。AI 会先判断任务规模：

| 路径 | 典型请求 | 实际流程 |
| --- | --- | --- |
| `TRIVIAL_READONLY` | “当前分支是什么”“读取这个版本号” | 直接运行必要的只读检查并回答，不调用 Runtime |
| `TRIVIAL_EDIT` | “修正 README 中这一处错别字” | 读取目标文件、机械修改、运行一个最窄验证，不调用 Runtime |
| `NON_TRIVIAL` | 功能开发、BUG、技术分析、多文件修改或任何高风险变化 | 自动创建工作项并完成适用的设计、计划、实施、验证和 Review |

如果一个任务涉及业务行为、API、Schema、依赖、配置、安全、发布、外部副作用，或需要持续调查和方案裁量，它就不是轻量任务。分类不确定时走完整流程；不能把一个目标拆成多次单文件修改来规避门禁。

### 新项目示例

```text
根据 docs/requirements/product-v1.md 开发新项目。
架构由你基于 PRD 推荐，验收条件是文档中的全部业务场景通过。
允许按批准计划连续实施，不需要逐任务询问；发布和生产操作仍需单独确认。
```

### 版本迭代示例

```text
根据 docs/requirements/v1.1.md 完成版本迭代。
沿用当前架构和文档结构，先分析数据库影响并生成计划，然后连续实施到验证和 Code Review 完成。
```

### BUG 修复示例

```text
修复 Issue #123。实际行为是提交后重复创建订单，期望行为是相同请求只创建一次。
复现环境和步骤见 Issue。请先复现和定位根因，最小修改，完成回归验证和 Code Review。
```

### 项目分析示例

```text
分析当前项目的登录权限是如何实现的。以当前代码、配置、数据库迁移和测试为证据，区分已证实、推断、建议和未知，不要修改业务代码。
```

## 7. 工作类型和业务标志

每个非琐碎任务只能选择一个主类型：

| 类型 | 适用场景 |
| --- | --- |
| `NEW_PROJECT` | 从零创建新项目 |
| `ITERATION` | 在已有项目中开发新版本或功能 |
| `BUGFIX` | 修复可描述实际行为、期望行为和复现路径的问题 |
| `ANALYSIS` | 回答业务实现或技术方案问题，不修改业务代码 |

业务标志可以组合：

| 标志 | 何时使用 |
| --- | --- |
| `database` | 涉及表、字段、查询、索引、事务或迁移 |
| `frontend` | 涉及 Web UI、Figma、交互或视觉还原 |
| `mobile` | 涉及移动端或跨平台能力 |
| `api` | 涉及接口、鉴权、错误码或兼容性 |
| `multi-agent` | 业务模块可拆分且写入范围能够隔离 |

## 8. 人工检查和审计

以下命令适合项目负责人检查状态：

```powershell
# Runtime、规则、Git 和初始化状态
node .ai-harness/bin/harness.mjs doctor --json

# 工作项列表
node .ai-harness/bin/harness.mjs list --json

# 单个工作项状态和计划
node .ai-harness/bin/harness.mjs show --id <WORK_ITEM_ID> --json

# 合并前最终门禁
node .ai-harness/bin/harness.mjs check --ci --json
```

只有非琐碎工作项达到 `DONE` 或 `ANSWERED`，且 `check --ci` 返回 `ok: true`，才能声明完整工作项完成。轻量任务不创建工作项，也不为一次局部操作运行仓库级 CI 门禁。

## 9. 升级 Harness

先更新安装源，再重新执行幂等安装：

```powershell
git -C D:\Tools\my-harness pull --ff-only

node D:\Tools\my-harness\.ai-harness\bin\harness.mjs install `
  --target D:\Projects\your-project --dry-run --json

node D:\Tools\my-harness\.ai-harness\bin\harness.mjs install `
  --target D:\Projects\your-project --json

Set-Location D:\Projects\your-project
node .ai-harness/bin/harness.mjs doctor --json
```

升级时不要再次运行 `init`。重复安装不会重复追加托管块，目标项目自己的规则也不会传播到其他项目。

## 10. 卸载 Harness

推荐从 Harness 源仓库执行。先运行只读预检，再显式确认正式卸载：

```powershell
$HarnessRepo = "D:\Tools\my-harness"
$TargetProject = "D:\Projects\your-project"

node "$HarnessRepo\.ai-harness\bin\harness.mjs" uninstall `
  --target $TargetProject --dry-run --json

node "$HarnessRepo\.ai-harness\bin\harness.mjs" uninstall `
  --target $TargetProject --confirm --json
```

不能使用目标项目内的 Runtime 自卸载，因为同一份文件无法提供可信内容对比；命令会返回 `UNINSTALL_SOURCE_EQUALS_TARGET`。卸载源版本必须与目标一致。

卸载行为：

- 安装时写入 `.ai-harness/install-receipt.json`，记录实际 Runtime/CI payload 哈希与托管规则边界；卸载不根据当前源目录猜测删除清单。
- 移除收据记录且源/目标内容都匹配的 Runtime 文件、标准 GitHub Actions 入口、安装收据、`.ai-harness/project.json` 和结构/哈希/边界有效的托管规则块。
- 保留托管块外的项目规则、业务代码、项目文档、`.ai-harness/work-items/` 和已有备份。
- 先把所有待变更文件复制到结果中的 `.ai-harness/backups/<ID>/`，备份后和每项变更前复核目标快照；执行失败会回滚。
- Runtime/CI 内容冲突、版本不一致、托管块篡改或路径类型异常时，正式卸载在写入前失败。

因此卸载后 `.ai-harness/` 可能仍存在，只包含保留的工作项和备份。这不是卸载失败。要恢复 Runtime，重新执行 `install`；需要继续运行 Harness 时再执行 `init` 重建 `project.json`。

## 11. 冲突、备份和恢复

| 错误码 | 处理方式 |
| --- | --- |
| `INSTALL_CONFLICT` | 查看 `--dry-run` 报告；确认普通 Runtime 文件为何不同，不要直接覆盖未知修改 |
| `UNINSTALL_CONFIRMATION_REQUIRED` | 正式卸载缺少 `--confirm`；先运行 `--dry-run` 审查删除计划 |
| `UNINSTALL_CONFLICT` | Runtime 或 CI 文件与卸载源不一致；先审查目标修改，并使用内容匹配的独立 Harness 源仓库 |
| `UNINSTALL_VERSION_MISMATCH` | 卸载源与目标版本不同；改用与目标版本一致的独立 Harness 源仓库 |
| `UNINSTALL_SOURCE_EQUALS_TARGET` | 正在用目标项目自身 Runtime 卸载；改从独立 Harness 源仓库执行 |
| `UNINSTALL_RECEIPT_REQUIRED` | 旧安装缺少安装收据；先从可信且内容匹配的源重新执行安装 |
| `UNINSTALL_RECEIPT_INVALID` | 安装收据结构或自校验哈希无效；停止卸载并审查收据来源 |
| `UNINSTALL_SOURCE_MISMATCH` | 独立源缺少收据文件或内容哈希不同；切换到安装时对应的源版本 |
| `UNINSTALL_TARGET_CHANGED` | 目标在预检、备份或应用前发生变化；审查并重新运行预检 |
| `UNINSTALL_ROLLED_BACK` | 应用失败且已完整恢复；根据错误原因修复后重新预检 |
| `UNINSTALL_ROLLBACK_FAILED` | 应用失败且回滚不完整；按错误详情中的备份路径人工恢复 |
| `MANAGED_BLOCK_MODIFIED` | 托管块内容被手工修改；确认块外规则已保留后，可用 `--force` 修复块 |
| `MANAGED_BLOCK_BOUNDARY_MODIFIED` | 托管块相邻边界与安装收据不一致；停止卸载并审查非托管内容 |
| `MANAGED_BLOCK_MALFORMED` | 标记缺失、重复或不独占一行；从 Git 或安装备份恢复，`--force` 不会猜测边界 |
| `ROOT_INSTRUCTIONS_TOO_LARGE` | 精简根规则，将模块专属规则下沉到对应目录，之后重新安装 |
| `PROJECT_INITIALIZED` | 项目已经初始化；升级只运行 `install`，不要重复运行 `init` |
| `ROOT_NOT_FOUND` | 当前目录不是已安装项目；切换到包含 `.ai-harness/manifest.json` 的目标项目 |

修改已有文件时，安装结果的 `backup` 字段会返回备份目录，例如 `.ai-harness/backups/<ID>/`。恢复前先对比目标文件和备份，避免覆盖安装后的其他修改。

## 12. CI 门禁

安装器会复制 `.github/workflows/ai-harness.yml`。GitHub Actions 将执行：

```text
node .ai-harness/tests/run.mjs
node .ai-harness/bin/harness.mjs doctor --json
node .ai-harness/bin/harness.mjs check --ci --json
```

其他 CI 平台调用相同命令即可。CI 不能替代 AI 客户端自身的权限和沙箱配置。

## 13. 下一步

- 查看[完整 CLI 工作流](usage.md)，了解状态推进、计划、任务、验证和 Review 命令。
- 查看[架构概览](../architecture/overview.md)，了解 Runtime 边界和无损接入设计。
- 查看[版本验证记录](../versions/v1.0/VERIFICATION.md)，了解已验证能力和剩余边界。
