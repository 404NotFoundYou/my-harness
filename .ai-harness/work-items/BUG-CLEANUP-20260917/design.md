# 基准临时目录清理的有界重试

基线main@e3ed655/Runtime1.9.1，原真实实验目录保留。GitHub Actions运行35188462634的Ubuntu job105095524593，在runner.test.mjs的“all groups share contracts and budgets”用例清理`.git/objects/pack`时，Node递归rm抛`ENOTEMPTY`，导致Benchmark framework tests退出1。该步骤未显示新的spec断言失败；Windows矩阵因默认fail-fast取消，没有跨端结论。

`cleanupSandbox`目前先对输入root做realpath、核对本进程创建的ownedDirectories及其父目录等于tmpdir，再对固定resolved路径执行一次rm。仅在这一受控路径的rm返回`ENOTEMPTY`时重试最多两次，间隔50/100毫秒；成功后才从ownedDirectories移除，最后一次失败和其他错误均原样抛出。重试不改变目标路径，不对模型调用、运行命令、评测判定或其他目录增加重试。不弱化原路径/归属校验，失败不删除归属记录，现场按原错误保留。

在自建临时参与者上模拟首次ENOTEMPTY：旧代码失败，新代码清理成功。另模拟持续ENOTEMPTY证明最多三次后失败且恢复mock后仍可清理原临时目录；使用非归属目录时确保拒绝且fs.rm未被调用。被测回归不需要真实模型。完整既有评测与Runtime回归、独立审查、check --ci和远端Ubuntu/Windows CI均须通过；历史1.8/1.9真实v4只读审计仍保持。观察到真实模型交付结果与此次清理异常是不同事实，不能将CI修复说成模型增益。

WSL调试所建`/tmp/ai-harness-node-v20.20.2`在Docker Desktop发行版磁盘空间不足后约占61.5MB；已删除本机D盘下载归档，但该发行版进入只读回退，不能从当前会话安全删除Linux临时目录。此系统环境问题与仓库BUGFIX分开说明，不在本项执行离线e2fsck、系统盘修复或其他破坏性恢复。
