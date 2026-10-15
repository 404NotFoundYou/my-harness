# 下一阶段：容器化 Codex benchmark driver

推荐选择外层 Docker 作为 benchmark 的唯一强制文件边界，不为通过测试而放宽 Docker seccomp 或授予 `SYS_ADMIN`/`--privileged` 来启用 nested bwrap。内层 CLI 运行时明确使用 sandbox bypass，并由容器运行参数承担隔离；这与当前已验证路径一致，且避免叠加一个在 Docker Desktop 默认配置下不可用的嵌套沙箱。

新 driver 必须固定 Node 镜像 manifest digest、Codex wrapper/platform tarball integrity 和 CLI/native binary SHA。构建下载阶段与运行阶段分离；正式试次使用 `--pull never`、无网络、只读根文件系统、非 root、无 capabilities，只挂载题目工作区及必要合成配置。不得挂载宿主用户目录或真实 `.codex`。

运行前预检应重复记忆正反对照、固定工具调用、Docker inspect 挂载清单和环境摘要。运行后必须确认容器、volume、临时包及试次进程全部清理。任何身份漂移、额外挂载、网络开启或未覆盖执行器都阻止放行。

MCP、Apps、web search 和其他外部执行器应在 benchmark 配置中默认禁用；若业务必须启用，需为每个实际执行器单独证明它运行在同一容器边界内。仅检查 Responses 请求中的工具名称不足以证明执行位置。

实现后先运行零模型模拟回归和跨平台 CI。只有容器 driver、清理、环境身份和执行器覆盖全部通过，才可将 container 模式纳入预检；真实付费模型实验仍需另行 dry-run 冻结预算。
