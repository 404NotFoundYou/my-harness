# ADR-0004：AI 代码生成验证流水线

- 状态：接受
- 日期：2026-08-19

## 背景

`VERIFYING → CODE_REVIEW` 门禁原先只检查 `item.verification.status === "pass"`，把「验证」当成单一不透明结果。对 AI 生成的代码/补丁，这个粒度不足以保证质量：静态安全、隔离执行、契约测试、语义/回归评估与真实界面探针被折叠成一个布尔值，任一环节缺失都无法被 Runtime 确定性拦截。

产品为 app 但可打成 H5，UI 必须在真实浏览器实体探针下跑通才算完成，这一要求同样无法在单点验证里表达。

## 决策

为声明 `codegen` 标志的工作项，把 `VERIFYING` 内的验证升级为**有序、强制、逐段留证**的流水线，不新增顶层状态：

- 子阶段固定有序：`static` → `sandbox` → `contract` → `eval` → `browser`（`VERIFICATION_STAGES`，`constants.mjs`）。前四段对 `codegen` 恒需；`browser` 仅在工作项同时带 `frontend` 时必需。
- `verification` 由扁平 `{status, evidence}` 扩展出有序 `stages[]`；顶层 `status` 由 `aggregateVerificationStatus` 聚合（任一必需阶段 fail 即 fail，全部必需阶段 pass 才 pass），使既有 `CODE_REVIEW` 门禁自动变为「流水线完成」门禁。
- 通过 `record --kind verification --stage <stage>` 逐段留证；把某阶段记为 `pass` 前其之前的必需阶段必须已 pass（`VERIFICATION_STAGE_ORDER`）。`codegen` 工作项禁止用裸 verification 记录绕过（`VERIFICATION_STAGE_REQUIRED`）。
- 执行边界：Runtime 只编排、强制顺序与完整性、校验回传证据；SAST、隔离沙箱、浏览器探针与 LLM Judge 的实际执行由外部工具/CI/agent 完成后回传结构化证据。Runtime 本身不构成隔离沙箱（AGENTS.md §9），沙箱隔离由客户端/CI 提供。LLM Judge 只用于语义/回归的判断裁量，不替代确定性门禁。

非 `codegen` 工作项行为完全不变：`stages` 恒为空，`record --kind verification`（不带 `--stage`）走原有扁平路径。

## 结果

AI 代码生成工作项在进入 `CODE_REVIEW` 前，Runtime 能确定性拒绝乱序、缺段、聚合状态与子阶段证据不一致（含 `check --ci` 的按 `(kind, stage)` 分组回放）。既有非 codegen 流程、命令白名单与零依赖约束均不受影响；实际的静态扫描/沙箱/浏览器/LLM 执行仍依赖外部工具，Runtime 只保证证据齐全与顺序正确，不伪称提供隔离或语义判定能力。
