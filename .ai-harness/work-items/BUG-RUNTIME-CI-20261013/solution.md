# Runtime跨平台CI修复

基线 main@58110f1。旧运行 AI Harness 38350727565 的 Ubuntu Node20 Runtime 原始日志：installer.test.mjs 的 linked docs 用例期望 SYMLINK_WRITE，实际 getGitBaseline → fileFingerprint → readFile 先读目录链接，抛 EISDIR。Windows运行38350727620、job115142276872：Runtime202项195通过7失败；三项原安装故障注入和四项并发对象用例未触发注入，出现 Missing expected rejection / injected=false。基准98项89通过9平台跳过0失败。

方案：Git指纹先lstat，符号链接只哈希readlink返回的链接文字，普通文件仍哈希字节，删除仍为null；不读链接引用对象。安装测试临时目录工厂返回realpath后的路径，使测试注入与生产安装器规范化路径一致。用自建目录别名重现注入未命中，不放宽拒绝、数据保留或回滚断言。两项均先建立失败回归，再修复。无数据库、依赖、公共命令、生产数据或部署影响。

写入仅 git.mjs、git-state.test.mjs、installer.test.mjs。本地计划覆盖Git状态专项、安装专项、Runtime全套及两文件语法；完整差异与高风险批次独立复核。流程采用项目既有约定：开发工作项DONE对应本地代码验收与冻结源码，并不声称尚未运行的提交后远端CI已通过；最终用户目标仅在推送后两条完整矩阵成功时交付，取消/失败/未执行不作为成功证据。远端结果按同一代码快照核对，若失败正常返工重验。

原始失败日志通过既有Git凭据读取，凭据仅存在请求内存，未输出或保存；此文仅保留非敏感诊断，不复制凭据或认证URL。

独立R1复核实测旧基线类型碰撞后正常reopen到revision2：链接指纹使用symlink:<sha256(readlink)>，普通文件保留原纯SHA-256，删除仍null。旧链接的无类型指纹不被当作新指纹相同以吸收当前类型；旧脏普通文件未变化继续兼容。新增scope真实调用回归先红（956e8417）再绿，防止与链接目标文字相同的普通文件被范围外替换而漏报。
