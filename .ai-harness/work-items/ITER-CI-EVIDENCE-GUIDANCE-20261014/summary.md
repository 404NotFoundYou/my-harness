# 2026-10-14 CI启动竞态与阶段证据引导修复

完成两个直接相关修改：模拟进程的兜底定时器从schema准备之前移到mock spawn之后；Runtime提供当前计划成功证据的只读推荐和命令引用失败详情。命令证据的原通过谓词逐字符与HEAD旧版一致，预算、权限和业务完成条件未改变。

## 根因与修复

Windows/Node22源码CI首个中断测试Promise未决被取消。模拟child的250ms watchdog原本在调用驱动之前启动，而Codex驱动先await schema原子写入，再spawn和注册close监听器。用350ms schema写入延迟在本机确定性复现：旧代码9项cancelled，错误与CI一致，红证据20568dc0-8c1c-41a2-9b9e-b7784eceb7fa。将watchdog移入mock spawn生命周期后，同一路径转绿；常规Codex timeout测试也强制该慢准备情形，生产驱动未修改。

开发题的BUGFIX收尾将单独公共测试诊断当作阶段证据，而计划只声明公共与新增测试组合。保留拒绝条件，在verificationReport中由现有successful与matchingChecks派生commands；完整/brief guide的verification.commands提供证据ID、任务、匹配checks、参数与声明超时预算。阶段指引明确必须匹配计划并实际覆盖阶段；非批量阶段的默认引用也从这些当前计划命令中选取。

已有命令未通过assertCommandEvidence时，COMMAND_EVIDENCE_INVALID保留原错误码和message，仅补充details：commandId、actualCommand、matchingChecks、expectedChecks、availableCommands。旧错误码兼容，诊断成功仍被拒绝。guide推荐不是完成授权，实际引用仍重新校验代码/修订/计划/尝试及后续失败。

## 验证

最终源码摘要：b7bcb820cf7a84c0a914c48304629b610b3d3059d5dfebba48c2dd0da5e07719。工作项完整ITERATION/API流程，R1中风险单AI自查，不作为独立复核。实际计划修订2的六个检查均通过；旧红证据、测试夹具缺文件的失败及修订1结果都保留。

| 检查 | 实际结果 | 当前成功证据 |
| --- | --- | --- |
| 慢schema写入复现 | 18项，9通过、9 Windows平台POSIX跳过，0失败/取消 | ad2a4c98-eccb-4921-8ace-33d6f106c313 |
| 9个基准测试文件 | 121项，112通过、9 POSIX平台跳过，0失败/取消 | 5413acaf-7474-4687-8ed6-623e16ae5e3d |
| Runtime全套 | 207/207通过，0失败/跳过/取消 | 46f01f28-e086-40e0-aba4-5b0b139b8be6 |
| 历史字节保护 | 1/1通过，三轮244文件SHA不变 | 540924f7-0cc1-40b7-bf45-5fc244c6aea9 |
| verification语法 | 通过 | 57eebd1e-2210-46b9-b083-29c26a919535 |
| guide语法 | 通过 | aa3a3727-0e7a-4a74-abd1-14f99b419995 |

新增guide/compact定向回归在修订1为31/31通过，最终由修订2Runtime全套再覆盖：晚于计划检查的成功诊断不进入推荐；源码变化撤销旧候选；错误阶段引用返回实际/预期检查及可用证据、状态不变；确实覆盖两阶段的当前组合检查可使BUGFIX到DONE。

基准脚本node benchmarks/tests/run.mjs在Runtime策略中被ask拒绝，未执行。依法replan将其改为直接node --test同一9个文件，不修改权限规则、无嵌套shell或伪装入口。去掉由Runtime全套覆盖的重复窄检查后，新计划所有六项重新实跑。

差异检查通过；已审查完整差异和直接调用方。三轮历史实验、失败样本及holdout均保持原始字节；本轮新增真实模型调用0。

## 交付边界

修改六个产品/测试/文档文件及本工作项；无依赖、模型/提供方/凭据、评分或预算变更。新代码在本机Windows/Node22.20.0已验证；Linux及Node20/24和新版本远端CI未执行，POSIX实机跳过不算通过。此前远端提交6f5fd2f仍有旧测试失败，本轮未提交或推送，未开展真实模型收益复测。

Runtime是状态与证据校验器，内部审计不等于独立复核；root工作项的完成仅表示本次修复产物验收，不改写三个历史参试BUGFIX的未完成状态。
