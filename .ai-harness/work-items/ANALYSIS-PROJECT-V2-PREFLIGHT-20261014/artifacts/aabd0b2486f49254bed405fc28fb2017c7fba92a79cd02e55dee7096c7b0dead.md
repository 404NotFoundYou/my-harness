# 2026-10-14 结构化工程BUG入口的CI核验与零调用复测准备

已完成用户授权的第1、2步：实时核验当前提交远端CI，并实际执行零模型调用dry-run冻结下一轮配对配置。新增真实模型会话0；真实试验仍待新增费用授权。本项使用ANALYSIS路径，产品文件只读。

## 已确认事实

- 当前main提交b269e61738f1af34bae7e81923c91f9e37774b38；产品源码摘要502e2cb4a9ca4c60189ee01d52c78f5979cdbdf57dd651ecc71e97778fd1dccc，与提交树和已验证版本一致。
- GitHub API最终访问时间2026-10-14T08:48:18.7030725Z（北京时间16:48:18）。AI Harness（38536029874）和Harness source tests（38536029807）均completed/success；Ubuntu/Windows的Node20、22、24六组任务均completed/success。六组基准步骤均success，Windows三组Runtime步骤success；Ubuntu矩阵中的Windows Runtime条件步骤均skipped，不计为执行过Runtime。保存了来源、时间、运行/任务/步骤状态，未通过日志重算远端测试数量。
- 宿主实际执行benchmarks/run.mjs --dry-run，退出码0；未调用CLI驱动，未创建任何真实试验输出目录。dry-run中的modelCalls=6表示拟议CLI会话数，不是实际HTTP请求数。命令数组及结果见dry-run-command.json和dry-run.json。
- 已通过现有sourceSnapshot/commitSnapshot、cliIdentity、experimentPlan和taskManifest做离线一致性校验，保存preparation-check.json和experiment-baseline.json。上轮351文件及本次入口实现工作项18文件共369文件的SHA保持不变，冻结清单见historical-hashes.json。

## 下一轮冻结配置

| 项目 | 冻结值 |
| --- | --- |
| suite / comparison / repetitions | project-v2 / paired / 1 |
| 客户端 / 模型 | Codex / gpt-6-astra，两组同模型 |
| 题目 | archive-pagination、config-layers、window-intervals |
| 组 | weak-baseline、weak-harness；各3个会话，共6个 |
| 每会话预算 | 180000ms、80次工具、medium |
| 框架自动补跑 | 0 |
| 理论会话预算上限 | 1080000ms（18分钟，不含准备/审计开销）、480次工具 |
| CLI / Node | 包清单版本0.156.0 / v22.20.0；入口SHA与上一轮一致 |
| 输入及评分 | 任务、可写范围、隐藏判定摘要及调度与上轮一致；holdout不用于调参 |

源代码在本次入口实现后变化；旧试验继续按其冻结源码解释，不能把旧失败改为新成功。客户端入口指纹不覆盖所有依赖、提供方配置或远端模型实现。

## 执行边界与下一步

真实会话尚未授权和执行，当前提供方连通性及模型可用性未联网检查，实际新Token/费用没有估算；计划的6个CLI会话不等于6次HTTP请求。本次仅做配置准备，不证明真实模型能在180秒内完成收尾。

获得新增6个会话费用授权后，先重新核对当前源码、客户端和适用提交的CI，再建立开发型工作项及正式试验协议，按冻结配置执行。按功能通过、完整交付和超时分别报告，核对实际finish、DONE和check --ci；全部失败和超时保留，不追加补跑。单轮配对结果不能证明普遍或因果收益。

Runtime guard对普通node脚本返回ask，不通过harness run执行；本次依据用户对第1、2步的明确授权，由宿主直接运行带--dry-run的原入口，没有嵌套shell包装或改权限配置。探索式--help查询被原入口拒绝，已改读run.mjs参数实现；初始驱动路径查询不存在，已定位并读取client-drivers.mjs。这些探索命令不记为通过的验收检查。

本次仅新增本工作项控制面产物，没有修改产品源码、历史记录、凭据或依赖，没有提交或推送。
