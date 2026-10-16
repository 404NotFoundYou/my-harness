# 容器化 Codex driver 独立审查请求

## 审查目标

对最终源码快照 `42c80716c3d8500bbe3f02c1d8567c7b42acd39a4c8e6a83a426fcc964753bcd` 做独立高风险审查。实施者自查为PASS，但不得复用为独立结论。

## 产品文件

- `benchmarks/codex-container.mjs`
- `benchmarks/codex-driver.mjs`
- `benchmarks/client-drivers.mjs`
- `benchmarks/experiment.mjs`
- `benchmarks/run.mjs`
- `benchmarks/status.mjs`
- `benchmarks/tests/container-driver.test.mjs`
- `benchmarks/README.md`

## 必查问题

1. manifest与container identity是否严格、可重验，是否存在身份或路径TOCTOU可在模型调用前绕过。
2. Docker create后inspect是否覆盖image、network、privileged、user、readonly root、cap drop、no-new-privileges、tmpfs、ports、volume和两个bind的source/destination/RW。
3. create/inspect/start/timeout/tool-limit/spawn-error/leader-exit/cleanup-error各路径是否可能遗留容器或把失败计为completed。
4. host默认参数、CLI identity、协议v4、resume、status和历史审计是否保持兼容。
5. Docker模式是否可能静默fallback到host、执行pull/build/install、读取宿主`.codex`、传递凭据或暴露MCP/Apps/web。
6. error/evidence是否可能保存宿主敏感路径、环境变量或Docker原始stderr。
7. 测试断言是否验证安全意图，而非只复述实现。

## 当前证据

- V1 `5e813b7e-bda9-4932-8ffc-c230a839f876`：70项，61通过、9个Windows下POSIX跳过。
- V2 `667f4c6a-f132-431d-8a2e-8ff239f7c38b`：全部13个测试文件155项，146通过、9平台跳过。
- V3 `9a4826a6-fef5-4a4e-b85d-9578d92ae97d`：历史514文件SHA及旧报告1/1通过。
- `docker-path-probe.json`：本机既有镜像create/inspect确认Windows bind Source与realpath比较一致，容器已删除；未pull、未启动模型。
- `review.md`：实施者同一AI自查，仅供线索。

## 明确未验证

- 没有预构建Codex镜像的端到端真实container trial。
- 没有真实provider、凭据或模型调用。
- 没有启用MCP/Apps。
- 没有修复nested bwrap；container模式显式bypass内层sandbox并依赖外层Docker。
- 当前工作项停在`CODE_REVIEW`，独立review PASS前不得进入验收、DONE、提交或付费实验。

独立审查者应按严重度列出发现；若无发现，明确说明剩余风险和未运行项，然后以Runtime `record --kind review --independent`登记真实结论。
