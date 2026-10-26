# 自备题库目录

发布包不附带题库。缺少 `questions.json` 时网站以空题库启动，这是正常状态。

先停止服务，再在项目根目录执行：

```sh
node study/import-bank.mjs "你的题库.json" --check
node study/import-bank.mjs "你的题库.json"
```

重新启动后生效。字段结构见 [导入说明](../README.md#题库导入)。默认拒绝覆盖任何已有题库，替换需显式 `--replace`；旧题库会备份到私人数据目录。

本目录的 JSON、CSV、归档与来源内容不进入公开源码包。不要通过 Git 强制加入自己的题库。
