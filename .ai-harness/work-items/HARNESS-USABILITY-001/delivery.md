# 1.2.0 交付记录

本次落实任务输入、收尾恢复、按需上下文及现有客户端验证入口的改进；没有改写上一轮模型效果结论，也没有用小型功能实跑声称模型能力提升。

## 已实现

- `begin --spec <项目内JSON>`：路径及检查参数用数组表达，兼容原CLI；拒绝未知字段和混用定义。旧CLI疑似逗号拼接多个路径时在创建前提示纠正，显式JSON仍可表达合法逗号路径。支持UTF-8 BOM和中文冒号N/A标记。
- 普通已验证迭代的 `guide.next` 直接提供finish。finish能从合法中间状态继续，只要求未完成的真实结论；自动选择本项当前匹配计划的成功命令，不重跑检查。重复DONE调用不写状态或证据，失败审查、旧源码及独立复核门禁仍保留。
- 新工作项使用 `policyRoutingVersion=2`，依据已记录数据库影响加载细则；旧项继续按原路由验证。`policies --id`显示实际策略，未建项可明确传入已判断的影响。
- `guide --context-since`按回传指纹省略相同且完整的内容，变化或截断内容仍返回；保持只读并明确省略边界。
- 增加Claude/Gemini驱动及工具时间区间记录；明确错误和损坏JSONL不能被success掩盖，缺失用量保持未知。不同客户端的权限条件与推理设置分别披露。

## 验证

- `node .ai-harness/tests/run.mjs`：131/131通过，0跳过，最新证据2917f465-6950-40ad-a503-b7eeeaa588c3。
- `node --test benchmarks/tests/runner.test.mjs`：8/8通过，0跳过，最新证据3c88ff9f-90e9-4b86-8bcd-4d3ac918e6b8。Claude/Gemini事件流用合成数据测试，不是实际模型运行。
- 独立复核：首轮480秒超时，无有效结论；第二轮确认客户端错误事件判定缺陷；修复后review-3.json通过。所有失败和复核原文保留。
- Codex真实小型任务：使用已有登录与gpt-5.6-luna，完成JSON建项、文件修改、验证、finish和CI，3项独立功能判定通过。约114.8秒，其中工具事件区间约11.2秒，其余约103.6秒包含模型/网络/客户端等待，不能解释为纯推理时间。
- Codex实跑后只修改Claude/Gemini事件解析和相应框架测试，Runtime和Codex执行路径未变；未重复付费实跑。对应差异清单见client-verification.json。

## 未验证与边界

本机Claude CLI未登录、Gemini CLI未安装；用户明确同意按现状标记未验证。对应驱动已实现，尚未完成本机真实任务与权限环境验证。未重新运行大规模模型效果对照，也未验证更大真实仓库的收益，未提交或推送。

使用方法见仓库docs/guides/usage.md、docs/guides/model-guidance.md及benchmarks/README.md。最终工作项以CLI的DONE状态和check --ci结果为准；本文件不替代门禁。
