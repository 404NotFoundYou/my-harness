# Docker 容器宿主文件不可见性实测

本轮按用户“根据建议执行”完成 `c3cc85a` 远端验收和现有 Docker 环境中的最小隔离实测。产品文件未修改。工作项回答完成只代表证据化诊断完成，不代表 Windows sandbox、容器内 Codex 或外部 MCP 已完成隔离验证。

## 远端 CI

GitHub API 对 `c3cc85afb5ac16efdaa67c2112c56d9944e7b7ca` 的两个 workflow 及全部 9 个 job 核验成功：`Harness source tests` 的 Ubuntu/Windows × Node 20/22/24 六组，以及 `AI Harness` 的 Ubuntu Node 20/22/24 三组均为 `success`。Ubuntu job 中 Windows 专用步骤按条件跳过，不算在 Ubuntu 执行过 Windows 兼容测试。结果见 `remote-ci-final.json`，不能外推到后续提交。

## 容器实测

只使用本机已有的 `postgres:18.6-alpine` 镜像，固定镜像 ID 为 `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`；Docker Desktop server 为 `29.4.3`。创建四组宿主可读的合成文件，但只把临时工作区和合成 `CODEX_HOME` 挂载到容器。容器参数包括 `--pull never`、`--network none`、只读根文件系统、用户 `65534:65534`、`--cap-drop ALL`、`no-new-privileges` 及资源限制。

Docker 实际检查显示两个 host bind 均只读；镜像声明的 PostgreSQL 数据目录由容器内 tmpfs 覆盖，没有 host-backed volume。容器内结果为：工作区与合成记忆正对照可读，未挂载的外部文件和合成宿主记忆路径不可读，两个 bind 和根文件系统都不可写。执行后容器已删除，镜像、容器和 volume 清单与执行前一致。

本轮真实模型调用 0、真实记忆路径访问 0、镜像拉取 0、包安装 0。没有挂载真实用户目录、真实 `.codex`、账号或凭据；没有修改真实 ACL。

## 失败与清理

首次探测发现镜像声明的 `/var/lib/postgresql` 自动创建匿名 volume。挂载集合断言正确失败，容器被删除；首次异常清理没有带 `--volumes`。随后通过 Docker volume create 事件、创建时间、匿名标签和无容器引用精确确认本次生成的唯一卷，再只删除该卷；历史卷未动。删除前的 PowerShell 身份检查因空标签值和 `DateTime` 类型转换先后两次中止，期间均未执行删除，最终修正检查后才删除。失败结果和清理证据均保留。

第二次探测已用 tmpfs 覆盖镜像卷，但错误检查了 `HostConfig.Tmpfs`；`--mount type=tmpfs` 的实际证据位于 `Mounts`。该断言失败后，异常清理已带 `--volumes`，没有新增 volume。改为检查实际 mount 类型后最终探测通过。

编辑诊断脚本时，`apply_patch` 的 PowerShell 管道方式先被 UTF-8 参数校验拒绝，直接传递完整补丁又超过 Windows 命令行长度；两次都发生在文件写入前。之后改用直接 patch 可执行入口并拆分补丁，最终脚本经 `node --check` 通过。

## 结论边界

已证明当前 Docker Desktop 与该既有 Alpine 镜像在明确挂载配置下，只暴露两个指定的只读合成目录，未挂载合成宿主路径不可见。该结论不能证明容器内 Codex/Node、Windows restricted-token sandbox、真实记忆目录或外部 MCP 工具链同样隔离。

本机没有 Node/Codex Linux 镜像。继续验证实际 Codex 执行器需要新增镜像拉取或包安装授权；本轮没有越过该边界。原 `ITER-MEMORY-PREFLIGHT-20261015` 的 `ready=false` 仍保持，不因本次通用 Docker 挂载验证变为通过。
