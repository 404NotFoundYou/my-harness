# 2026-10-14 结构化工程BUG入口后的project-v2六会话真实复测

已完成授权的6个独立CLI模型会话，全部结果及3次超时保留，无补跑或新增轮次。直接实现组功能3/3、完整交付3/3；Harness组功能3/3、工作流完成2/3、完整交付0/3、超时3。本轮没有证明180秒预算内完整交付率改善。

## 冻结条件与真实执行

- main@f8bedb576e2a684964ddf87fb73254779337cc2e；产品源码摘要502e2cb4a9ca4c60189ee01d52c78f5979cdbdf57dd651ecc71e97778fd1dccc，与先前准备一致。产品源码未修改。
- 模型启动前GitHub API核验AI Harness和Harness source tests两个workflow、Ubuntu/Windows与Node20/22/24六组任务全部completed/success。CI访问时间2026-10-14T09:15:59.3770490Z，早于第一个会话。完整步骤/来源保存于ci-preflight.json；Ubuntu的Windows专用Runtime条件步骤为skipped，不计为执行过Runtime。
- 用户明确授权6个新增真实模型会话及相应费用。配置中的只读/models查询返回200且包含gpt-6-astra，wireApi=responses，凭据未改。
- 实跑前实际dry-run冻结project-v2/paired/repetitions1、两组同模型gpt-6-astra、每会话180000ms/80工具/medium；任务、可写范围、判定摘要、调度和预算与上轮一致。Codex CLI包清单0.156.0/Node22.20.0，入口SHA与准备及上轮一致。
- 宿主直接执行已授权的原模型入口，没有通过测试包装绕过Runtime ask。启动时间2026-10-14T09:16:59.2719980Z，结束时间09:34:10.7425131Z，入口退出码0；6个执行记录均completed，pending/interrupted均0。实验记录完整不代表每个参试模型完整交付。
- 上轮历史351文件、入口实现18文件、准备19文件共388文件SHA不变。holdout仅按冻结试验观察，不用其结果调参。

## 六个结果

观测时间单位秒；Harness超时区间为预算终止后的截断观测，不是自然完成耗时。

| 题目 | 直接实现功能 / 完整交付 | 直接实现耗时 | Harness功能 / 工作流 / 完整交付 | Harness观测耗时 |
| --- | --- | ---: | --- | ---: |
| 归档分页 | 12/12；通过 | 149.938 | 12/12；IMPLEMENTING；失败 | 180.441（超时截断） |
| 配置层叠 | 12/12；通过 | 153.169 | 12/12；DONE；失败 | 180.414（超时截断） |
| 区间归并与裁剪 | 12/12；通过 | 174.716 | 12/12；DONE；失败 | 180.416（超时截断） |

两组隐藏验收均36/36，六项候选写入范围均合法，falseCompletion均0。全部三对均含超时截断，不将差值解释为完成更快。

## 入口和收尾实际观察

三组Harness各观察到一次begin --spec，均创建真实BUGFIX，判断字段实际已填；冻结输入没有变更/删除/链接身份违规。分页组begin后同一shell执行红run导致组合shell退出1，不代表begin创建失败；真实失败run记录保留。未观察到本轮DOCUMENTATION_REASON_REQUIRED或COMMAND_EVIDENCE_INVALID返工。

分页组在约165.151秒结束最终run --all及guide，已取得当前成功公共检查证据51211f80-fb38-45d5-b81b-c00441613b6e，但未观察到实际finish启动；工作项仍IMPLEMENTING，四阶段未登记。实际跑过测试不等于已完成阶段和交付。

配置组和区间组实际finish并check --ci，最后组合工具分别在153.997、159.782秒结束，工具退出码0，输出包含DONE及ok:true；归档工作项四阶段pass，复现/回归均引用真实成功且匹配当前计划的检查证据。它们仍没有终态事件或最终JSON，分别在180.414、180.416秒超时。最后已结束工具到预算退出的观测间隔分别26.417、20.634秒；没有未关闭的command_execution。该间隔包含后续模型/网络/客户端等未知工作，不能归因于Runtime退出问题或纯推理耗时。

三次Harness会话均读取宿主共享记忆，三个直接实现会话未观察到对应读命令。客户端入口指纹没有冻结共享记忆及完整环境，这增加解释边界；未在试验中改配置或删记忆。失败分类、工作项状态、工具事件和时间点分别保存于workflow-diagnostics.json、completion-events.json、context-observations.json及comparison.json。

与上轮同三题观察比较：直接实现完整交付2/3变3/3；Harness功能2/3变3/3，工作流完成0/3变2/3，但完整交付仍0/3。两轮均只有一组配对试次，未控制或分离模型、网络、环境和共享记忆影响，不作因果/普遍收益结论。

## 验证与用量

- audit.valid=true、mode=real、samples=6；report.ok=true、pairs=3、censoredPairs=3，所有失败和超时保留。
- V1：node --test verify.test.mjs，1/1通过，0跳过/失败/取消；证据8404f704-d333-475d-ace1-54cd4be76e61。核验授权分母、CI早于启动、协议/来源/候选/预算、历史SHA、入口提示、实际finish及四阶段和生命周期。该脚本没有模型调用。
- V2：最终node --check verify.test.mjs通过；证据ddb45f5c-ddb1-4878-9d41-a0c6ad88b7a0。初版语法证据保留，新增共享记忆/未关闭命令观察后运行最终语法；没有重复全套产品测试。
- 完整差异同一AI中风险自查，不作为独立复核；凭据模式扫描未命中。
- 直接实现组三样本CLI用量完整：累计inputTokens370735、outputTokens8475；Harness组三样本均缺完整用量，累计保持null，不计为0，不换算货币费用。6个CLI会话不等于6次HTTP请求，底层请求数及实际账单金额未核验。

建议下一步仅用已有记录调查成功finish/check之后到终态事件之间的工作，并针对共享记忆环境边界设计控制方案。当前不追加真实会话、不放宽180秒/80工具预算、不降低评分或完成门禁。

本次仅新增本工作项记录、原始脱敏协议、候选及诊断产物；没有修改产品源码、依赖、权限、题目、评分或预算，没有提交或推送、部署或发布。最终工作项及本地门禁结果见state.json和final-check.json。
