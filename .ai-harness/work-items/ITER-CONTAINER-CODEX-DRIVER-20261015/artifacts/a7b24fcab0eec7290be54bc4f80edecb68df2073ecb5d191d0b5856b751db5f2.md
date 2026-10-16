# R2 独立高风险复审

独立复审结论：**PASS，无待返工发现**。审查目标为源码摘要`caac602ac083d8cfb8015419ef664d802a6c33c15d2aaa893c15338435160801`，独立子代理只读审查，未修改文件、连接Docker、调用模型、下载或安装。

## 原发现关闭

1. manifest固定wrapper/platform integrity；首次身份加载用无网络、无挂载、只读、非root、无capability的identity容器实测Node/CLI版本和CLI/native SHA。后续只以manifest SHA、image ID、OS和架构重验。
2. identity与runtime在create前分配UUID名称，create任意失败都执行`rm --force --volumes`；`No such container`作为幂等清理成功。
3. spawn、stop、remove错误使用数组聚合。独立反例同时注入三类失败，最终证据完整包含三项且`completed=false`。
4. inspect严格核对tmpfs完整flags、PidsLimit、Memory、NanoCpus、RestartPolicy及既有网络/用户/readonly/privileged/capability/port/mount边界；五组弱化反例均拒绝并清理。

## 新增设计复核

- status传入冻结expected identity，只执行image inspect，不create/start客户端，保持只读语义。
- manifest SHA、image ID及start前container inspect封闭身份和配置漂移窗口。
- Docker失败不回退host；正式路径无pull/build/install/凭据或宿主`.codex`挂载。
- MCP/Apps/web禁用参数完整；Docker错误不保存原始stderr、环境变量或宿主mount路径。
- host参数顺序、CLI identity、历史schema v4、resume/status兼容测试通过。

## 实际验证与边界

- V1：79项，70通过、9个Windows下POSIX跳过。
- V2：164项，155通过、9个平台跳过。
- V3：1/1，核对514个历史文件SHA。
- 额外纯mock反例与真实Docker安全字段探测通过。

剩余未验证：真实预构建Codex镜像、provider、凭据、模型、MCP/Apps/web；9个POSIX进程组测试需远端Linux CI。本复审未运行最终`check --ci`。
