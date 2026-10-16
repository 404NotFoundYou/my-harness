# R2 独立审查返工自查

本文件由实施AI完成，不替代独立复审。针对R1的2个P1和2个P2已逐项返工：

1. manifest新增固定wrapper/platform tarball integrity。首次加载运行无网络、无挂载、只读、非root、无capability的identity容器，实际测量Node/CLI版本及wrapper/native SHA；实测与manifest不符即失败并清理。协议冻结后以manifest SHA与内容地址image ID重验，保持status无容器副作用。
2. runtime和identity在发出create前即分配UUID名称；create任意失败均执行`rm --force --volumes <name>`，`No such container`视为已清理。新增create结果不确定反例。
3. spawn、stop和remove错误使用数组聚合并脱敏，不再相互遮蔽。新增stop与cleanup同时失败反例，最终错误同时包含两项且completed=false。
4. inspect严格核对tmpfs完整flags、PidsLimit=128、Memory=1610612736、NanoCpus=2000000000、RestartPolicy=no以及既有安全字段。新增5个逐项弱化反例；真实Docker Desktop探测返回值与预期一致并清理容器。

额外修复`loadContainerRuntime`初次manifest读取与identity结果之间的哈希一致性，避免双读取窗口。

revision3验证：V1 `447d11f3-a007-4cea-9d30-231f8d4fef30`，79项70通过/9平台跳过；V2 `f5b00349-32b5-4d49-8e81-3405a063abf6`，164项155通过/9平台跳过；V3 `893a1b6c-f549-4928-88bb-c685ef71b474`，历史514文件及旧报告1/1通过。

同一AI返工自查未发现新增问题；需要独立审查者复核原四项发现及新identity probe生命周期。
