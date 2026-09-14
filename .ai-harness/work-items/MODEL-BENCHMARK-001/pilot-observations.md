# 先导观察（未完成）

所有结果以pilot/*/result.json和events.jsonl为准，本轮源码冻结e9339a00；九项尚未结束，不提前改源码或任务。

- csv / weak-baseline：12/12隐藏通过，111819ms，16工具，正常完成；有一次node --test test的目录解析错误，模型改用显式测试文件恢复。输入166861、缓存135680、输出4249；不能按总输入直接推计费用。
- csv / weak-harness：12/12隐藏通过，180351ms因超时中断；工作项停在READY_FOR_ACCEPTANCE，最终声明/turn.completed/usage均缺失。17工具；不是功能失败，也没有证据证明任务完整完成。
- csv Harness过程：新自测夹具在闭合引号后误含空格，解析器按公开规格拒绝。模型修正夹具后不必要地reopen，立即run又得到WRONG_TASK_STAGE，再读guide/show、task-update IN_PROGRESS后两项检查通过。考虑在guide/错误输出补明确恢复路径：实施中修正与重新验证无需重开；reopen后提示READY→IN_PROGRESS。等开发集另一题结果后再选择必要辅助，不能根据留出题调参。

框架边界：当前保存candidate.mjs、公开输入哈希、范围变化、模型工具日志及Harness控制面，但未单独保存新自测文件文本；后续产物收集应补保存允许的新自测代码，早期样本只能使用实际保留的日志和文件哈希，不编造缺失文件内容。
