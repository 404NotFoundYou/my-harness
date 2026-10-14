# project-v2六会话多文件BUGFIX真实配对试验

单AI协调一个纵向实验，复用现有runner/audit/report和隔离沙箱。project-v2三题、paired单轮、两组同用gpt-6-astra，180000ms/80工具/medium。先冻结dry-run与源码、CLI和历史哈希；宿主直接执行已明确授权的模型入口，不伪装测试绕过策略。验收脚本只读取实际产物，核对候选manifest、原始协议、BUGFIX归档状态/计划/阶段及命令证据；功能或流程失败仍为有效样本，不要求Harness胜出。

数据库无影响依据：仅合成工程BUG沙箱与实验产物，不涉及真实数据库、业务数据或产品接口变化。
