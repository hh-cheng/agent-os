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

区分 session id:
* `session.id` 由 Agent OS 生成，负责识别飞书话题和管理执行状态
* `session_id` 由 Claude Code 返回，再次启动 `claude` 时传入 `--resume <session_id>` 就能找回本机保存的上下文 ( `--continue` 只会寻找当前工作目录里最近一次会话 )
