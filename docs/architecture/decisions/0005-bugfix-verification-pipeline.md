# ADR-0005：BUGFIX 复现红→绿验证流水线

- 状态：接受
- 日期：2026-08-19

## 背景

`bugfix.md` 已把「复现优先、失败测试优先、根因证据、同一复现路径确认恢复、禁止掩盖」写成文字规则，但 Runtime 只在 `BASELINING` 校验 `actual/expected/reproduction` 三段文本，其余全靠散文引导，无确定性强制。BUG 修复因而可能在没有真实复现与回归证据的情况下宣称完成。

ADR-0004 已为 `codegen` 建立可复用的验证流水线基础设施（`verification.stages[]` + `record --stage` + 聚合 + checker 按 `(kind, stage)` 一致性）。BUGFIX 的需求是同一机制的另一组必需阶段，加上「复现/回归必须真跑」的强化。

## 决策

对所有 `BUGFIX` 类型工作项，`VERIFYING` 自动启用有序验证流水线，复用 ADR-0004 的机制，不新增顶层状态或门禁对象：

- 必需阶段（有序）：`static` → `sandbox` → `reproduction`（同一复现路径转绿）→ `regression`（既有测试全绿）；`browser` 在带 `frontend` 时必需。`contract`/`eval` 不纳入 BUGFIX 必需集。
- 阶段适用性由 `VERIFICATION_STAGES` 的 `codegen`/`bugfix` 元数据驱动；`requiredVerificationStages(item)` 按类型与 flags 取并集；`usesVerificationPipeline(item)` = BUGFIX 或 codegen。
- `reproduction`/`regression` 标记为 `runBacked`：记录时必须用 `--command <证据ID>` 引用一条 `harness run` 产出的命令证据；阶段记为 `pass` 时该命令证据必须真实通过（退出码 0）。命令证据 id 存 `stage.command`，不混入 `evidence[]`（保持后者全为 verification-kind）。`node --test`/`npm test` 已在命令白名单，故无需改 `policy.mjs`。
- 时序：VERIFYING 在修复之后无法再记录「红」，故「红」= 基线复现文本（已强制）+ 建议在 `IMPLEMENTING` 用 `harness run` 记录一次失败复现；「绿」在 VERIFYING 由真跑命令硬强制。

非 BUGFIX、非 codegen 工作项行为完全不变。

## 结果

BUG 修复进入 `CODE_REVIEW` 前，Runtime 能确定性拒绝乱序、缺段、聚合与子阶段证据不一致，并额外要求 `reproduction`/`regression` 挂接真实通过的命令证据——比 codegen 的「只留证」更强。红证据不作硬门禁（仅策略建议），batch-size=1 维持为 bugfix.md 文字规则；静态扫描/沙箱/浏览器/LLM 的实际执行仍依赖外部工具，Runtime 不伪称提供隔离或语义判定能力。
