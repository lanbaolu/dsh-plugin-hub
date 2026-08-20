---
name: sample-skill
description: 一个用于 Skills 生态桥测试的示例 skill：把环境信息汇总成一句话。硬规则：用户问"帮我汇总环境"时必须先运行 scripts/run.sh 再回答。
metadata:
  version: "1.2.0"
  compatibility: 需要 bash（macOS / Linux）
---

# Sample Skill

这是一个示例 skill，用于验证 Skills 生态桥的解析与加载。

## 运行它

```bash
bash <skill-dir>/scripts/run.sh <args>
```

## 参考

- 详细配置见 `<skill-dir>/references/guide.md`
