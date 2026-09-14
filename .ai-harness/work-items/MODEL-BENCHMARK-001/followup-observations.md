# 复验观察（运行中）

本轮源码固定625f0fa8，基于已冻结的intervention-decision.md运行；不再根据本轮或留出结果修改辅助。

- CSV Luna原流程112211ms，完整通过；CSV Luna Harness167314ms，完整通过，实际调用guide --context、run --all、finish。但首次guide遗漏--id，说明工具入口仍有误用成本。
- CSV Sol参考152067ms完整通过；参考组也比先导该题改善，不能把全部时延变化归因于Harness。
- allocation Luna Harness：12/12功能通过，但180360ms超时。其plan.json的writeScopes为单个字面串`src/allocate.mjs,test/extra.test.mjs`，模型未使用重复--writes；finish因此按真实范围拒绝。第一次--verify还使用分号串联两条命令，被正确拒绝后改为仅公共测试的JSON声明。不是算法实现未通过，也不能掩盖为正常完成。

剩余产品问题：长CLI参数的列表、路径、JSON及中英文标点仍会让较弱模型声明错误计划；工具可正确阻止越界，却尚未充分降低声明成本。后续优先考虑明确的结构化任务输入及创建时诊断，而非继续增加通用约束。此为后续建议，本次不追加第三轮调参或把留出结果反馈给参与模型。
