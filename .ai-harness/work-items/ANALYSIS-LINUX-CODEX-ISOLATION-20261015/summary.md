# 固定 Linux Codex 运行时与零模型隔离验证

本轮根据用户明确授权，拉取固定 Linux/amd64 Node 镜像并获取固定 Codex npm tarball，在一次性强化容器中验证真实 Linux CLI 的记忆控制和 `exec_command` 文件边界。产品文件未修改。分析完成不表示原预检已放行，也不表示外部 MCP 或真实模型已验证。

## 输入身份

- `b2eb725faf44f8868ab7a982a2bee2029a5c26e5` 的两个 GitHub Actions workflow、9 个 job 全部成功。
- Node 镜像 tag 为 `22.20.0-bookworm-slim`，多架构 digest 为 `sha256:b21fe589...5848e`，实际 Linux/amd64 manifest 和拉取后 image ID 均为 `sha256:c385ec4...2c6a85`。
- Codex wrapper 为 `@openai/codex@0.156.0`，Linux 平台包实际是同一包的 `0.156.0-linux-x64` 版本，通过 wrapper 的 optional dependency alias 暴露为 `@openai/codex-linux-x64`。最初猜测独立包名时 registry 返回 404，已保留于 `package-resolution-note.json`。
- 两个 tarball 均按 registry SHA-512 integrity、SHA-1 shasum 和下载后 SHA-256 核验；宿主没有安装 npm 包。
- 容器内 Node 为 `v22.20.0`，CLI 为 `codex-cli 0.156.0`；wrapper SHA-256 为 `61b0194f...92fcf70`，Linux native binary SHA-256 为 `78a11f06...5cdbe30`。

## 实际结果

容器使用只读根文件系统、用户 `65534:65534`、`--cap-drop ALL`、`no-new-privileges`、`--network none` 和资源限制。只挂载只读 package cache、探测脚本及合成工作区；外部合成文件和合成宿主记忆存在于 Windows 宿主，但没有挂载。

真实 Linux CLI 通过容器内 `127.0.0.1` 固定 Responses 服务完成三次会话，真实模型调用 0、认证头 0：

- `gpt-6-astra` 记忆开启请求包含普通上下文和合成记忆标记。
- 同一模型增加 `--disable memories` 后仍包含普通上下文，但合成记忆标记消失。
- 工具会话使用 bundled catalog 中会暴露 `exec_command` 的 `gpt-5.4` schema；本地响应器发出固定 `exec_command`，CLI 实际执行后提交 `function_call_output`，再正常完成 turn。
- 工具进程能读取只读挂载的工作区 canary；未挂载外部文件和合成宿主记忆路径均返回 `ENOENT`。工具输出正文未保存，只保存解析后的布尔结果和 SHA。

工具会话显式使用 `--dangerously-bypass-approvals-and-sandbox`，因此验证的是 Codex 工具分发与外层 Docker 隔离，不是内层 Codex sandbox。容器仍保持无网络、非 root、无 capabilities、只读根文件系统和仅合成挂载。

## 负结果

1. 最初猜测 `@openai/codex-linux-x64@0.156.0` 为独立包，registry 返回 404；读取 wrapper metadata 后改用 alias 指向的 `@openai/codex@0.156.0-linux-x64`。
2. 准备脚本首次把 `--no-trunc` 传给 `docker volume ls`，Docker 退出 125；失败发生在下载和拉取前。
3. 默认强化容器中的 `codex sandbox` 退出 1：bundled `bwrap` 无权创建非特权 user namespace。没有使用 `--privileged`、新增 capability 或放宽 seccomp 让它变绿。
4. 首次完整运行在 server handler 中直接断言 `exec_command`，未保存工具清单；容器已清理。
5. 第二次运行显示 `gpt-6-astra` 的 `tool_mode=code_mode_only` 且当前 code mode 未开启，工具列表为空；记忆正反对照实际已经成功。
6. 第三次运行已调用 `exec_command` 并收到第二个请求，但首版解析器无法读取结构化 `function_call_output`；递归解析字符串字段后最终运行通过。

这些失败均未作为通过证据。最终成功结果不能覆盖内层 sandbox 失败。

## 清理与边界

固定 Node 镜像和两个临时 tarball 已删除；Docker 镜像、容器和 40 个历史 volume 的清单哈希恢复基线。514 个历史实验文件 SHA 不变，产品文件改动为 0。

当前已证明：固定 Linux Codex CLI 的记忆开关有效，真实 `exec_command` 在外层 Docker 挂载边界内只能看到指定工作区。尚未证明：默认 inner `codex sandbox` 可用、外部 MCP/Apps 受同一边界限制、真实 provider/模型行为以及现有宿主 benchmark driver 已切换到容器执行。

因此原 `ITER-MEMORY-PREFLIGHT-20261015` 的 `ready=false` 保持不变，不启动付费实验。下一步方案见 `next-driver-plan.md`。
