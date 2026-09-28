# P1：扩展 CI 支持矩阵

- 当前：Runtime 最低 Node.js 20，ai-harness 在 Ubuntu 20/22 测试；source-tests 在 Ubuntu 20/22、Windows 20 测试。两条工作流已有 15 分钟 job 超时。
- 目标：不变更最低 Node 版本及任何运行时入口；ai-harness 增 Ubuntu 24，source-tests 增 Ubuntu 24、Windows 22/24。其余 test 命令不改。
- 保护：本地加一条静态工作流回归测试，以支持矩阵和原测试入口为断言，避免日后无意删除跨端覆盖。远端 Node 24/Windows 22、24 实际执行需推送后的 CI，当前不代称验证。
- 数据库：无持久化、Schema、查询变化；部署/发布与额外成本不在本次授权内。
