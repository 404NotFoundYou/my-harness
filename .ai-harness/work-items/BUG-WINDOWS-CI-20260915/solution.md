# 修复Windows检出导致证据哈希漂移

在随Runtime安装的.ai-harness/.gitattributes中为work-items禁用文本转换，补安装后Git跨换行配置往返测试，文档明确证据按字节保留；不放宽哈希校验

数据库无影响依据：无外部数据库、Schema或存储格式变更；仅阻止Git检出时改写既有证据字节
