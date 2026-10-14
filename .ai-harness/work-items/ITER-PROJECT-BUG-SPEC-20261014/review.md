# R1 工程BUG输入与收尾差异自查

ITER-PROJECT-BUG-SPEC-20261014 / T1 / R1，单AI中风险，同一AI自查，未作为独立复核；源码502e2cb4a9ca4c60189ee01d52c78f5979cdbdf57dd651ecc71e97778fd1dccc。

审查input和CLI的仅填空规则及直接调用方、模板输入schema与实际work-item创建约束、runner/experiment suite透传和新提示、spec-input/spec-guidance回归、usage/benchmark文档。新增参数只赋值BUG观察字段，固定ID/授权/范围/检查仍不能由CLI覆盖；没有默认观察值或通过结论，也没有改变权限分类或阶段/计划证据谓词。

模板只在显式project-v2 Harness启用，core JSON及旧project/baseline文本保留；输入字节冻结和文件身份检查照常执行。新测试确保模型工作没真正完成时功能通过仍不能完整交付；三个题的真实CLI红/绿及四阶段可闭环，六组集成仍标simulated。链接类型保护由受控元数据注入覆盖，实际OS链接替换未额外验证。

全部九项当前源码计划检查已实跑通过：Runtime209、基准117+9平台跳过、目标6+9、历史351、四语法；diff --check通过。原红证据及失败样本保留，新增真实模型调用0。API细则用于兼容性CLI输入审查，修改不扩授权、权限或外部业务服务接口。

R1 PASS，本地无返工项。真实模型效果、Linux/Node20/24新版本及远端CI未验证；正式工作项终态仍由CLI和check --ci确认。
