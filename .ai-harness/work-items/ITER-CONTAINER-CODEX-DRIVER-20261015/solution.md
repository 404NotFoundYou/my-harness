# 容器化 Codex benchmark driver 方案

## 目标与选择

新增显式 `host|docker` Codex runtime，默认仍为 `host`。容器模式只消费已准备好的本地 digest 镜像和严格 manifest，不构建镜像、不拉取镜像、不安装包、不传递凭据，也不自动退回宿主执行。外层 Docker 是唯一强制权限边界；不放宽 seccomp 或 capabilities 来启用 nested bwrap。

## CLI

`benchmarks/run.mjs` 新增：

- `--codex-runtime host|docker`，默认 `host`。
- `--codex-container-manifest <项目内或绝对JSON路径>`，仅 `docker` 模式允许且必需。

`host` 保持现有 `--cli` 必需行为。`docker` 禁止 `--cli`，且仅允许 `--client codex`。`--dry-run` 只校验参数组合并冻结模型调用预算，不读取 manifest、不访问 Docker。

`benchmarks/status.mjs` 新增 `--container-manifest`，与 `--cli` 互斥，用于只读重验冻结容器身份；不启动模型或试次容器。

## Manifest 与身份

新增 `benchmarks/codex-container.mjs`。manifest `schemaVersion: 1` 严格包含：

- digest 形式的 `image` 与内容地址 `imageId`；平台固定 `linux/amd64`。
- `nodeEntry`、`nodeVersion`。
- `cliEntry`、`cliVersion`、`cliSha256`。
- `nativeEntry`、`nativeSha256`。
- 固定`wrapperIntegrity`与`platformIntegrity`，只接受已审计Codex0.156.0 tarball值。

所有容器路径必须是规范绝对 POSIX 路径，哈希为小写 SHA-256。拒绝额外字段、tag-only 镜像、相对路径和不支持平台。

`containerIdentity()` 首次加载时读取 manifest、记录绝对 manifest 路径和文件 SHA，先通过只读 `docker image inspect` 确认当前 image ID、OS 和架构，再启动无网络、无挂载、只读、非root、无capability的短生命周期identity容器，实际读取镜像内wrapper/native字节并运行CLI `--version`。实测值必须与manifest匹配；容器无论成功失败均按预分配UUID名称强制删除。协议冻结后，恢复/status及每个试次边界重验manifest SHA和内容地址image ID；相同image ID绑定相同镜像字节，无需重复启动identity容器。协议 v4 新增真实身份变体 `kind: container`；原 `kind: cli` 和 `kind: simulated` 结构不变。

## Runtime adapter

保留 `codexDriver()` 的协议解析、预算、最终文件诊断和日志写入。增加小型 runtime adapter：

- host adapter 复现当前 command/args/cwd/进程组行为。
- container adapter 将 participant root 映射到 `/workspace`，输出目录映射到 `/output`，再构造相同 Codex 参数。
- host 使用 `--sandbox workspace-write`；container 显式使用 `--dangerously-bypass-approvals-and-sandbox`，由外层 Docker限制。
- container 统一增加 memory off，并关闭 apps、plugins、browser/computer/image/remote-plugin 功能及 web search。

Docker create 固定：`--pull never`、`--network none`、`--read-only`、非 root、`--cap-drop ALL`、`no-new-privileges`、资源上限、tmpfs `/tmp`，只读 manifest内镜像，不挂载宿主用户目录或 `.codex`。只允许两个可写 bind：participant `/workspace` 与试次 evidence `/output`。

create 后、start 前必须 `docker inspect` 验证 image、network、user、privileged、readonly root、capabilities、security options、tmpfs完整选项、PID/内存/CPU/restart限制、mount type/source/destination/RW 和无 volume。create命令发出前即绑定按UUID名称的清理责任；即使CLI超时或断连也尝试强制删除。任何差异先删除容器再失败。

运行使用 `docker start --attach --interactive`。超时、工具上限或 leader 提前退出时先 kill 容器，再终止 Docker CLI 进程组；close 后始终 `docker rm --force --volumes`。spawn、kill和remove失败全部聚合为脱敏标量，不相互遮蔽，不保存宿主路径或环境值。清理失败使 run 不完整。

## 兼容与恢复

- 协议仍为 schema v4；只扩展 identity 联合类型，不补写历史记录。
- host 命令、参数、identity 和 status 行为保持不变。
- container 协议只能由同一 manifest SHA 和当前 Docker image identity恢复。
- status 仍只读；未提供 manifest 时 container driver 为 unverified，不能恢复。

## 测试

新增零模型测试覆盖：manifest 严格校验、image inspect 漂移、参数组合、dry-run 无 Docker副作用、create/inspect/start 参数、额外挂载/网络/用户/能力失败关闭、超时和工具上限清理、清理失败、container identity 的协议/恢复/status、host 与历史 v4兼容。使用 mocked Docker/CLI，不下载镜像、不调用模型。

运行定向测试、全部 benchmark 测试、历史 514 文件 SHA 检查和最终 `check --ci`。高风险 batch 需要独立审查；同一 AI 自查不替代独立结论。

## 非目标

不实现镜像构建、registry 下载、npm 安装、密钥传递、真实模型实验、MCP/Apps 启用、nested bwrap 修复、部署或发布。container runtime 未完成独立审查和远端矩阵前不作为可放行生产路径。
