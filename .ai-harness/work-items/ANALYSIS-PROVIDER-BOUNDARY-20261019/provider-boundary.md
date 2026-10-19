# 真实 provider 接入边界（只读方案）

基线：`main@ab22c80`，2026-10-19。目标假设是现有 Codex CLI 的远端弱模型配对对照；若目标改为纯本地模型，应重新选择方案。本文件不是实施批准，不包含凭据、模型调用或费用授权。

## 已有契约

- `benchmarks/run.mjs` 在 Docker 模式只接受 Codex，`--dry-run` 只生成计划；`experimentPlan()` 的 `project-v2` 配对、重复一次共六个独立试次。代码没有每试次只发一次 provider 请求的约束，不能把六个试次当作六次计费请求。
- `codex-container.mjs` 固定 `--network none`、只读根、非 root、cap-drop、无宿主 socket，只有工作区和试次输出两个可写 bind。创建后 inspect 核对，失败即清理；不会拉镜像或注入凭据。`codex-driver.mjs` 在容器模式关闭内层审批/沙箱，所以这些外层约束是实际边界。
- 固定镜像身份为 Node `v22.20.0`、Codex `0.156.0`、`linux/amd64`。先前本地固定回环响应器证明 CLI/driver/审计能完成零模型试次；它不是远端 provider、模型能力、认证或费用证明。
- 默认试次预算为 180 秒和 80 次可见工具调用；当前协议冻结源码、任务、模型字符串、CLI/容器身份及该预算，但不冻结或计量 provider 请求、价格、网关身份、网络策略或凭据来源。状态/续跑不能用现有身份字段证明这些新增边界未变化。

## 互斥路径与选择

| 路径 | 保持的边界 | 与当前目标的关系 | 结论 |
| --- | --- | --- | --- |
| A：同容器本地 provider | `network none`、无需远端凭据；本地回环 fixture 已证明协议形状 | 真实本地模型的镜像、CPU/内存能力、模型可比性和许可证均未验证；不能替代指定远端模型对照 | 若目标改为离线评测，另立资源/模型工作项；本轮不选 |
| B：受信任网关转发远端 provider | 参试容器不持有 provider 密钥；只允许经专用网关的受限请求 | 能保持现有远端模型对照目标，但需改变 `network none` 契约和协议身份 | **建议后续采用，仅作为高风险设计提案** |
| C：现有 host CLI 直接访问远端 | 无网关开发；使用已登录 CLI 和 `workspace-write` 沙箱 | 执行与凭据边界变为宿主，不具备 Docker 的外层隔离；环境摘要不等于操作系统隔离证明 | 若用户明确选择宿主风险边界，可单独批准最小试跑；不能冒充 B 的验收 |

不能直接将参试容器改为默认 bridge 并传入 API key：Docker bridge 默认允许外部通信；参试 CLI 的内层沙箱已关闭，模型驱动的进程可绕过 CLI 功能开关发起任意网络请求。A/B/C 是各自不同的试次边界，不能合并成“保持 network none 同时访问远端”，也不能用 C 的成功证明 B 的安全性；必须明确选择并重新审批边界。

## B 路径最小设计约束

1. **信任分离**：参试容器只装公开固定任务及当前试次输出，不挂载宿主凭据、Docker socket、用户配置或全局记忆。独立受信任网关持有经授权的项目级 provider 凭据；网关允许的模型、API 路径、请求体形状和目标主机固定，拒绝任意 URL、模型切换及代理滥用。网关本身访问远端；参试容器只可达网关，不可直达公网、宿主服务、元数据地址或其他私网。
2. **网络证明**：为每次试次建立隔离连接，启动前 inspect 实际网络、端点、挂载和权限；以参试容器内实体探针验证网关正对照及公网/DNS/宿主/私网负对照。仅 CLI 的 web/MCP 禁用选项不构成网络隔离。Docker Desktop Windows 与 Linux 分别验证，不把 `--internal` 名称当作完整 egress 证明。
3. **配置与身份**：沿用固定镜像身份；仅在临时 `CODEX_HOME` 中指向网关，不写用户全局配置，不含 provider 密钥。需在固定 Codex `0.156.0` 镜像上验证自定义 provider、认证、零自动重试及失败行为；当前官方 Codex 配置文档可能对应更新版本。网关构建哈希、策略版本、允许模型、网络规则与预算应进入新协议身份/审计，续跑前重新验证，不得静默复用原 v4 容器身份。
4. **费用与不确定调用**：现有 180 秒/80 工具调用不限制 provider 请求或费用。网关按试次限制请求数、输入/输出 token 上限和已选模型的保守费用预算；价格/用量未知时拒绝继续。外部项目预算只作第二道保护，不当作及时的单试次硬上限。超时、断流、账单未知或响应未确认时记录 `interrupted/usage unknown`，不自动重试或把未知计为零；终止后撤销试次权限并验证容器、网络、网关资源清理。
5. **数据与证据**：真实 provider 将收到任务提示，也可能收到参试代码，需先批准这种数据外发。网关只留模型、试次 ID、请求数量、用量/费用及必要的哈希/状态；不记录密钥、Authorization、原始提示、源码或完整响应。检查 `docker inspect`、环境、两个 bind、事件/错误/审计产物和失败日志没有 provider 凭据。

## 实施前门禁

- 由用户确定远端 provider、模型集合、允许外发的数据范围、单试次预算与最高总费用；费用、凭据及网络边界变更须另行明确授权。未选模型和价格前不能给出可信金额。
- 独立高风险审查上述信任图、网关请求约束、计费中断语义和协议迁移。实现属于新的开发型工作项，不能用本 `ANALYSIS` 工作项修改产品代码。
- 先用无凭据的固定响应器做网关正负对照、故障注入、重启/续跑与审计；再在明确授权下用一个任务的一次真实试次验证认证、用量与清理。单试次结果通过后才决定是否运行完整配对计划；失败或跳过均不记为通过。

## 资料与证据边界

当前源码：`benchmarks/run.mjs`、`experiment.mjs`、`runner.mjs`、`codex-driver.mjs`、`codex-container.mjs`、`README.md`；既有 `ANALYSIS-DRIVER-LOOPBACK-20261019`、`ANALYSIS-ZEROMODEL-AUDIT-20261019` 工作项。2026-10-19 读取的官方资料：[OpenAI Codex 配置](https://developers.openai.com/codex/config-advanced/)、[OpenAI API 费用限制](https://developers.openai.com/api/docs/guides/spend-limits)、[Docker none 网络](https://docs.docker.com/engine/network/drivers/none/)、[Docker bridge 网络](https://docs.docker.com/engine/network/drivers/bridge/)。官方当前文档不能代替固定 CLI 版本和本机 Docker Desktop 的实测；网关隔离、真实 provider、凭据保密、准确费用与数据处理均为**未验证**。
