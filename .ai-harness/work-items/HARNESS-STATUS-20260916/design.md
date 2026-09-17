# 只读实验状态与续跑预览

基线main@1d2b357，Runtime1.6.1，初始工作区干净。按用户持续授权实施此前已建议的只读预览，版本1.7.0，完整ITERATION/API高风险独立复核，无数据库/协议持久化格式变更。

## 入口与返回

新增独立 `node benchmarks/status.mjs --out <实验目录> [--cli <明确指定的CLI文件>]`，不要求重复模型/题集/预算参数。API为inspectExperiment，允许调用方提供模拟driverIdentity进行比较。默认只读实验记录，不根据不可信协议主动读取其指向的外部CLI文件；明确给--cli时只读取入口指纹，不执行客户端或检查登录。原run --resume执行入口及dry-run含义不改。

报告包含磁盘stored状态计数（completed/started/interrupted/pending）、冻结模型和预算、源码/身份/锁检查、阻塞原因、观察时间。完整验证后可附只在内存中推导的恢复结果：哪些started有可信result可复用，哪些缺结果应保留中断。observed与recoveryPreview明确分开，不假装磁盘状态已更新。列表预览有上限，计数覆盖完整计划。

只有协议、全部证据、当前源码和显式驱动身份一致，且锁为free或本机stale、读取稳定时，才给出canResume=true和remainingCalls。否则remainingCalls为null，仍可展示已验证结构中的pending计数。即使ready也只是观察时的结论，真实resume仍需获取锁并重新验证，不构成调用授权或未来数量承诺。

CLI退出码0表示得到已验证的可续跑观察；2表示阻塞/身份未确认/活跃观察或旧协议；1表示参数、缺失文件或损坏。报告输出诊断但不输出候选正文；用户字段最终递归脱敏。旧v1-v3明确不支持续跑预览，保留原audit路径，不补写ledger。

## 只读与竞争边界

复用当前v4冻结协议校验及ledger结构校验，抽出共有只读函数避免状态入口校验更宽松。实际run与readExecution沿用同一规则，旧证据字段、哈希和统计保持。

检查开始/结束时读取protocol和execution原字节与锁代次。检测到变化时撤销就绪和剩余调用结论，报告CONCURRENT_CHANGE，不自动等待、恢复或重试。active/foreign/unknown/changed/legacy锁只做结构观察，started不被转换成中断，也不把尚在写入的结果判为可信完成。free/stale才执行完整结果审计及内存恢复推导。发现损坏或漂移阻塞，不靠summary自报成功。

实现不调用saveJson、withFileLock、recoverLock或runCase；不创建目录、文件和锁。读取本身可能产生系统访问时间/缓存更新，但实验文件集合与内容原字节应不变。通过目录前后清单/哈希和禁止文件写入的模拟钩子证明只读；死锁和started记录也必须保持原样。

## 验证与交付

先红后绿覆盖pending、completed、interrupted、带result的started、活锁、失活锁、损坏/链接、源码与驱动漂移、读取过程中ledger/锁变化，以及不可信外部CLI路径不被默认读取。CLI验证无需安装客户端，仅用合成身份文件；无付费模型调用。

完成相关及全部Runtime/评测回归，独立复核和check --ci与最终源码快照一致。DONE表示本地可提交版本，随后按已有授权提交推送并核验对应Windows/Ubuntu CI。
