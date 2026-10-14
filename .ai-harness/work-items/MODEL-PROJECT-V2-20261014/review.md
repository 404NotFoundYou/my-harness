# R1 project-v2 实验产物自查

MODEL-PROJECT-V2-20261014 / T1 / R1；medium风险；primary-ai同一AI自查，不作为独立复核。源码摘要9d93c4763757e8a01f18f33bb53bd8a67ead48406d1ff83af3a13f747ea3f053。

核对宿主6个started、6个finished及complete、退出码0；无resume、补跑、追加模型或预算变更。V1与V2均实际通过且绑定当前源码，六项模式/参数/源码/CLI/题目/候选与协议一致，历史161文件SHA保持不变，写入仅在本工作项。

两组各36/36隐藏用例通过；直接实现3/3共同/完整交付；Harness三个会话均超时且流程未完成，阶段完成记录未登记。三个finish拒绝COMMAND_EVIDENCE_INVALID，复现引用成功但没有计划检查匹配；配对报告和摘要保留功能与流程的差异，不把父实验验收当作子BUGFIX完成。

核对风险边界：三题都是合成BUG夹具，holdout未用于调参，输入/输出token未知值保留未知，截断观测不作为真实完成时长。未替换或修补失败样本、未修改产品源码、未降低证据门禁。独立复核、隐藏判定重跑、源码全套重跑和实际账单核验未执行。

R1 PASS，实验产物交付无阻断；三个参试Harness BUGFIX仍未完成。收尾结论由Runtime finish及项目check --ci记录。
