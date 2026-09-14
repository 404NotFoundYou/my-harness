# ADR-0006：精简入口兼容验证流水线

- 状态：接受
- 日期：2026-09-14
- 输入：用户授权提交并推送；远端 main 的 232f862 引入了 codegen/BUGFIX 验证流水线。

## 冲突与选择

本地精简入口一次写入工作项 verification，远端对所有 BUGFIX 要求逐段证据；直接文本合并会让 finish 在 VERIFYING 中途失败。根 AGENTS 同时发生内容冲突。

采用本地精简根契约，补充远端新增流水线规则；保留上游流水线及其强制顺序，精简命令改为一次接收实际阶段证据并按现有接口有序登记。不自动编造静态、隔离或浏览器检查，不关闭远端门禁。

## 兼容方式

- 普通 ITERATION 的 begin/run/finish 参数和行为不变，codegen 继续走完整流程。
- BUGFIX 的 finish 增加可重复 --stage-evidence stage=说明、--stage-command stage=命令ID。所需阶段和需要命令的阶段由 constants 中现有元数据确定。
- 所有必需阶段和命令引用在任何状态更新前检查；阶段命令也执行当前任务、最新成功结果及返工时效校验。数据齐全后使用 recordResult 的 stage/commandRef 参数登记。
- 普通 BUG 和 frontend BUG 都用测试验证缺段拒绝和完整闭环；保留远端已有 codegen/BUGFIX 测试。

单 AI、中风险兼容调整；不修改流水线判定、命令权限或持久化结构。范围为 compact、CLI、对应测试、根规则及模板、使用指南和本记录。使用原有 Node 测试、doctor、diff 检查和 CI 门禁验证，之后按用户授权普通合并并推送。
