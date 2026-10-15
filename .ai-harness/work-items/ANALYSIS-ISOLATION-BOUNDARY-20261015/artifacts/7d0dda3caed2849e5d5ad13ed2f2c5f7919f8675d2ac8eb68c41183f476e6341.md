# efb47e1 跨平台验收与隔离边界诊断

本轮按用户“根据建议执行”完成只读诊断和可逆临时验证。产品文件未修改，固定 Windows / Node 22.20.0 / Codex CLI 0.156.0。分析结论完成不等于文件访问隔离完成，最终状态和门禁以 state.json、final-check.json 为准。

## 当前提交的远端结果

GitHub API 对 efb47e1746e6832a44d51ab200e5a0e04483b7b9 的两个 workflow 及全部 9 个 job 核验成功：Harness source tests 的 Ubuntu/Windows × Node 20/22/24 六组、AI Harness 的 Ubuntu Node 20/22/24 三组均 success。Ubuntu 源码 job 的 Windows runtime compatibility 步骤按条件跳过；不算已在 Ubuntu 运行该 Windows 步骤。没有重跑远端任务。结果见 remote-ci-final.json，属于上述提交，不能外推到以后修改。

## 两个阻塞的原因和实际验证

现有文件探测在 benchmarks/preflight.mjs:42 只为唯一临时 profile 设置 extends=:workspace，没有显式拒读条目。0.156.0 对应源码 core/src/config/permissions.rs:79、215 将该内置 profile 解析为 workspace 策略；protocol/src/permissions.rs:807-816 的策略包含根目录读取权限。因此旧结果的外部文件可读与所选策略一致；它证明当前基准需要的宿主记忆隔离没有达成，不能单凭这一结果认定 Windows 沙箱违反了它所配置的读取策略。

离线 debug prompt-input 的 0.156.0 源码 cli/src/main.rs:2478-2501 注册 Git attribution 和 skills 扩展，没有注册 memories 扩展。core/src/prompt_debug.rs:89 说明它不进入 run_turn。真实临时目录中的五个离线场景均通过诊断断言：v1 开启、v1 关闭、v1 use_memories=false、v2 开启时普通上下文标记均可见，记忆标记均不可见；把标记明确写入普通指令时则可见。这支持“离线调试入口无法建立此记忆正对照”，不支持“真实运行从不注入记忆”。

为补齐真实运行路径的上下文证据，probe-runtime-context.mjs 创建只监听 127.0.0.1 的固定响应器，使用合成 CODEX_HOME 和 v1 记忆、保留模型标识 gpt-6-astra，将两次实际 CLI exec 连接到该本地 provider。响应器只返回固定 SSE，不推理、不转发；环境不携带认证变量，两个请求均无 Authorization。两次模拟会话各收到一个本地请求并正常 turn.completed，无工具调用。开启时请求包含合成记忆，--disable memories 时消失，两侧普通上下文均可见。结果见 runtime-context-diagnostic.json。

本轮真实模型调用 0，模拟 CLI 会话 2；不能称为“没有启动 CLI 会话”。这个正反对照只证明固定 CLI、合成 v1 记忆和本地 provider 请求的注入开关行为，不证明真实模型行为、v2 实际运行、宿主文件拒读、外部 MCP 或完整工具链隔离。原 preflight 没有接入该模拟路径，原 release-preflight 的 ready=false 原样保留。

## 实际验证与未完成项

- 远端 9/9 job 成功，5 个离线诊断场景符合预期，2 次本地模拟会话完成正反对照。
- 重新计算的 514 个历史文件 SHA 全部相同；Git 确认产品文件差异为 0，新增文件仅在本分析项中。
- 两个诊断脚本只读取合成记忆，不读取宿主真实记忆正文。助手开工时按上下文指引搜索过宿主 MEMORY.md 记忆索引；该背景读取不属于沙箱探测，也不构成隔离证据，未将索引正文写入本分析项或本地响应器。
- 没有修改用户配置、真实 ACL、账号、凭据、已安装 CLI、依赖、评分或预算。临时目录和本地响应器已结束并清理。
- Docker 已安装但 daemon 不可连接；WSL 仅发现 docker-desktop。docker desktop start --help 被自动审批策略拒绝，理由仅为 blocked by policy；命令未执行，未尝试替代入口。容器隔离方案未实测，宿主文件隔离仍未验证。
- 初次源码抓取包装脚本因 require 与顶层 await 混用失败，发生在抓取/写入前；改为 ES module import 后全部所列源码抓取成功。该工具错误没有被算作验证通过。

后续只需推进剩余文件访问隔离验证，具体边界见 next-isolation-plan.md。最终本地门禁成功也不会将此未完成项改写为隔离成功。
