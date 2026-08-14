# ADR-0001：采用零依赖 Node.js 仓库内 Runtime

- 状态：已接受
- 日期：2026-08-14

## 背景

Harness 需要复制到不同技术栈的新项目和已有项目，不能依赖目标项目的包管理器配置，也不能覆盖其根 `package.json`。

## 决策

使用 Node.js 20+ 标准库实现 `.ai-harness` 下的 ESM CLI，不创建或修改目标项目根依赖清单。公开数据格式使用 JSON Schema，运行时使用自带校验器保证零第三方依赖。

## 结果

- 可在 Windows、macOS 和 Linux 上使用同一实现。
- 安装后无需联网获取依赖。
- 需要目标环境提供 Node.js 20+。
- JSON Schema 的运行校验只实现 Harness 使用的确定规则，不建设通用 Schema 引擎。
