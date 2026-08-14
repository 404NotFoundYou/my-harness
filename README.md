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

每个非琐碎任务先解析策略，再创建唯一工作项：

```powershell
node .ai-harness/bin/harness.mjs policies --type ITERATION --flag api --json
node .ai-harness/bin/harness.mjs start `
  --id ITER-001 --type ITERATION --title "实现批准需求" `
  --input "docs/requirements/approved.md" --acceptance "验收场景通过" `
  --authorization autonomous --authorization-source "用户端到端授权" `
  --flag api --json
```

后续通过 CLI 推进基线、技术设计、数据库决策、计划、任务、验证、Code Review 和验收。完整命令见[使用指南](docs/guides/usage.md)。

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
