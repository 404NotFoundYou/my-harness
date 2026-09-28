# P1–P3 隔离工作树交付范围核对

日期：2026-09-28。此文仅做交付前本地核对；未暂存、提交、推送、部署、发布或启动新模型试次。

## 检出与当前结果

- 候选工作树：`C:\Users\jhon\.codex\worktrees\optimization-p1-p3\aiproject`，`codex/optimization-p1-p3`，基于 `211fc5fcd1d4da7e4277e2927ee93279a0e5a128`。当前产品源码摘要 `1e5009f558f2d156d4c221cb86b6e5e961ff2de7ba6b5a976feef57393c4d308` 与P3 rev2及历史分析BUG rev3的DONE交付快照一致。
- 原 `D:\Projects\aiproject` 的本地 `main` 同为 `211fc5f`，已跟踪/暂存差异为0；本次五个控制工作项ID及三条新增产品路径在main均不存在，无路径碰撞。main仍有约822个未跟踪历史控制文件，包括单独授权完成的P0真实模型实验；不得在main笼统 `git add .` 或混入这些数据。
- P1 `ITER-CI-NODE-20260928` DONE；P2 `ANALYSIS-CONTROL-PERF-20260928` ANSWERED；P3 `ITER-PROJECT-V2-20260928` DONE rev2、独立审查通过；前置 `BUG-ANALYSIS-HISTORY-20260928` DONE rev3、独立审查通过。本交付范围分析项完成后才可进入可检查终态。

## 明确候选：13条产品/测试/文档路径

已跟踪修改（10）：

1. `.ai-harness/src/verification.mjs`
2. `.ai-harness/src/workflow.mjs`
3. `.ai-harness/tests/analysis-command.test.mjs`
4. `.github/workflows/ai-harness.yml`
5. `.github/workflows/source-tests.yml`
6. `benchmarks/README.md`
7. `benchmarks/audit-trial.mjs`
8. `benchmarks/audit.mjs`
9. `benchmarks/task-contract.mjs`
10. `docs/guides/usage.md`

新增（3）：`.ai-harness/tests/ci-matrix.test.mjs`、`benchmarks/project-tasks-v2.mjs`、`benchmarks/tests/project-v2.test.mjs`。

控制面候选为本项及P1/P2/P3/BUG五个工作项目录下完整的 `state/plan/events/evidence/snapshots/outputs/revisions` 等Git可见文件，不能只选 `state.json`；测试全文产物已有证据哈希引用。审查时13条产品文件加62个控制文件合计75；本报告和终态记录会增加控制文件，若获得Git授权必须重新列出实际暂存清单。排除main中的P0真实模型产物和所有其他历史未跟踪目录。

## 本地验证及尚缺步骤

- 当前源码P3计划benchmark测试75/75，BUG计划测试13/13，额外Runtime全量185/185；均无失败/跳过。机械返工经独立只读复核，无额外语义或计划外改动。`doctor --json`、非CI `check --json`、`git diff --check`均通过；本分析项转ANSWERED后才运行最终 `check --ci --json`。
- 原 `core`/`project` 不变，`project-v2` 为显式新题集；P1仅增加Node版本CI矩阵，未提升最低Node20兼容承诺。P2因无实测瓶颈证据未改性能代码。历史分析BUG在独立高风险审查后的修订上封存证据。
- 尚未暂存，故没有 `git diff --cached --check`；尚无新提交，故不能做基于该提交的干净detached-worktree验证、远端ref相等性或GitHub Actions矩阵结果。新加的Node24/Windows22、24平台未在本机执行；不能称远端CI通过。P0真实core实验运行在原main冻结1.11.0代码，并非此分支候选的真实模型收益验证。
- manifest与根README仍称Runtime `1.11.0`；当前是候选功能分支而不是已批准发布。若用户意图新版本发布，需要单独决定版本、托管块和文档迁移范围，不能悄悄把本分支称为新发行版。
- 候选控制及产品文件经有前置边界的常见令牌字面模式扫描0命中；宽松模式唯一命中是日志事件名 `task-definition-updated` 的`sk-`子串假阳性。模式扫描不能证明不存在所有敏感内容；外部推送前仍须按精确暂存范围复核。

## 下一动作与授权

保留当前隔离分支供用户审阅。若仅要求本地准备，则到本项ANSWERED/`check --ci`通过即止。**只有用户另行明确授权Git交付**，才在该隔离工作树逐路径暂存上述13条产品文件及五个当前工作项完整目录，核对 `git diff --cached --check`、按审批范围提交，在该提交干净检出上验 `doctor` 和 `check --ci` 后按授权推送，并以实际远端CI结果报告。绝不从main笼统暂存822个未跟踪控制文件；不再运行模型或扩大实验预算。
