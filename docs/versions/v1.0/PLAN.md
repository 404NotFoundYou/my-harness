# v1.0 开发计划

## 输入与边界

- 数据库设计：`docs/architecture/database.md`，影响不适用。
- 架构：`docs/architecture/overview.md`、ADR-0001。
- 授权：用户要求端到端完成整改，不逐任务询问继续。
- Node.js：最低 20，当前验证环境 v22.20.0。

## 执行策略

- 单 AI 串行实现。核心状态、CLI、安装器和策略文件存在连续接口依赖，当前无法证明并行写入安全。
- 每个 Review Batch 在成员实现与最窄测试完成后自动审查，不逐项请求确认。
- Runtime 只使用 Node.js 标准库，不修改目标项目根依赖清单。

## 任务

| Task ID | 输入/验收 ID | 业务模块 | blockedBy/blocks | 写入范围 | 验证方式 | 文档影响 | 风险/Review Batch | 所有者/模式 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | ARCH-STATE | 结构契约 | - / T02,T03 | `.ai-harness/manifest.json`, `config.json`, `schemas/`, `src/constants.mjs` | Schema fixture 与常量测试 | 架构、STATE | 高 / R-CORE | 主 AI / 串行 | IMPLEMENTED |
| T02 | GATES | 状态与门禁 | T01 / T03,T07 | `src/filesystem.mjs`, `model.mjs`, `validator.mjs`, `workflow.mjs` | 合法/非法状态、依赖图、门禁测试 | STATE、VERIFICATION | 高 / R-CORE | 主 AI / 串行 | IMPLEMENTED |
| T03 | CLI | CLI 编排 | T02 / T04,T05,T07 | `bin/harness.mjs`, `src/cli.mjs` | CLI 参数、JSON 输出、退出码测试 | README、VERIFICATION | 中 / R-CLI | 主 AI / 串行 | COMPLETED |
| T04 | CMD-SAFETY | 命令与证据 | T03 / T07 | `src/policy.mjs`, `src/evidence.mjs`, `policies/security.md` | allow/ask/deny、注入、脱敏、证据测试 | 安全策略、VERIFICATION | 高 / R-SAFETY | 主 AI / 串行 | IMPLEMENTED |
| T05 | INSTALL | 安装与初始化 | T03 / T07,T08 | `src/installer.mjs`, `src/managed-block.mjs`, `templates/` | 无损合并、幂等、篡改、冲突前零写入、再分发隔离 | README、架构、使用指南 | 高 / R-INSTALL | 主 AI / 串行 | IMPLEMENTED |
| T06 | POLICY | 规则分层 | T02 / T08 | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `policies/*.md` | 路由、适配器、核心规则体积检查 | 全部策略索引 | 中 / R-POLICY | 主 AI / 串行 | COMPLETED |
| T07 | TESTS | 自动化测试 | T02,T03,T04,T05 / T08 | `.ai-harness/tests/` | `node --test`、故障注入、临时 Git 仓库 | VERIFICATION | 高 / R-VERIFY | 主 AI / 串行 | IMPLEMENTED |
| T08 | RELEASE | CI 与交付 | T05,T06,T07 / - | `.github/workflows/`, `README.md`, `docs/`, runtime 自检 | doctor、check --ci、安装后 smoke test | README、STATE、VERIFICATION | 中 / R-RELEASE | 主 AI / 串行 | IN_REVIEW |

`IMPLEMENTED` 表示实现、最窄验证和同上下文自审完成；R-CORE、R-SAFETY、R-INSTALL、R-VERIFY 的独立复核尚未执行，因此未标为 `COMPLETED`。

## 门禁追踪

- `NEW_PROJECT`/`ITERATION`：必须经过 `SOLUTION_DESIGN`、数据库决策和计划校验。
- `BUGFIX`：必须具备复现/根因/回归证据；数据库影响决定是否进入 `DATABASE_DESIGN`。
- `ANALYSIS`：只读闭环，不允许开发状态或写入任务。
- `VERIFYING` 前：所有任务必须 `COMPLETED` 或经批准 `DEFERRED`，且 Review Batch 证据有效。
- `DONE` 前：最终验证、工作项 Review 和验收记录必须通过。

## 验收场景

1. 合法的新项目、迭代、BUG 和分析状态流可完成。
2. 跳过技术设计、数据库决策、计划、验证或 Review 的转换被拒绝。
3. 任务依赖未满足、依赖环、非法状态和写入范围重叠被拒绝。
4. deny 命令即使参数异常也不执行；ask 命令只报告需要外部授权。
5. 允许命令以无 shell 方式执行，结果脱敏并持久化。
6. 安装到空项目成功；已有规则无损合并且重复安装幂等；普通冲突默认零写入失败。
7. 路径逃逸和符号链接/联接越界被拒绝。
8. `doctor` 和 `check --ci` 使用稳定退出码，损坏 fixture 必须失败。
9. 根规则显著缩短，专项策略可按工作类型确定性解析。
10. 从干净临时 Git 仓库完成安装、初始化、工作项和 CI smoke test。
