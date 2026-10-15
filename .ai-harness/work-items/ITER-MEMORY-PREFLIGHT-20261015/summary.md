# 2026-10-15 共享记忆关闭、环境摘要与零模型预检

已完成本轮预检工具和记录实现，新增真实模型会话0；本机实际隔离未通过，最终ready=false、CLI退出2。工作项完成只表示已实现并如实交付预检，不表示共享记忆已隔离，也没有启动付费复测。

## 实现

- Codex公共驱动统一加入--disable memories，两组共用参数；其他客户端、题目、提示、评分、180秒/80工具均不改，不修改用户默认配置。
- 新codex-environment模块保存版本1的选定输入摘要：平台/架构、记忆参数、用户配置和全局指令、记忆文件、skill/plugin manifest与目录/链接身份，以及Node CLI包清单。只保存SHA和文件身份，不保存配置或记忆正文；auth、插件资产、一般环境变量、远程MCP数据及完整工具链不在覆盖范围。
- 新Codex CLI实验在driverIdentity.environment记录摘要并于试次边界重新采样。漂移时在继续调用前拒绝，保留旧四字段身份与v4协议；默认cliIdentity调用不自动添加字段，旧实验保持只读。摘要不是文件锁，不能证明运行中没有变化或完整环境相同。
- 新preflight.mjs只允许version/features/debug/sandbox探测，不调用模型exec。临时CODEX_HOME中设置普通上下文与记忆标记，正反对照分别判断；所有未验证、失败和未知都不能生成ready=true。Node CLI脚本与原生入口分别按已有驱动约定启动。
- 文件探测复用已初始化Windows sandbox，缺初始化、活跃或无法识别的deny-read状态直接拒绝调用。使用唯一临时profile继承:workspace策略，不写全局配置。工作区内外合成文件有宿主可读正对照，对真实MEMORY.md只做open/close权限探测；不读取其正文。环境摘要另行读取所选文件字节计算SHA，但不保存或发送正文。

## 当前代码对应的实机结果

release-preflight/preflight.json及release-preflight-command.json记录当前源码055ee9536da48c48a0ce1f5d54c1a4186577639f2ad7d70f9f20db669a85b1fb前后相同，固定Codex CLI0.156.0、Windows/Node22.20.0。环境摘要共433项，采样前后相同，两组模板参数及摘要相同；没有执行两组模型试次。

| 项目 | 实际结果 | 结论 |
| --- | --- | --- |
| memories功能开关 | features查询exit0，disabled=true | 已关闭功能 |
| 普通上下文标记 | 开启/关闭两侧均可见 | 提示检测器能够识别已注入内容 |
| 记忆正反对照 | 开启/关闭两侧均未见记忆标记 | 正对照不成立，不能证明真实exec自动记忆注入已隔离 |
| 工作区合成文件 | 宿主和sandbox均读到预期内容 | 控制正常 |
| 外部合成文件 | 宿主和sandbox均可读 | externalDenied=false，隔离失败 |
| 宿主MEMORY.md | sandbox可只读打开并关闭，未读正文 | memoryDenied=false，隔离失败 |
| 初始化/拒读状态文件 | 前后哈希相同 | 未用预检清空已有拒读状态；本轮未运行账户/ACL配置命令 |
| 整体预检 | ready=false，exit2，modelSessions0 | 不安排新增付费试验 |

该sandbox helper及:workspace配置不是对所有外部MCP实际exec工具链的证明。没有创建账号、迁移凭据、修改真实记忆ACL、升级CLI或用新增权限让预检变绿。

前两个原型的CLI参数被拒绝（exit2），实际探测程序未执行；这些记录保留于filesystem-prototype*.json，不把它们算作读取拒绝。0.156.0的sandbox实际要求显式权限profile，最终调用已按这一约束执行。live-preflight、live-preflight-final和release-preflight各次完整负结果均保留。

## 实际验证

当前源码055ee9536da48c48a0ce1f5d54c1a4186577639f2ad7d70f9f20db669a85b1fb；单AI中风险ITERATION，R1同一AI自查，不作为独立复核。

| 检查 | 结果 | 当前命令证据 |
| --- | --- | --- |
| 定向参数/环境/预检V1 | 15/15，0失败/跳过/取消 | ac14b99c-9799-40b4-83bd-33e26f688d4f |
| 全部12个基准文件V2 | 144项，135通过、9平台跳过，0失败/取消 | 75b85f34-460a-45e2-a614-9d2f8869b3e7 |
| 历史字节与报告兼容V3 | 1/1；514文件SHA不变；旧真实六样本仍直接交付3/3、Harness0/3，新环境字段不补造 | 7ec08494-bc3c-43f8-98c0-04a9c6a678d8 |

9个跳过均为Windows下POSIX实际后代进程测试，不算通过。新的原生CLI分支仅用模拟入口覆盖，本机实际预检使用Node脚本入口；Linux/Node20/24新代码及新远端CI未运行。单测模拟的正对照成立不覆盖本机实际正对照失败。

初次完整V2的失败证据5666f728-beb8-4ad7-bec1-985a7b3c82d8保留：一处是我扩展CLI身份错误文案破坏既有断言，已保留原错误文案；另一处为已退出所有者锁被观察为active。原失败未捕获足够PID身份信息，根因未确认，未改锁逻辑或status测试。单独两项2/2通过（12480d33-c36e-466a-8784-057a88e029e9），随后多次完整验证及当前完整套件通过，不声称已修复底层进程/PID问题。

## 范围与交付边界

开始main@7386fdbb53770df5c4755a8ed3d580004d843936，工作区干净；该提交两个workflow及Ubuntu/Windows、Node20/22/24六组CI在本工作项创建前全部成功，见ci-preflight.json。这不是本轮未推送代码的远端CI结论。

Runtime guard对独立preflight脚本返回ask/退出2，因此未通过harness run执行。用户已明确授权零模型预检，本轮由宿主直接调用该入口并记录真实参数/退出/源码，不修改Runtime允许名单、不用嵌套shell伪装。guard辅助检查最初未把2列入预期退出范围而抛异常，合法ask结果已确认；它与preflight实际执行后的ready=false/退出2分别记录。

仅修改9个源码/测试/文档文件及本工作项控制面，旧514文件保持原字节。预检和环境记录已实现，OS级宿主记忆读取隔离及实际exec完整工具链仍未完成。没有额外模型调用、费用实验、权限扩大、提交推送、部署或发布；最终工作项与本地门禁结果见state.json和final-check.json。
