# 升级CI动作运行时并保持测试矩阵

仅更新两份workflow里的checkout/setup-node主版本和setup-node缓存设置，补矩阵合同测试后以独立PR验证

数据库无影响依据：只改GitHub Actions YAML和合同测试，无数据库、持久化Schema或查询影响
