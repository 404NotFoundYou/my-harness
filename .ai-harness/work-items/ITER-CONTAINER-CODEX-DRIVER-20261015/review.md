# R1 容器化 Codex driver 差异自查

本审查由实施同一 AI 完成，不是独立高风险复核。已审查全部产品差异、导出接口、`run.mjs`/`status.mjs`调用、协议v4身份校验、恢复路径、进程预算和测试反例。

## 范围与结论

- `codex-container.mjs`严格拒绝额外manifest字段、tag-only镜像、非linux/amd64、非Node22.20.0/Codex0.156.0、非绝对容器路径和非法哈希。container identity绑定manifest realpath/字节哈希、image/imageId及CLI/native哈希；每次试次前后通过显式reader重验Docker image。
- container create固定无网络、只读root、非root、`CapDrop=ALL`、`no-new-privileges`、非privileged及tmpfs。仅participant和试次输出两个可写bind；create后inspect实际配置和Windows bind Source，任何差异先force rm再失败。
- timeout、工具上限和Docker CLI结束都复用原协议解析；container stop先kill，close后force rm volumes。清理失败写入run.error并阻止completed。
- host默认、参数顺序、CLI identity和历史v4保持不变。Docker模式显式选择，参数冲突或失败不回退host；dry-run不读取manifest或Docker。
- container CLI关闭memories、apps/plugins/browser/computer/image/remote-plugin、MCP相关features和web search，并清空`mcp_servers`。实际Codex0.156.0离线入口已接受这些参数，未调用模型。
- status可用同一manifest只读确认身份；缺manifest时不会把container协议标为可恢复。

未发现需要返工的代码问题。V1 revision2为70项（61通过、9个Windows下POSIX跳过）；V2为155项（146通过、9平台跳过）；V3验证514个历史文件SHA及旧报告1/1。真实Docker path探测只使用既有Postgres镜像，创建后inspect成功并删除容器；未pull镜像或调用模型。

## 边界

本轮没有镜像构建、凭据传递、真实provider、真实模型、付费实验、MCP执行或发布部署。容器模式当前是显式实验能力，README明确不应在独立审查和实际provider验证前用于付费实验。

R1同一AI自查为PASS，但不能满足`independent-required`。最终工作项必须等待独立审查；不得以本文件或测试通过替代独立结论。
