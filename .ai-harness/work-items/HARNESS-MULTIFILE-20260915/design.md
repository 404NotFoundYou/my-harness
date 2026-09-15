# 多文件工程BUG评测

基线main@062ea90，Runtime1.4.0。用户接受多文件评测方向，单AI实现、完整ITERATION流程，高风险批次由独立上下文复核。版本1.5.0。本轮工程夹具由公开规格构造，不声称来自真实生产事故；模拟驱动证明框架行为，不证明模型收益。

## 题目与入口

新增显式 `--suite project`，先包含一个列表分页BUG题。两个可写实现为src/repository.mjs（筛选未归档记录、稳定排序且输入不变）和src/pagination.mjs（先筛选排序、游标排他、页尾语义、分页大小校验）。固定caller封装对外结果、limits提供上限、公共测试和TASK.md只读。完整参考实现通过全部隐藏用例，分别保留任一旧模块的部分修复都必须失败；隐藏验收也覆盖pagination直接契约。

默认core保持原三题、九调用默认计划、协议v2及candidate.mjs布局，旧tasks.mjs不改。project使用协议v3，保存可信题库的entry/name/type/writableFiles以及原题目/判定哈希，源码快照保留。runExperiment在创建输出/调用driver前验证计划和题集。project的参与者提示与AGENTS一致使用BUGFIX及复现/回归阶段；core提示不变。

## 候选与独立验收

从可信题目获取精确writableFiles，限制普通src下.mjs相对路径，不接受越界、重复/大小写冲突、未知候选键或只读文件覆盖。候选收集检查词法路径所有父组件和最终文件，拒绝链接或junction，使用fatal UTF-8解码保留字节；缺失/非普通文件/无效UTF-8保存明确状态，未知IO错误显式中断。

project保存candidate-files.json：schemaVersion1，每个声明路径的状态/正文或原因/字节哈希，以及结果内整体digest。缺失候选不能从task.files回退到原实现。独立验收只用原始冻结文件构建判定树，所有可写路径由本次有效候选填入；任一缺失或无效直接失败。只读caller/limits/测试都来自可信题目，参与者篡改仍scope失败。保留现有Node权限及5秒判定超时，不声称新增对恶意参试者的系统隔离。

共享的题集/路径/manifest与候选校验用于runner、experiment、audit，避免不一致。audit v3从可信suite验证完整协议元数据，核对候选精确集合、状态、各文件原字节哈希和整体digest；同时保持v2的原始协议/summary/统计校验，旧v1/v2规则不重新解释。

独立最终审查在初版复现：题目要求BUGFIX，实际用ITERATION正常DONE且无复现/回归阶段仍会得到success。已记录真实失败审查并CLI reopen至revision2。project新增共享workflow契约：至少一个开发项、全部开发项类型匹配冻结BUGFIX且DONE，已完成任务writeScopes并集覆盖题目全部writableFiles；ANSWERED分析项可共存。评分保留原checkProject证据校验，再附加此类型/范围契约；v3审计读取归档state/plan重算并交叉校验。默认core不改变。该约束拒绝错误类型或与题目无关的工作项，不扩展为全过程语义重放。

## 本地持久化与验证

只有可选新题集、实验协议和候选布局变化，无外部数据库、迁移、权限配置或付费模型调用。旧文件和历史哈希保留。涉及文件覆盖的模拟操作仅在自建临时目录内执行；控制面只通过CLI维护。

新增回归先红后绿：两文件协同修复、直接调用与caller兼容、默认/新题集预算、丢失/目录/父链接/非法UTF-8、只读文件篡改、候选损坏审计、错误协议及两组模拟完整执行。Harness模拟组实际建立BUGFIX、执行公共测试、记录真实static/sandbox/reproduction/regression并finish/check；显式标为simulated。原15个框架用例包括历史18样本审计继续通过，完整Runtime分批回归并更新源CI覆盖新测试。最终独立审查、工作项DONE、check --ci后提交推送，再核验对应远端CI。
