# Windows CI 换行转换故障

基线：`a2108c90e4f95c1ec2b8db980bb73f22e514e7ac`。远端 [Windows 任务](https://github.com/404NotFoundYou/my-harness/actions/runs/34933624306/job/104266793779) 的评测框架步骤失败，后续 Runtime 步骤被跳过；Ubuntu 与常规工作流通过。匿名下载日志返回403，因此以下根因来自本地等价环境复现。

使用独立全新克隆并设置 `core.autocrlf=true`，历史样本审计在 candidateDigest 比较处失败。Node.js 22.20.0 与官方 Node.js 20.20.2 都复现；Node20二进制从nodejs.org下载，并核对官方SHASUMS256通过。

例如 `pilot/allocation-strong-reference/candidate.mjs`：

- 记录哈希：`60d9d7242829bbca87e702ca6d0488d81c7b702d7f5ded0f0c62620de580547b`
- Windows新检出哈希：`3bf7772a45353ca14f68c3f9ec9ba95a6a7b329999983d425bbaf31c66fd5cf8`
- 将检出内容的CRLF恢复为LF后，哈希与记录完全一致。

同一克隆的 `check --ci` 也报归档产物哈希不一致。这证明 Git 的自动换行转换改变了按字节校验的证据，而不是模型输出、校验算法或Node版本有差异。

修复在 `.ai-harness/.gitattributes` 为默认工作项目录设置 `work-items/** -text`。安装器会把此文件作为Runtime载荷复制到目标项目；无需改安装代码、历史记录或已有哈希。自定义工作项目录需配置对应Git属性，使用指南已说明。

新增回归先失败，命令证据 `4309e3fa-a4fa-4f47-8367-310105409516` 记录检出后LF文件多出CR字节。修复后的Node20框架全量15/15、0跳过，证据 `5228972b-6634-482f-be28-ebe2d4df17ce`；覆盖安装、Git提交、自动CRLF与禁用转换两种新克隆，验证LF、CRLF、二进制和候选源码的原始字节。

本地临时运行目录位于D盘。开始时C盘空间不足导致第一次Node下载不完整，该文件已删除；后续二进制校验通过，未使用损坏下载。建项命令曾被自动审批拦截，用户明确确认后才创建BUGFIX并修改产品文件。
