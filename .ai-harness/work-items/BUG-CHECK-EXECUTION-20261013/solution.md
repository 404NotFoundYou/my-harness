# 返工证据与基准进程回收修复

以 ANALYSIS-PROJECT-20261013 为输入，保留已有安装修复工作树。证据检查器按当前 revision 找工作项最新结果，pending 审查不沿用失效独立标记；当前有效审查仍须与证据一致。先在 reliability 回归中保留独立失败审查并 reopen/replan，再检查新状态；同时保护同修订验证失败导致的审查失效。

两种基准驱动维持公开参数、预算、协议与评分不变。非 Windows CLI 使用独立进程组，中断向该组发送 SIGKILL；CLI 先退出而工具仍占输出管道时也要终止组。已消失的组可接受 ESRCH，其余失败不能吞掉。Windows 继续使用 taskkill /T /F。用三个客户端的受控进程接口覆盖 timeout、toolLimit、父进程提前退出和正常关闭；另保留 POSIX 真进程回归。本机没有可用 Linux 开发分发版，Docker 服务未运行，POSIX 实机验证范围须如实报告。

实现文件限 checker、两个驱动，测试限 reliability 与新的 driver-process 测试；不新增依赖、公共接口、数据库、部署或外部模型调用。现有安装两项由 BUG-INSTALL-WRITE-BOUNDARY-20261012 的 T1 继续处理，统一在最终源码快照上验证与独立复核。

验收：合法返工 check 无误报；有效独立审查篡改仍拒绝；预算中断覆盖 CLI 后代且结果失败，完成路径不误杀。运行 focused 回归和 benchmark 全套；Runtime 全套由安装项计划覆盖。高风险审查以当前完整差异和真实命令为依据。
