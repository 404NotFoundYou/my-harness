# 文档与版本策略

文档是设计、执行、恢复和验收的前置状态，必须简洁、可索引并与实现同任务更新。

## 新项目

首个版本默认 `v1.0`，在正式编码前建立：

```text
README.md
docs/
  README.md
  product/overview.md
  architecture/overview.md
  architecture/database.md            # 使用数据库时
  architecture/frontend.md            # 涉及前端时
  architecture/mobile.md              # 非原生跨平台移动端
  architecture/decisions/
  versions/v1.0/
    README.md
    STATE.md
    PLAN.md
    VERIFICATION.md
```

允许预建空模板，但空文档不能作为门禁通过证据。稳定当前事实只维护一份；版本目录记录本版本目标、差异、计划、验证和交付并链接当前事实。

## 已有项目

- 优先沿用现有目录、命名、版本、Issue、ADR 和发布规范；有等价文档时禁止另建默认结构。
- 未明确要求时不得批量移动、重命名或重建文档结构。
- 明确要求重生成时，先完整读取原文档、代码、配置、Schema/迁移、测试和部署入口，建立“文档结论 -> 代码证据”追踪。
- 当前检出代码、迁移、运行配置和测试是主要证据；旧文档和候选分支只作背景。冲突并列记录，不得编造第三种现状。
- 版本发布后的历史目录不可改写为后续现状；修正必须记录原因、日期和责任人。

每个任务将文档影响写为具体路径或 `N/A: 理由`。行为、Schema、API、配置、架构、部署或运维变化必须同任务更新。
