# R1 修复后配对复测产物自查

MODEL-PROJECT-V2-RECHECK-20261014 / T1 / R1，中风险、primary-ai同一AI自查，不作为独立复核。源码b7bcb820cf7a84c0a914c48304629b610b3d3059d5dfebba48c2dd0da5e07719。

核对先于实际调用的CI API记录、六个started/finished和complete及宿主退出0、模型/CLI/预算/任务和判定哈希、候选与原始协议、BUGFIX归档状态/计划/命令、实际guide响应及旧267文件。无补跑、新模型、预算扩大或产品源码改动。

功能基准3/3、Harness2/3；完整交付基准2/3、Harness0/3；四项超时与配置层叠Harness7项隐藏失败完整保留。三个历史/当前Harness未完成状态没有被root验收替换为DONE。

误将finish --help计作调用的派生诊断已经修正，并再次实际运行V1/V2通过；原始记录字节不变。当前真实finish调用0，所以未宣称实际收尾引用修复成功。归档分页guide返回的T1/V1证据与真实run相符；推荐不是完成授权。

比较局限清晰：单轮样本，两个组都更慢或出现超时，不能孤立归因于Runtime、模型或网络；截断时长、未知用量和实际收费均如实记录，holdout只评估。R1 PASS，实验产物交付无阻断；三个参试Harness BUGFIX仍未完成。终态及最终check --ci由CLI确认。
