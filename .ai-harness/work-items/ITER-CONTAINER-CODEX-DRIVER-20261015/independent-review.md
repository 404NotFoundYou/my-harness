# R1 独立高风险审查

独立审查结论：**FAIL，需要返工**。审查者使用独立子代理上下文，只读检查最终源码快照`42c80716c3d8500bbe3f02c1d8567c7b42acd39a4c8e6a83a426fcc964753bcd`，未修改文件、未连接Docker、未调用模型或下载依赖。

## P1：identity未绑定镜像内实际字节

manifest中的Node/CLI版本及wrapper/native哈希只做格式检查，`containerIdentity()`原样复制声明值；任意本地digest镜像可配合伪造字段冒充固定Codex运行时。现有测试使用虚构哈希，未证明manifest声明对应镜像内真实文件。需要无模型identity probe实际读取镜像内入口、计算哈希和CLI版本，并记录固定wrapper/platform tarball integrity。

## P1：create结果不确定时可能遗留容器

当前只在Docker CLI成功返回后设置`created=true`。若daemon已创建容器但CLI超时、被终止或通信失败，catch不会按已知UUID名称执行强制删除。需要从发出create前就把清理责任绑定到名称，并把“No such container”视为已清理。

## P2：多重清理失败被遮蔽

stop和cleanup均使用`runtimeError ||=`，spawnError又优先于runtimeError。kill失败后remove也失败时，最终证据只显示前一个错误，无法判断容器是否遗留。需要聚合spawn/stop/remove全部脱敏错误，并保持completed=false。

## P2：inspect安全边界校验不完整

只检查`/tmp`存在，未核对`exec,nosuid,nodev,size=268435456,mode=1777`，也未核对PidsLimit、Memory、NanoCpus和RestartPolicy。模拟`Tmpfs:{"/tmp":"rw"}`仍通过。需要逐项严格校验并补充变异反例。

## 审查验证

- 定向测试：70项，61通过、9个平台跳过。
- 全部benchmark测试：155项，146通过、9个平台跳过。
- 历史兼容：1/1，核对514个历史文件SHA。
- 独立构造的identity伪造、create不确定和双清理失败反例均成立。

当前不能登记PASS、推进DONE、提交或推送。返工后必须重跑全部验证并重新进行独立审查。
