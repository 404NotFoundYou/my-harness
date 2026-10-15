# Linux Codex 隔离诊断自查

本轮为单 AI `ANALYSIS`，不是独立安全审查。已复核固定输入、三个脚本、Docker inspect、六项负结果、最终四个本地 provider 请求、工具输出哈希、清理记录、远端 CI 和历史文件 SHA。

下载阶段仅访问公开 Node registry 与 npm registry；两个 npm tarball在宿主只下载和哈希，不安装。容器内通过只读 bind 将 tarball离线解压到 tmpfs。真实用户目录、真实 `.codex`、凭据、认证环境变量和真实记忆没有挂载或发送。Responses 只发往同一容器的 loopback 服务，没有外部模型调用。

最终工具验证特意区分两层：内层 `codex sandbox` 在默认 Docker seccomp 下因 bwrap user namespace 失败；成功的 `exec_command` 使用 sandbox bypass，由外层强化 Docker 提供文件、网络和权限边界。该结果不能被写成内层 sandbox 成功，也不能外推到 MCP。

失败记录没有删除或重写。临时 Node 镜像、tarball、容器和 fixture 均已清理；Docker inventory 恢复基线。当前报告可支持后续实现容器 driver，但没有修改 benchmark driver、预检放行条件、评分、预算或产品代码。
