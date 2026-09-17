# Core Harness任务入口提示的局部修正

基线main@d8f8f66，Runtime1.9.0。两轮真实core双组实跑都有Harness完整交付0/3；1.9三题功能3/3，allocation工作项DONE且check成功仍在客户端180秒截止前未返回完整终态。脱敏事件还显示CSV未调用预填`begin --spec`，events一次把spec写成绝对路径而被拒绝，allocation先后出现空风险/文档理由不足。工具时间仅能证实allocation的finish/check约156秒完成，最后工具约171秒；events最后工具约84秒，剩余时间不能归因给Runtime。不能放宽完成条件或仅凭三题断言提示收益。

当前参与者`AGENTS.md`在createParticipant提交固定Git基线之前写入普通任务规则，Harness安装随后追加托管块。只对`harness && task.writableFiles===undefined`追加一小段任务入口指令：先读取`.ai-harness/work-items/benchmark-begin-spec.json`，只根据实际任务填写`risk`与`approach`，保留公开任务预填的范围、验证命令和有理由的N/A文档字段，使用项目**相对路径**调用`begin --spec`。当前participantPrompt仍给出相同命令与`guide`/`run --all`，补一句只有真实`finish`、`check`已通过才尽快生成结构化最终答复；超时不得自称完成。原流程、project题和固定任务`files`、隐藏验收、预算、协议与评分判断不变。

验收：合成参与者检查Harness AGENTS在Git基线即含相对输入指令与不修改固定字段边界，baseline/project AGENTS内容保持；风险/方案未填仍被loadBeginSpec拒绝，填后实际begin→计划验证→finish→DONE仍可行，独立客户端终态门禁不放宽。旧1.8/1.9真实v4只读审计继续通过；全部benchmark与Runtime回归、独立审查和check --ci通过。没有新的费用授权，本轮不调用真实模型，不能声称1.9.1提高真实交付。
