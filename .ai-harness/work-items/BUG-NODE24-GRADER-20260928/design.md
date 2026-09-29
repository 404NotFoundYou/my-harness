# Node 24 判定器权限标志兼容修复

基线：benchmark评分器将子Node固定为`--experimental-permission --allow-fs-read=<临时评分根>`，Node22接受，Node24报bad option并在任何隐藏用例执行前退出9。Ubuntu Node24的Benchmark框架CI作业失败；GitHub公开日志API403，因此本地Node24复现是错误文本来源，不冒称远端失败的内部堆栈已独立取得。

最小方案：在`gradeCandidate`构建子进程参数时用当前Node自身的`process.allowedNodeEnvironmentFlags`确定是否支持`--permission`；支持时选新名称，否则保留旧`--experimental-permission`。保留`--allow-fs-read`仅指向评分临时根，不授予写权限、不在不支持权限模型时降级为无沙箱运行。Node20旧标志由官方版本文档确认；Node22本机两标志均可识别，Node24仅新标志可识别。

测试WHY：参考候选在相应Node上应能完成隐藏用例，恶意候选尝试读取评分根外的本仓库测试文件必须得到`ERR_ACCESS_DENIED`，证明不是删除权限隔离来掩盖坏参数。Node22通过Runtime计划检查与全量benchmark；Node24由宿主现有二进制执行相同显式测试（Runtime guard对该绝对路径为ask，不能伪装Runtime验证）；远端Ubuntu/Windows矩阵在新提交正常推送后核对。当前工作项为BUGFIX，高风险独立审查、static/sandbox/reproduction/regression门禁必须真实登记。无数据库或业务API数据影响，不增加依赖或模型调用。

独立审查发现既有风险：评分子进程仍继承父进程全量环境变量，Node权限模型不是恶意代码隔离；本修复只恢复跨版本权限标志并验证node:fs越界拒绝，不能对环境变量或其它访问途径给出隔离承诺。环境最小化和结果脱敏需另立高风险项，未经本次授权不修改。
