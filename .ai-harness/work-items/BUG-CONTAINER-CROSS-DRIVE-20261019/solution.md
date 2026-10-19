# Windows 跨盘容器挂载误判

Docker driver 在检查工作区和输出 bind 不重叠前会解析两个宿主路径。Windows 跨盘时 `path.relative(C:, D:)` 返回绝对路径；现有 `nested()` 将所有非 `..` 开头的结果当成子路径，于是不同盘在创建容器前被拒绝。首次失败与同盘重试通过的证据保存在 `ANALYSIS-ZEROMODEL-AUDIT-20261019`。

仅修改包含判定：`path.relative()` 的绝对结果表示不同根，不构成包含；同目录及真实子目录仍拒绝。`realpath`、挂载检查、网络、用户、capabilities 和清理均不变。Windows 回归在 `prepare()` 中临时模拟 C:/D: 的相对路径结果，不新增导出；现有 Docker mock 测试继续覆盖安全检查，并补充同目录及双向嵌套目录在 Docker create 前被拒绝的断言。真实 C:/D: Docker 探针单独验证挂载创建、inspect 和清理。

先记录修复前失败的聚焦测试，再运行修复后测试、完整 benchmark 与 Runtime 套件、语法检查和 CI。该修复恢复两个独立挂载的既有契约；无数据库、公开命令、manifest 格式或现行文档变更。完成前须独立审查挂载边界。
