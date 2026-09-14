import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { auditExperiment } from "../../../benchmarks/audit.mjs";

const directory=path.dirname(fileURLToPath(import.meta.url));
const rounds=[];
for(const name of ["pilot","followup"])rounds.push({name,...await auditExperiment(path.join(directory,name))});
const labels={"weak-baseline":"Luna 原流程","weak-harness":"Luna + Harness","strong-reference":"Sol 参考"};
const phase={pilot:"先导",followup:"复验"};
const lines=["# 固定任务真实模型对照（2026-09-14）","",
  "本轮没有证明Harness能提升较弱模型的完整交付表现。辅助改进后，Luna + Harness功能通过从2/3变为3/3，但预算内完整完成仍为1/3，平均耗时从165.7秒变为176.0秒；Luna原流程两轮均完整完成3/3。参考组也有改善，尚不能排除运行时延和单次采样差异。", "",
  "通过现有 Codex CLI 登录实际运行两轮、共18次独立会话。三题分别为CSV解析、精确整数分配和增量事件合并；每题12项隐藏验收。CSV和分配用于分析失败，辅助改进在查看留出题结果前冻结。两轮公开任务与判定哈希一致，模型、medium推理档、180秒中断预算和80工具预算不变。", "",
  "## 结果", "", "完整完成要求模型正常结束、功能验收通过、文件范围正确；Harness组还需工作项及CI通过。功能通过单独统计，不能代替流程完成。误称完成只统计结构化最终声明中的completed:true；超时且无最终声明不计入此指标。", "",
  "| 轮次 | 组别 | 功能通过 | 完整完成 | 超时 | 误称完成 | 平均耗时（秒，含超时） |",
  "| --- | --- | --- | --- | --- | --- | --- |"];
for(const round of rounds)for(const group of round.groups)lines.push(`| ${phase[round.name]} | ${labels[group.group]} | ${group.functionalPassed}/3 | ${group.completed}/3 | ${group.timeouts} | ${group.falseCompletion} | ${(group.durationMs/3000).toFixed(1)} |`);
lines.push("", "## 逐题结果", "", "| 轮次 | 任务 | 组别 | 隐藏用例通过 | 完整完成 | 秒 | 主要状态 |", "| --- | --- | --- | --- | --- | --- | --- |");
for(const round of rounds)for(const row of round.rows){
  const unchanged=!row.scope.changes.some(change=>change.path.startsWith("src/"));
  const state=row.run.timedOut?(unchanged?"超时，未修改实现":"超时"):
    !row.scope.ok?"文件范围违规":!row.grade.ok?"验收未通过":row.workflow&&!row.workflow.ok?"流程未完成":row.success?"通过":"会话未完整结束";
  const acceptance=row.grade.complete?`${row.grade.cases.filter(entry=>entry.pass).length}/${row.grade.expectedCases}`:"未完整运行";
  lines.push(`| ${phase[round.name]} | ${row.taskId} | ${labels[row.group]} | ${acceptance} | ${row.success?"是":"否"} | ${(row.run.durationMs/1000).toFixed(1)} | ${state} |`);
}
lines.push("", "## 实际改进与采用情况", "",
  "开发集揭示的具体问题包括猜测测试目录、修正自测后多余地reopen、READY状态直接run以及恢复/收尾开销。本轮新增run --all（仍逐项执行原权限和证据检查）、可选guide --context、reopen后的准确任务状态/下一步，以及普通已验证迭代的finish快捷建议。没有向模型注入隐藏答案，也没有按留出题失败调整任务或判定器。", "",
  "复验Harness组的日志中可直接观察到的辅助命令：", "");
for(const row of rounds[1].rows.filter(row=>row.group==="weak-harness")){
  const text=await readFile(path.join(directory,"followup",`${row.taskId}-${row.group}`,"events.jsonl"),"utf8");
  const commands=text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.type==="item.completed"&&event.item?.type==="command_execution").map(event=>event.item.command);
  const uses=[];
  if(commands.some(command=>command.includes("harness.mjs guide")&&command.includes("--context")))uses.push("guide --context");
  if(commands.some(command=>command.includes("harness.mjs run")&&command.includes("--all")))uses.push("run --all");
  if(commands.some(command=>command.includes("harness.mjs finish")))uses.push("finish");
  lines.push(`- ${row.taskId}：${uses.length?uses.join("、"):"未观察到字面调用；不能据此排除脚本内的间接调用"}。`);
}
lines.push("", "## 仍需解决的问题", "",
  "1. CLI任务声明仍容易出错。复验allocation中，模型把两个写入路径填成单个逗号字符串，且曾用分号拼接验证命令；前者直到finish才触发范围拒绝。CSV首次guide遗漏了必需的--id。下一步优先考虑结构化任务输入和更早的声明诊断，减少参数与转义错误。",
  "2. 收尾和上下文开销未稳定降低。复验events使用了guide --context和run --all，全部功能与计划检查通过后仍在IMPLEMENTING超时；上下文读取后又出现重复读取同一源码。应继续减少重复信息和状态往返；本次没有逐工具的完整耗时分解，不能认定单一环节是全部原因。",
  "3. 三个纯函数任务不足以代表真实项目能力。应在后续加入真实仓库修改、跨文件依赖、不同客户端和模型，并重复采样。本次不根据留出结果继续调参，也不声称通用能力已达到参考模型。", "",
  "[开发集观察](pilot-observations.md) · [复验失败原因](followup-observations.md)", "",
  "## 用量与限制", "",
  "| 轮次 | 组别 | 返回用量的样本 | 已返回的总输入 | 其中缓存输入 | 已返回的输出 |", "| --- | --- | --- | --- | --- | --- |");
for(const round of rounds)for(const group of round.groups){const rows=round.rows.filter(row=>row.group===group.group&&row.run.usage);const sum=key=>rows.reduce((n,row)=>n+(row.run.usage[key]||0),0);lines.push(`| ${phase[round.name]} | ${labels[group.group]} | ${rows.length}/3 | ${rows.length?sum("input_tokens"):"未知"} | ${rows.length?sum("cached_input_tokens"):"未知"} | ${rows.length?sum("output_tokens"):"未知"} |`);}
lines.push("", "用量表只累加实际返回的样本。超时样本未返回完整用量，不能按零计费，也不能用不完整合计比较总成本。缓存输入包含在总输入中；本报告不换算货币费用。", "",
  "每题每组每轮只有一次，不支持显著性或通用能力等价结论。参考组存在时间截断，不能把未完成实现解释为已经证明的算法能力差距。实际模型标识为gpt-5.6-luna/gpt-5.6-sol，来自现有自定义服务配置；未验证服务内部权重、定价或服务端排队。", "",
  "先导轮未单独保存新增自测文件文本，仅保留其哈希、工具日志及模型代码；复验轮补存extra.test.mjs。隐藏验收在模型结束后于单独目录运行；这不是抵抗恶意参试者的安全隔离证明。Windows/本机CLI已验证，其他操作系统、客户端和模型厂商未进行真实试跑。", "",
  "## 验证与证据", "",
  "- Runtime：node .ai-harness/tests/run.mjs，121/121通过、0跳过。", "- 框架：node --test benchmarks/tests/runner.test.mjs，4/4通过、0跳过。", "- 两轮：node benchmarks/audit.mjs <pilot或followup目录>，核对9项结果、任务/判定/候选哈希和统计。", "- 完整模型命令、输出、退出码、失败用例和控制面记录位于各轮各题目录，未删除失败样本。", "",
  `先导源码：${rounds[0].source}；复验源码：${rounds[1].source}。这些是产品快照SHA-256，不是Git提交。`, "",
  "[先导统计](pilot/summary.json) · [复验统计](followup/summary.json) · [改进决定](intervention-decision.md)", "");
await writeFile(path.join(directory,"comparison.md"),lines.join("\n"));
console.log(JSON.stringify({report:path.join(directory,"comparison.md"),samples:18}));
