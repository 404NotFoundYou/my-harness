# Core评测的结构化任务入口

基线main@36a8f05 / Runtime1.8.0。最近的真实core对照中，Harness组csv与allocation的候选实现各通过12/12隐藏用例，但三组都因180秒超时留在IMPLEMENTING。事件反复显示AMBIGUOUS_WRITE_SCOPE、SHELL_VERIFICATION_UNSUPPORTED、OPTION_REQUIRED；这只证明命令声明错误与收尾缺失，不能归因全部耗时或推断通用收益。

只针对core题的Harness参与者生成一个独立于冻结任务files的输入文件`.ai-harness/work-items/benchmark-begin-spec.json`。`runCase`在创建参与者和提交固定Git基线后、启动驱动前原子创建它；普通组、project题不生成。该路径是工作项根目录下的普通输入文件，不是state/plan/evidence，不与实际工作项ID目录冲突；现有候选范围仅将Harness工作项控制面排除。固定任务Manifest、题目/判定器哈希、预算、模型、客户端协议不变。

从当前公开task entry与TASK.md生成`id`、ITERATION类型、references、公开验收、授权来源、无数据库依据、writeScopes=[task.entry,test/extra.test.mjs]、verification=[{command:'node',args:['--test','test/public.test.mjs']}]、不改文档依据。只留下`risk`与`approach`为空字符串，模型需依据任务实际选择low/medium并填写实施方案后方可通过现有loadBeginSpec验证；不能由程序编造根因、实现方案、验证结论或验收事实。入口文件不从测试或隐藏判定生成候选答案。

Harness提示准确指出输入文件、两处必须填写的字段和`begin --spec <项目内路径>`的确定命令；创建后按现有`guide --id <冻结任务ID> --task T1 --json`与`run --all`获取剩余实际步骤及证据引用，只有真实检查通过才用finish完成。不增加状态跳跃、宽松权限或自动声称完成。对标组现有提示不变。

红绿回归：测试源基线两组公开任务输入一致，Harness仅多该结构化控制输入；风险/方案空白时CLI拒绝且没有部分工作项；模型填写真实判断后CLI可创建，计划范围与检查参数精确，候选更改与回归按原证据完成至DONE；外部/逗号路径、shell拼接等未被引入。旧v1-3历史审计和当前六样本已完成v4审计都可直接运行；不触碰其文件。完整benchmark/Runtime回归、独立审查和check --ci通过后交付。真实模型复测需新的单独费用授权。
