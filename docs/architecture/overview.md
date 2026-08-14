# 架构概览

## 架构来源

`AI_RECOMMENDED`。用户已授权将空项目整改为可复制、可稳定执行的 Harness runtime；选择遵循最小完整实现，避免在确定性单项目工作流稳定前加入模型循环或多代理控制面。

## 运行边界

Runtime 完全位于目标仓库内：

```text
AGENTS.md                    # 项目规则 + Harness 托管块
CLAUDE.md / GEMINI.md        # 已有客户端规则/导入 + 可选托管块
.ai-harness/
  bin/                       # CLI 入口与安全安装器
  src/                       # 状态、门禁、任务、证据、权限和文件系统模块
  schemas/                   # 公开结构契约
  policies/                  # 按工作类型/业务域加载的详细规则
  templates/instructions/    # 跨项目标准规则载荷，不含源项目私有规则
  templates/new-project/     # 新项目 v1.0 文档初始结构
  tests/                     # Node 内置测试
  work-items/                # 目标项目的持久工作状态
.github/workflows/           # 可选 GitHub CI 入口
```

## 技术选择

- **运行时**：Node.js 20+、ES modules、仅使用标准库。
- **持久化**：仓库内 JSON/JSONL 文件，原子临时文件替换；状态可以随 Git 审查和恢复。
- **结构契约**：JSON Schema 作为公开格式，自定义确定性校验器作为零依赖执行实现。
- **CLI**：参数数组解析，不通过 shell 拼接命令；机器输出支持 JSON，人工输出保持简洁。
- **CI**：统一执行 `node .ai-harness/bin/harness.mjs check --ci`，具体 CI 平台只负责调用。

## 模块职责

- `filesystem`：解析项目根、限制路径、原子写入、JSON/JSONL 操作。
- `model`：工作类型、状态、门禁和任务结构的唯一代码定义。
- `validator`：结构、依赖图、状态历史、数据库顺序和完成条件校验。
- `workflow`：创建工作项、更新阶段数据、转换状态和任务状态。
- `policy`：deny-first 命令分类和可执行边界。
- `evidence`：执行允许命令、脱敏和追加证据；`checker` 复核证据 ID、类型、任务和最新状态的一致性。
- `managed-block`：渲染、解析和校验规则文件中的版本化托管块，统一 LF/CRLF 哈希语义。
- `installer`：从标准载荷合并根规则，预检完整安装计划，备份已有文件并在写入失败时回滚。
- `cli`：解析命令并调用上述模块，不承载业务规则。

## 无损接入设计

根规则文件与普通 Runtime 文件采用不同策略：

1. 标准载荷只从 `.ai-harness/templates/instructions/` 读取，不读取安装源根目录的项目规则，因此从已接入项目再次分发不会泄漏上一项目规则。
2. 已有规则保留在托管块外；首次安装追加块，重复安装按内容幂等跳过，版本升级只替换结构有效且哈希匹配的块。
3. 结构有效但哈希不匹配说明托管内容被修改，默认失败；显式 `--force` 只修复块。标记损坏或重复时无法可靠判定边界，始终失败。
4. 已有兼容导入的 Claude/Gemini 适配器不改写。其他适配器追加只包含导入指令的托管块。
5. 安装器先完成规则合并、大小限制、路径类型和全部普通文件冲突检查，再开始写入；修改已有文件前生成同事务备份。

托管块 SHA-256 用于检测意外修改和升级漂移，不是抵抗恶意进程的密码学信任根。字节无损只保证原规则内容未被改写；规则之间的语义冲突仍由核心契约要求显式暴露。

## 状态设计

开发型工作在数据库设计前增加 `SOLUTION_DESIGN`，用于梳理业务流程、领域边界、接口和查询/写入草案；`PLANNED` 专指数据库决策后的任务执行计划。

```text
NEW_PROJECT / ITERATION:
INTAKE -> BASELINING -> SOLUTION_DESIGN -> DATABASE_DESIGN -> PLANNED
-> IMPLEMENTING -> VERIFYING -> CODE_REVIEW -> READY_FOR_ACCEPTANCE -> DONE

BUGFIX:
INTAKE -> BASELINING -> SOLUTION_DESIGN
-> DATABASE_DESIGN -> PLANNED  # 数据库影响 required
-> PLANNED                     # 数据库影响 none
-> IMPLEMENTING -> VERIFYING -> CODE_REVIEW -> READY_FOR_ACCEPTANCE -> DONE

ANALYSIS:
INTAKE -> BASELINING -> ANALYZING -> ANSWERED
```

任意活动状态可进入 `BLOCKED`，解除时只能返回记录的原状态。状态转换由 runtime 校验并追加历史，禁止仅修改当前状态字段绕过门禁。

## 安全边界

- Runtime 命令执行器只执行被策略判定为 `allow` 的无 shell 命令；`ask` 和 `deny` 均不执行。
- 路径在写入前解析到项目根并拒绝越界、符号链接/联接逃逸和受保护文件覆盖。
- 安装器无损合并根规则；普通文件冲突默认拒绝覆盖，强制替换必须使用显式选项并生成备份/变更报告。
- CI 检查最终仓库状态、工作项与 Git 差异；客户端权限系统仍是阻止 AI 绕过 runtime 直接调用工具的第一道边界。
- 开发型基线必须有提交 SHA；没有初始提交时禁止进入可依赖 Git 差异的实施流程。

## 多 AI

v1.0 只验证计划中的所有权、依赖和不重叠写入范围，不实现模型调度。外部 AI 客户端可以据此并行，但必须使用独立工作树或明确隔离；runtime 在合并/CI 时重新验证共享状态。
