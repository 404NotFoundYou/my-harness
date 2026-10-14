# 2026-10-14 project-v2 工程BUG只读入口与收尾

本地实现了BUGFIX只读输入的判断填充，以及仅project-v2 Harness启用的预填模板与简短收尾指引。只预填确定性信息，模型仍负责风险/方案及实际、期望、复现方法；runner不替参试模型创建/完成工作项，不改变四阶段或证据门禁。新增真实模型调用0，模拟测试不代表真实模型收益。

## 改动

- begin --spec新增--actual/--expected/--reproduction，仅BUGFIX可用，只填已有空字符串，不覆盖已填值。未知字段、错误类型、缺失判断、空参数和权限/写入范围覆盖在创建前拒绝，模板文件不改写。旧完整spec和risk/approach调用继续兼容。
- begin-spec输入schema允许空BUG判断占位；实际work-item schema和创建校验保持原样，启动仍要求完整BUG描述。
- 冻结suite由experiment传入runCase，仅project-v2 Harness生成benchmark-begin-spec.json。预填公开ID、范围、公共检查、授权、N/A理由和无数据库依据；五个判断为空。core、旧project与baseline提示/入口保留，task/judge manifest、预算及评分不改。
- 提示明确实际复现、记录红证据、修复和必要自测、最终run --all、guide --brief、使用适用计划证据finish四阶段及check --ci；未完成仍必须如实报告。

## 实际验证

源码摘要502e2cb4a9ca4c60189ee01d52c78f5979cdbdf57dd651ecc71e97778fd1dccc。完整ITERATION/API流程、中风险单AI，R1为同一AI自查，不作为独立复核。

| 检查 | 结果 | 当前命令证据 |
| --- | --- | --- |
| spec判断与兼容 | 6/6，0失败/跳过 | ec5ca533-5fc0-441d-a57c-fd86c33c8b24 |
| core/旧project/v2集成与输入保护 | 9/9，0失败/跳过 | 02836aff-2024-4a2a-8a12-cfd2cfbca58c |
| Runtime全套 | 209/209，0失败/跳过/取消 | 6d80eec3-ed50-4f71-8e2c-2c4d877648ec |
| 9个基准测试文件 | 126项117通过、9 POSIX平台跳过，0失败/取消 | 68d483e5-d1a1-4762-9145-bb44b1b23068 |
| 历史字节保护 | 1/1，351文件SHA不变 | 1c7e1caf-eaca-43fa-ab88-e328e1ea7edb |
| 四源文件语法 | 全通过 | 5dc474e9-c70b-44aa-9395-12e10876d582、6d240dd9-5ab3-47d3-943a-9e3f04847df8、dce3ef8b-09a8-4655-8ae4-348b18a1b492、c38458ad-dcf3-48e6-8f63-1ffaec5f0d49 |

初始红测保留：V1两个新判断回归失败（789762e0-5e82-45cc-8afc-d64b665a22af），V2缺少工程输入文件（7c843eec-1d06-4153-a696-0ad43f12d1ba）；实现后转绿。空--actual由已有CLI OPTION_REQUIRED更早拒绝，夹具已按实际拒绝层级修正，未改变该门禁。

三个工程题在独立临时项目中执行真实CLI：先观察公共测试失败、填判断并begin、记录失败run、写参考修复、真实计划验证、四阶段finish、DONE与check --ci；父测试再检验隐藏功能和候选范围。状态与计划全由CLI维护，输入原始字节保持一致。

六组模拟experiment核对suite传入和仅Harness预填，审计valid/mode=simulated/samples6；未运行工作项时，即使候选功能正确也不能记为完整交付。输入编辑/删除检查真实文件变更，linked-type使用受控lstat文件类型注入验证同字节的链接身份必须拒绝；没有把该注入宣称为实际OS符号链接替换。

## 边界

当前仅本机Windows/Node22.20.0实测。新代码Linux/Node20/24和远端CI尚未执行，9项POSIX跳过不算通过；新独立复核、付费复测、提交或推送未执行。历史351文件包括旧成功、失败和超时样本全部保留，holdout只用于已有无模型契约测试，没有用真实holdout结果调参。

修改9个代码/测试/schema/文档文件；版本发布、依赖、凭据、权限、工作项完成条件、评分和预算均未调整。使用当前源码时工程组提示/输入有变化，历史实验仍按其冻结源码审计，不能把模拟通过当作180秒内收益证明。
