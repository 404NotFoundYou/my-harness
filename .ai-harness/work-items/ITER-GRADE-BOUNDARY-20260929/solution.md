# 隐藏评分器环境与结果诊断边界

基线：codex/optimization-p1-p3@5865bf9。gradeCandidate 通过 spawnSync 的 env 展开 process.env；生成的 judge 收集异常栈，parseGrade 保留 cases 原对象；runCase 将 grade 写入 result.json。调用方和审计依赖 case id/pass、complete/ok、exitCode/timedOut；现有权限测试还依赖 ERR_ACCESS_DENIED 标识。题目/参考解不读取宿主环境变量。

方案：仅改 benchmarks/runner.mjs、直接测试和相应 README 段落。评分子进程以空环境启动（绝不复制宿主 env）；保留直接 execPath、cwd 与原 Node 权限标志。judge 对失败用例只给固定文本，权限拒绝由测试候选自行检查 Node 拒绝读取的事实，落盘错误不声称可信原因；parseGrade 只投影预期的 id/pass/安全错误，丢弃任意额外字段和自由文本。grade.stderr 和启动错误以固定标识替代原文；exitCode、timedOut 和评分真假不变。若本地或矩阵证明某平台启动必须具备系统键，再只加入经验证的非敏感键，不恢复全量继承。

接口/兼容：result.json 的 grade 结构保持，但失败详情不再包含候选原始栈或 stderr。这是刻意的诊断信息收缩；原依赖原始栈的检查改为受控候选内部断言；独立审查后进一步明确只覆盖 grade 字段，不保证 run/整个 result.json 无候选自行产生的内容。候选代码、协议等其他产物仍照既有流程保存，不宣称完成恶意代码隔离或所有路径的敏感信息防护。无数据库影响。

验证：先以虚构 canary 构造应失败的回归测试，覆盖父进程 env、异常/标准错误以及伪造协议字段，再让相同测试转绿；正常参考解、权限范围测试和完整 benchmark 测试保持通过。仅实际运行的平台/Node 版本可声明通过；CI 矩阵另行由推送触发，不因本地单机通过而宣称跨平台通过。高风险差异需独立复核。
