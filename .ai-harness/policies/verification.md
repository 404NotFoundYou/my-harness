# AI 代码生成验证流水线策略

- 本策略在工作项声明 `codegen` flag 时生效；此时 `VERIFYING → CODE_REVIEW` 门禁不再接受单点验证，必须逐段通过有序验证流水线。
- 流水线子阶段固定有序：`static`（静态安全与语法拦截）→ `sandbox`（隔离沙箱与编译执行）→ `contract`（功能与接口契约测试）→ `eval`（AI 语义与回归评估 / LLM Judge）→ `browser`（浏览器实体探针）。
- 每个子阶段必须通过 `record --kind verification --stage <stage> --status pass --evidence <证据>` 逐段留证；禁止用不带 `--stage` 的裸 verification 记录绕过流水线。
- 顺序强制：把某子阶段记为 `pass` 前，其之前的所有必需子阶段必须已 `pass`；乱序记录必须被拒绝。
- `browser` 子阶段在工作项同时带 `frontend` flag 时必须通过（app 可打成 H5，UI 必须在真实浏览器实体探针下跑通才算完成）；无 `frontend` flag 时 `browser` 可选，其结果不影响聚合状态。
- `static` 应至少覆盖语法检查与安全静态扫描；`sandbox` 必须在隔离环境完成编译与执行并记录退出码；`contract` 必须断言功能与接口契约；`eval` 由 LLM Judge 给出语义与回归判定并附理由与引用。
- 执行边界：Runtime 只负责编排、强制顺序与完整性、校验回传证据；SAST、隔离沙箱、浏览器探针与 LLM Judge 的实际执行由外部工具 / CI / agent 完成后回传结构化证据。**Runtime 本身不构成隔离沙箱**（见 AGENTS.md §9），沙箱隔离必须由客户端 / CI 提供并在证据中说明。
- LLM Judge 只用于语义与回归的判断裁量，禁止用它替代确定性的顺序、状态与门禁判定；判定结论必须落为可追溯证据。
- 任一必需子阶段 `fail` 时聚合验证判定为失败，禁止进入 `CODE_REVIEW`；未跑或跳过的子阶段必须显式暴露，不得宣称流水线通过。
