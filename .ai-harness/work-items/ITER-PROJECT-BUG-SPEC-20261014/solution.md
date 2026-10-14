# project-v2 只读BUGFIX输入与收尾指引

完整ITERATION/API流程，单AI中风险，用户授权本地代码/提示/文档与无模型验证。基线main@2b145a3、产品工作区干净。

保持旧project与core路径，只有显式project-v2的Harness组启用工程BUG输入。runExperiment按冻结suite把上下文传给runCase；runCase与createParticipant用该确定性条件生成指引和只读benchmark-begin-spec.json。预填任务ID、授权、范围、公共检查、文档N/A理由和无数据库依据；risk、approach及bug.actual/expected/reproduction为空，不预填观察或通过结论。

CLI begin --spec允许用--actual/--expected/--reproduction给BUGFIX空判断字段赋值，沿用risk/approach的只能填空规则。非BUGFIX、缺失/空/错类型bug字段、未知结构和覆盖已有值仍在建项前拒绝。JSON输入模板schema允许空判断字符串，落入work-item的既有校验仍要求完整值。不修改工作项schema、授权/权限或阶段门禁。

项目提示给出begin、失败复现、修复与必要测试、最终run --all、guide --brief、finish和check --ci的短路径；仍按guide选择真实适用的阶段证据/计划命令，修改源码后必须重新验证。runner不自动创建或完成参试工作项，错误及超时评分保持既有语义。预填输入冻结哈希，内容修改/删除或链接身份替换一律scope violation。

用真实CLI无模型回归验证三个多文件任务的BUGFIX红复现、修复、四阶段和合法DONE，并审计六组模拟实验；模拟不代表实际模型收益。验证未填/错字段拒绝且无部分工作项、原完整spec与核心判断接口兼容、预填输入保护与旧project/baseline不变。最后运行Runtime与全部九个基准测试文件、静态/差异及351历史文件SHA保护、完整差异自查、check --ci。

不新增模型调用、不重写失败样本、不用holdout结果调参。新代码仅本机Windows/Node22验证时明确远端矩阵未跑；新实验提示属于当前源码，历史协议/源码冻结记录不改写。
