# 当前 benchmark runtime 修复方案

## 范围

本次只修复当前代码中已经确认、可局部验证的问题：

- 新旧 Codex v4 CLI 身份的 status/resume 兼容；
- Docker POSIX bind mount 的非 root 用户选择；
- Docker identity 容器的首次测量与后续内容地址重验分离；
- v4 审计复用完整 frozen protocol 校验；
- 相关回归测试、版本号和 benchmark 文档同步。

保留 `--network none`、凭据不注入、MCP/web 关闭和“无真实模型调用”边界。本次不实现 provider egress、Linux memory preflight 或真实 Docker/provider 验收。

## 实现设计

`experiment.mjs` 在 resume 读取已有 v4 protocol。若冻结的是没有 `environment` 的旧 CLI identity，则当前 Codex identity 只保留旧四字段，保持旧协议可恢复；新协议仍保留并重验 environment。`status.mjs` 根据冻结 identity 是否包含 environment 决定是否采集同一字段。

`codex-container.mjs` 保留首次 `containerIdentity` 的完整 Node/CLI/native 测量，增加只检查 manifest 内容哈希、镜像 ID、平台和声明 identity 的轻量重验入口。每次试次和 status/resume 只使用轻量入口，不重复启动 identity 容器。POSIX 非 root 宿主使用当前 UID/GID 运行 runtime 容器，无法取得 UID/GID 时保留 Windows fallback `65534:65534`；root 宿主显式失败，避免静默产生不可写 bind mount。

`audit.mjs` 仅对 schema v4 调用 `validateExperimentProtocol`，保留 v1-v3 历史审计路径。这样旧协议继续只读审计，v4 的 driver identity、计划、任务和模式契约与 resume/status 使用同一校验。

## 兼容与风险

- 协议 schema 和 container identity schema 不升级；旧 v4 CLI identity 继续合法。
- Docker runtime user 不进入实验协议，实际 image/CLI identity 不变。
- provider、凭据和网络边界不放宽；真实 Docker 权限仍需在目标宿主独立验证。
- 版本提升为 `1.12.0`，文档明确当前 Docker runtime 不是带远端 provider 的默认可运行通道。

## 验证

新增/调整 status、legacy resume、container recheck、动态 runtime user 和 v4 audit 负例；先运行 benchmark 与 Runtime 全套测试，再执行 `check --ci --json`，最后审查完整差异和未验证边界。
