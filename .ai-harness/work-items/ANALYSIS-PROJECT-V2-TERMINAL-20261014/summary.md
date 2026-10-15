# 2026-10-14 成功收尾后缺终态事件与共享记忆边界调查

本轮仅复用已有六会话记录和源码，执行离线CLI帮助/配置/提示预览，不追加真实模型调用，不调整180秒/80工具、评分或完成门禁。调查完成但具体超时根因仍为UNKNOWN；没有证据支持立即改评分或自动把DONE算作完整会话成功。

## 当前范围与证据

main@f8bedb576e2a684964ddf87fb73254779337cc2e，产品源码摘要502e2cb4a9ca4c60189ee01d52c78f5979cdbdf57dd651ecc71e97778fd1dccc。开始时既有MODEL-PROJECT-V2-STRUCTURED-20261014的86文件尚未提交、工作项DONE；这些文件及其前388文件共474文件SHA全部不变。本次只写新分析工作项，产品文件只读。

inspect-records.mjs按原始events.jsonl、stderr.txt、final.json、result.json、归档工作项和源码重新计算。terminal-analysis.json保存六样本、日志类别、时间点、未闭合命令、共享记忆读取及证据边界。Node22.20.0版本证据f5e9a6d5-9a4b-493d-8012-acd848217bd9仅支持版本事实；分析脚本语法证据fdab7b57-1cb7-4da8-a211-0ad8c64efd3f仅支持语法。实际聚合由已授权宿主只读执行，不包装成ANALYSIS白名单测试。

## PROVEN：已确认事实

1. 两次成功finish/check的工具都退出0，归档BUGFIX为DONE；三次Harness均没有turn.completed、没有可用结构化最终结果。六会话均无未关闭command_execution，unparsedLines均0，exit与close接收时间差均0。没有观察到终态事件已经到达后进程再长时间退出的情况。
2. 最后一条命令之后，配置和区间Harness日志没有新的工具、最终assistant JSON或顶层协议失败；分页有一条简短普通assistant消息但未启动finish。事件日志没有每条assistant消息的时间戳，不能重建最后模型请求的完整时间线。
3. 直接实现也有约20至23秒的最后工具到终态间隔。Harness相应区间是直到预算终止的截断观察，不等于实际完成所需时间：

| 题目 | 直接实现最后工具→终态事件 | Harness最后工具→预算退出 | Harness工作项 |
| --- | ---: | ---: | --- |
| 分页 | 20.412秒 | 15.290秒（截断） | IMPLEMENTING |
| 配置 | 20.748秒 | 26.417秒（截断） | DONE |
| 区间 | 22.783秒 | 20.634秒（截断） | DONE |

4. 三次Harness stderr最后带时间戳条目约在31.188、31.179、31.135秒，来自MCP初始化；成功组的MCP关闭告警在终态事件附近，之后约0.26至0.29秒退出。两组均有MCP约30秒握手失败、插件/PowerShell快照告警及两条忽略旧配置提示。它们没有提供成功finish之后的阻塞证据，也不能把并发背景握手时间直接加成总开销。
5. 现有codexProtocol仅把顶层error/turn.failed作为协议错误，item.completed中的忽略配置提醒没有被计入run.errors。这解释了“run.errors为空”与仍存在CLI配置告警可以同时成立；本次没有改其历史判定口径。
6. codex-driver.mjs:82先读取/parseFinal并捕获异常，:83随后用解析结果重写final.json。归档null同时兼容原文件缺失、不可读、非法JSON和schema不匹配等情况，旧记录不能恢复原来的区别。源码:16绑定turn.completed，:48为预算终止，:68-75分别记录exit/close；protocol.mjs:27要求真实会话完成和有效最终响应，DONE不足以替代这些条件。
7. 三次Harness实际shell查询了宿主memories/MEMORY.md，三个直接实现会话未观察到同类查询。它证明发生过读取，不能证明记忆指令在当时提示中的注入来源，也没有单独的事件级时长支持精确记忆耗时；读取命令与公共测试合并执行。

## INFERRED与UNKNOWN

“最后工具后仍需生成最终回复，预算余量可能不足”是候选解释。配置组还剩约26秒，区间组约20秒，而成功组的对应间隔也约20至23秒；三对样本无法确定这个候选解释，更不能认定模型、网络、客户端schema处理或Runtime退出机制为根因。

stderr没有模型HTTP重试证据，但不代表底层没有静默重试；框架不补跑不等于客户端或提供方不重试。已有记录也不能确认原始模型请求开始/结束、final文件最初身份、完整客户端环境及账单。

## 共享记忆控制已做的零调用验证

当前冻结CLI包版本0.156.0。memory-feature-probe.json显示当前有效memories feature为true，加入--disable memories后的只读features list为false，验证了本机开关被接受；不把当前值反推为历史完整配置快照。

使用debug models --bundled取得本机内置目录，再显式model_catalog_json执行debug prompt-input，两次exit0，不发送模型推理请求、不保存原始提示正文。默认和关闭memories两次都没有可识别记忆指令/摘要/registry/citation标记，结果见memory-prompt-probe.json。因此离线预览不能证明原试验曾有自动记忆注入，也不能据此宣称真实exec已完全隔离；这项预览是未建立区分能力的检查。

官方配置与非交互说明已实际读取并保存URL/访问时间/HTTP200及相关键存在情况于official-source-notes.json。当前网页说明不能代替固定版本实测。控制的实施与验收见memory-control-plan.md。

## PROPOSAL：已准备的下一步范围

优先在新开发型工作项做不改变评分的可观测性补充：记录最终文件原身份/解析失败类别及最后assistant/终态事件接收点，旧样本缺字段保持未知；先检查audit/protocol的严格兼容约束，用无模型夹具验证。不要用DONE自动生成最终JSON或把超时改为成功。

另一前提是可验证的共享记忆控制：两组统一--disable memories，并在独立实验执行环境禁止读取宿主记忆；用无模型合成文件同时验证工作区可读、外部受保护文件不可读，再冻结环境清单。仅改CODEX_HOME或关闭默认config发现都不是文件访问隔离，不能直接开下一轮付费试验。当前没有实施任何用户/权限/凭据变更。

本分析有明确证据边界，未将UNKNOWN包装成根因。实际新增模型会话0，未运行产品测试套件、未修改产品源码或旧记录、未提交推送。最终分析状态和本地门禁见state.json、final-check.json。
