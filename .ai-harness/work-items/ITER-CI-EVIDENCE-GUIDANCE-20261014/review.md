# R1 当前修订差异自查

ITER-CI-EVIDENCE-GUIDANCE-20261014 / T1 / R1 / revision2，中风险，primary-ai同一AI自查；未作为独立复核。对象源码b7bcb820cf7a84c0a914c48304629b610b3d3059d5dfebba48c2dd0da5e07719。

审查范围为driver-process fixture、verificationReport/assertCommandEvidence、guide直接调用、guide/compact回归及usage契约。生产驱动和子进程预算不改；schema慢准备已在既有测试及同一路径重现，watchdog只拥有spawn后的child。定时器在finally清理，mock与平台属性按原样恢复。

命令引用原valid谓词与HEAD对应函数逐字符相同。commands只投影既有当前成功报告中匹配计划的命令；不包含stdout，不改变证据验证。增加的详情不吞异常或让非计划/失败/过期命令通过。guide的建议和占位模板仍需真实阶段语义判断，未自动替模型选择业务结论。

修订2全部六个计划命令绑定同一当前源码并实跑通过；Runtime207项零跳过，基准112通过9 POSIX平台跳过。同一目标已通过验证不额外重复。244历史文件SHA保持不变，root新增模型调用0；未把旧失败样本修补为成功。

同机只有Windows/Node22实测，远端矩阵待后续提交验证。R1 PASS，无当前本地返工项；正式终态由CLI记录并以check --ci确认。
