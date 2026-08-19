# AI Harness Runtime

可复制到新项目或已有项目的仓库内 AI 开发治理 Runtime。它将 `AGENTS.md` 的关键规则落实为结构化工作项、确定性状态门禁、任务依赖、命令策略、证据记录和 CI 拒绝条件。

- 当前版本：`1.0.0`
- 运行要求：Node.js 20+、Git
- 依赖：仅 Node.js 标准库，不修改目标项目依赖清单
- 用户使用指南：[docs/guides/getting-started.md](docs/guides/getting-started.md)
- 完整 CLI 工作流：[docs/guides/usage.md](docs/guides/usage.md)
- 设计与版本记录：[docs/README.md](docs/README.md)

## 安装到目标项目

实际接入只需一条 `install` 命令；`--dry-run` 是可选的只读预检：

```powershell
$HarnessRepo = "D:\Tools\my-harness"
$TargetProject = "D:\Projects\your-project"

node "$HarnessRepo\.ai-harness\bin\harness.mjs" install --target $TargetProject --dry-run --json
node "$HarnessRepo\.ai-harness\bin\harness.mjs" install --target $TargetProject --json
Set-Location $TargetProject
```

已有 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 会保留原文，并在文件末尾增加带版本和 SHA-256 的 Harness 托管块；已有兼容导入 `@AGENTS.md` 或 `@./AGENTS.md` 的适配器保持字节不变。重复安装不会重复追加，升级只更新托管块。所有被修改的已有文件会先备份到命令返回的 `.ai-harness/backups/<ID>/`。

其他 Runtime/CI 文件内容不同时仍默认失败，并保证预检阶段不写入。`--force` 只用于修复结构完整但内容被修改的托管块，或在明确授权后替换普通冲突文件；它不会覆盖托管块外的项目规则。标记损坏、重复或合并后 `AGENTS.md` 超过大小上限时，即使使用 `--force` 也会失败。

## 安全卸载

卸载前先预览，正式执行必须显式确认：

```powershell
node "$HarnessRepo\.ai-harness\bin\harness.mjs" uninstall --target $TargetProject --dry-run --json
node "$HarnessRepo\.ai-harness\bin\harness.mjs" uninstall --target $TargetProject --confirm --json
```

命令必须从独立 Harness 源仓库执行，不能使用目标项目内的 Runtime 自卸载；卸载源版本必须与目标版本一致。

安装会生成 `.ai-harness/install-receipt.json`，记录实际 payload 路径、哈希和托管规则边界。卸载只按该收据逐项核验和移除，并在备份后、每次变更前复核目标快照；源或目标漂移时停止。

卸载会先备份再移除 Runtime、标准 CI、安装收据、初始化元数据和有效的 Harness 托管块。项目规则、业务文件、项目文档、`.ai-harness/work-items/` 与已有 `.ai-harness/backups/` 保留；目标内容冲突或托管块被修改时，在删除任何文件前失败。旧安装缺少收据时，先从可信源重新执行安装，再运行卸载。

## 初始化

新项目会创建可迭代的 `v1.0` 文档模板：

```powershell
git init
node .ai-harness/bin/harness.mjs init --mode new --docs default --json
# 填写模板中的 HARNESS:REQUIRED 项
git add .
git commit -m "initialize project and AI harness"
node .ai-harness/bin/harness.mjs doctor --json
```

已有项目沿用现有文档结构。`install` 已完成 Runtime 与规则接入；`init` 只记录项目模式，不再要求人工合并规则：

```powershell
node .ai-harness/bin/harness.mjs init --mode existing --docs existing --json
node .ai-harness/bin/harness.mjs doctor --json
```

开发型工作建立基线前必须已有 Git 提交，否则无法可靠计算后续写入范围。`init --force` 只重建项目元数据，不代表授权重建现有文档。

## 开始工作

先判断任务规模。单一事实或无副作用确定性查询直接执行；不改变行为、API、Schema、依赖、配置、安全或发布的单文件机械修改，直接修改并运行一个最窄验证。这两类轻量任务不运行 Runtime 命令、不创建工作项。

其他任务以及所有 BUG 都属于非琐碎工作，先解析策略，再创建唯一工作项：

```powershell
node .ai-harness/bin/harness.mjs policies --type ITERATION --flag api --json
node .ai-harness/bin/harness.mjs start `
  --id ITER-001 --type ITERATION --title "实现批准需求" `
  --input "docs/requirements/approved.md" --acceptance "验收场景通过" `
  --authorization autonomous --authorization-source "用户端到端授权" `
  --flag api --json
```

后续通过 CLI 推进基线、技术设计、数据库决策、计划、任务、验证、Code Review 和验收。完整命令见[使用指南](docs/guides/usage.md)。

## AI 代码生成验证流水线

声明 `codegen` 标志的工作项，`VERIFYING` 必须逐段通过有序验证流水线，Runtime 才允许进入 `CODE_REVIEW`：

```powershell
node .ai-harness/bin/harness.mjs record --id ITER-001 --kind verification --stage static   --status pass --evidence "node --check 通过；静态安全扫描 0 项"
node .ai-harness/bin/harness.mjs record --id ITER-001 --kind verification --stage sandbox  --status pass --evidence "隔离环境编译+执行，退出码 0"
node .ai-harness/bin/harness.mjs record --id ITER-001 --kind verification --stage contract --status pass --evidence "功能与接口契约断言全通过"
node .ai-harness/bin/harness.mjs record --id ITER-001 --kind verification --stage eval     --status pass --evidence "LLM Judge 语义与回归判定通过（附理由/引用）"
node .ai-harness/bin/harness.mjs record --id ITER-001 --kind verification --stage browser  --status pass --evidence "浏览器实体探针跑通核心用户流"
```

子阶段固定有序 `static → sandbox → contract → eval → browser`；乱序、缺段或聚合状态与证据不一致都会被确定性拒绝。`browser` 在工作项同时带 `frontend` 标志时必需（app 可打成 H5，UI 必须在真实浏览器探针下跑通）。Runtime 只编排、强制顺序并校验回传证据；SAST、隔离沙箱、浏览器探针与 LLM Judge 的实际执行由外部工具/CI 完成——Runtime 本身不构成沙箱。详见 `.ai-harness/policies/verification.md` 与 `docs/architecture/decisions/0004-verification-pipeline.md`。

## BUG 修复复现流水线

所有 `BUGFIX` 工作项的 `VERIFYING` 必须逐段通过 `static → sandbox → reproduction → regression`（`browser` 在带 `frontend` 时必需）。其中 `reproduction`（同一复现路径转绿）与 `regression`（既有测试全绿）**必须由一次真实的 `harness run` 命令证据支撑**：

```powershell
# 真跑复现测试，得到命令证据 ID
node .ai-harness/bin/harness.mjs run --id BUG-001 -- node --test tests/repro-bug-001.test.mjs
# 用 --command 引用该通过证据登记子阶段
node .ai-harness/bin/harness.mjs record --id BUG-001 --kind verification --stage reproduction --status pass --evidence "复现路径已转绿" --command <上一步证据ID>
# 回归同理：真跑全量测试后引用
node .ai-harness/bin/harness.mjs run --id BUG-001 -- npm test
node .ai-harness/bin/harness.mjs record --id BUG-001 --kind verification --stage regression --status pass --evidence "既有测试全绿" --command <证据ID>
```

阶段记为 `pass` 时被引用命令必须真实通过（退出码 0），否则确定性拒绝——比代码生成流水线的「只留证」更强。建议在 `IMPLEMENTING` 先用 `harness run` 记录一次失败复现（红）再实施修复。详见 `.ai-harness/policies/bugfix.md` 与 `docs/architecture/decisions/0005-bugfix-verification-pipeline.md`。

## 强制边界

Runtime 能确定性拒绝非法状态跳跃、未完成数据库设计、无批准计划、任务依赖/写入冲突、错误阶段证据、伪造证据引用、非终态 CI、危险命令和安装覆盖冲突。

它不能劫持 Codex、Claude Code、Gemini 或其他客户端绕过 CLI 的专有工具调用。稳定执行需要三层同时启用：

1. 客户端加载 `AGENTS.md`，并配置其权限/沙箱。
2. AI 使用 `.ai-harness/bin/harness.mjs` 维护状态和执行允许命令。
3. 合并前 CI 执行 `node .ai-harness/bin/harness.mjs check --ci --json`。

`CLAUDE.md` 和 `GEMINI.md` 是薄适配器；其他 AI 客户端必须显式加载根 `AGENTS.md`。任何仓库内文件都无法单独构成对恶意进程的安全沙箱或防篡改签名系统。

## 验证 Runtime

```powershell
node .ai-harness/tests/run.mjs
node .ai-harness/bin/harness.mjs doctor --json
node .ai-harness/bin/harness.mjs check --ci --json
```

GitHub Actions 示例已安装在 `.github/workflows/ai-harness.yml`。
