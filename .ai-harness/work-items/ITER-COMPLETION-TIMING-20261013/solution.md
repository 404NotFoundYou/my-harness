# 会话结束阶段观测

基线main@96652f1，两条远端CI成功。用户授权诊断与模拟回归，不授权新真实模型会话。本轮单AI实现、独立上下文高风险复核；预算、中断和评分保持现有实现。

沿createToolTiming追加lifecycle(version1)：firstProtocolEventMs、terminalEventMs、processExitMs、processCloseMs，缺失为null、合法零值保留。Codex终态锚点为turn.completed；Claude/Gemini为现有reader识别的result，锚点只表示事件收到，不授予成功。驱动分别订阅exit、close；close仍是原有返回与中断清理入口，pending无换行事件以close接收时点解析，允许stdout/终态事件在exit之后被观察，不假设终态必先于exit。工具时间区间保持既有语义。

report在逐题JSON与Markdown展示四锚点、最后已结束工具及尾段间隔。旧记录无锚点时为未知；已有spans允许恢复最后工具到观测结束的间隔。缺失或事件接收顺序反转不输出负数或伪造0，非法数值/生命周期版本明确拒绝；原配对指标、判定器、成功分母和冻结协议不变。新增字段为可选扩展，不改写旧实验。

先用三个客户端模拟正常终态、等待终态超时、终态到达后进程迟退、exit后延迟管道关闭、无换行终态及无exit的spawn失败；断言新数据可区分阶段且completed/timeout仍按原规则。测试只启动合成CLI或mock，不调用模型服务。报告回归保护未知、零值、合法迟到事件与非法度量，并审计原6样本。

本工作项保存historical-timeline.json/md与原6样本全部文件SHA清单，原目录只读。CSV baseline43.214秒、events Harness18.950秒的尾段仅是本地接收时间到观测终止，后者被预算截断；正常样本13.851至17.585秒，不将两次超时当作同一根因或纯模型/网络耗时。

写集为timing、两个驱动、report、对应模拟/报告测试与README；计划只运行无模型测试/语法和历史验证。无数据库、依赖、凭据、路由或生产影响。最终check --ci及独立复核通过才能完成；Linux/Node20/24新代码未实机验证时明说。
