# 实验断点续跑与可靠保存

基线main@800ed3e，Runtime1.5.0，仅上一轮ANALYSIS记录未提交。本轮版本1.6.0，完整ITERATION、单AI实现、高风险独立复核。目标是恢复未启动试次并保留真实中断，不调用付费模型，不自动重试未知调用。

## 协议与身份

新建实验使用协议v4，明确suite core/project，默认core题目、分组和调用数不变。旧v1/v2/v3继续按旧规则审计；没有started记录的历史目录拒绝续跑，不推断或升级旧状态。CLI新增--resume，使用原全部模型、客户端、题集及预算参数；--resume与--dry-run组合明确拒绝，避免将总计划数误报为剩余调用数。

冻结完整计划、题库manifest、源快照、mode与driverIdentity。真实CLI记录入口realpath、入口SHA256及Node版本；模拟默认以函数源码SHA256标识，可声明稳定模拟身份。指纹不覆盖CLI加载的全部依赖、闭包捕获值、全局配置或远端模型别名实现，不据此宣称完整环境一致。

## 单写者与持久化

protocol/result/summary及execution.json使用现有atomicWriteJson的同目录临时文件与rename。此处保证进程中断下的原子可见性，没有新增fsync或断电持久性保证。初始化protocol与ledger不完整时拒绝恢复；新实验目录仍必须不存在。

每目录复用既有withFileLock，timeout0使活锁/并发调用立即拒绝。resume只对同机确定已退出的所有者，使用inspectLock与recoverLock的token认领机制恢复；未知/异机/PID存活不回收。回收前只读验证，释放再获取锁后必须重新读取并完整验证，不能沿用解锁窗口前的数据。

execution.json绑定protocol原字节哈希，精确覆盖全部schedule。状态为pending、started、completed、interrupted。启动前原子写started，之后才创建试次和调用驱动；成功保存并审计结果后写completed及result原字节哈希。completed包括有可信结果的失败样本，不代表模型完成正确。started有可信result可通过共同auditTrial恢复completed；确实缺result才保留interrupted和用量未知，不重跑。interrupted不能回到pending。

续跑先检查整份ledger及所有已存在试次，再执行任何pending。pending已有目录/结果、completed缺结果/哈希错误、started存在损坏结果、额外/缺失试次、类型或预算漂移均硬失败保留现场。源码在每项前、每项结束且登记completed前再次检查；漂移时不登记可信完成。runCase拒绝已有试次目录。

独立初版审查复现调用方在ready回调修改原plan后，执行仍引用该可变对象，导致先按未冻结模型/预算调用再被审计拒绝。已CLI记录失败并reopen到revision2。实现改用重新构造并校验的独立计划、从已读取协议选择试次与模型，对身份及传给驱动的预算复制；回调不能通过原对象改变批准参数。新增实际模拟反例同时改变模型、预算、schedule及driver收到的预算，核验后续调用及结果仍使用原值。

第二轮独立复核进一步复现CLI入口变更时结果先发布、外层才报错，恢复代码可能将该结果登记completed。已记录失败并reopen到revision3。源和CLI身份在result原子发布前通过受控回调复核，漂移时不发布可信结果；还原入口后也只能保留该试次interrupted，不能复用或重跑。源码漂移遵守同一规则，保留原异常与未知用量。

## 审计与摘要

提取共同auditTrial，供完整审计与续跑复用：同时验证mode/client/模型预算/题库/候选/工作流和真实模式的原始协议。避免仅凭result文件存在就跳过调用。历史v1-v3语义保留，新v4额外核对ledger与结果哈希。

summary可从ledger及已验证结果重建。notRun只含pending；interrupted单独列出，不隐入成功样本。每组另显示scheduled/completed/interrupted/pending/usageUnknown数量，原统计只针对已完成结果，不能将其条件通过率解释为全部计划通过率。全部试次都有可信结果且源码未漂移才complete=true；保留中断时CLI输出incomplete并非零退出。现有audit默认仍拒绝把不完整实验作为完整实验通过。

## 验证与交付

新增模拟测试覆盖启动前、驱动执行中、result写后而ledger/summary未完成的中断；至少一个独立子进程硬退出用例覆盖失活锁与结果恢复。已完成试次和失败样本不得重复调用；后续记录损坏必须在任何新调用前拒绝。覆盖原子写失败、非法路径/链接、并发、源码/预算/driver漂移、所有中断/用量未知统计和旧18样本审计。实际异常和失败证据保留。

完整本地回归及独立复核对应同一产品快照，工作项DONE/check --ci后提交推送，再核验该提交Windows/Ubuntu CI。未经新的明确授权不运行真实参试模型。
