# agent-os

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

# 接入 CLI 引擎

## 接入 Claude Code

```shell
claude -p "读取 package.json，告诉我项目名称" \
  --output-format stream-json \
  --verbose
```
