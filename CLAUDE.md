# agent-os

把飞书变成 AI 编程 CLI（Claude Code / Codex）的指挥台。飞书里一个新话题（thread）= 一个任务，bot 自动创建会话、调用 `claude` CLI 执行，并通过飞书互动卡片实时反馈进度。

## 架构

```
飞书消息 → WebSocket 长连接（Lark SDK）
    ↓
src/im/message-parser.ts  解析 mentions、提取图片/文件
src/core/command-parser.ts 识别 /help、/status、/close
src/core/session-manager.ts 会话生命周期：creating → active → idle → closed
src/core/session-store.ts   会话持久化（JSON 文件，Zod 校验，原子写入）
    ↓
src/cli/claude-runner.ts  启动 `claude -p <prompt> --output-format stream-json --verbose`
src/cli/spawn-cli.ts      Bun.spawn 封装，Windows 兼容
    ↓
飞书卡片更新（buildTaskCard → replyCard → updateCard）
```

## 运行

```bash
bun dev        # bun src/index.ts（直接运行，无 watch 模式；Bun 原生执行 TS）
bun build      # bun build src/index.ts --outdir dist --target bun
bun probe:cli  # bun src/probe-cli.ts（调试 CLI 的 stream-json 输出）
bun lint       # biome check .
bun lint:fix   # biome check --write .
```

## 技术栈

- **运行时**：Bun ≥ 1.2.4，packageManager bun@1.3.14
- **语言**：TypeScript 7（peerDependency），ESM only（`"type": "module"`）
- **飞书 SDK**：`@larksuiteoapi/node-sdk`（WebSocket 长连接 + IM API）
- **校验**：Zod 4（会话数据结构校验）
- **环境变量**：dotenv，.env 放凭证
- **格式化/Lint**：Biome 2.5（单引号、无分号、2 空格缩进、80 字符行宽）
- **Git hooks**：Husky + commitlint（conventional commits）+ lint-staged（Biome 检查）

## 目录结构

```
src/
  index.ts             入口：启动飞书 bot，编排会话与 CLI 执行
  im/
    lark.ts            飞书 SDK 封装（WebSocket 事件分发、消息回复、卡片更新、资源下载）
    card.ts            飞书互动卡片构建（进度条 + 状态标签）+ ThrottledCardUpdater
    message-parser.ts  解析 @提及、还原占位符、提取图片/文件 key
  core/
    session-manager.ts 会话状态机（每个飞书话题 → 一个会话，状态转换校验）
    session-store.ts   JsonSessionStore（原子写入：先写 .tmp 再 rename）
    command-parser.ts  斜杠命令识别（/help /status /close）
  cli/
    claude-runner.ts   解析 Claude Code 的 stream-json 输出，提取最终结果
    spawn-cli.ts       Bun.spawn 统一封装（跨平台 kill）
  probe-cli.ts         CLI 输出调试工具（读取 stdin 的 stream-json，打印事件摘要）
data/                  运行时数据（sessions.json、downloads），已 gitignore
dist/                  构建产物，已 gitignore
```

## 约定

- ESM only，Node 22+（但实际运行时是 Bun）
- 凭证只放 .env（`BOT_A_APP_ID`、`BOT_A_APP_SECRET`），绝不硬编码、绝不提交
- .env.example 作为模板，不包含真实凭证
- 环境变量 `CLAUDE_WORKDIR` 可覆盖 Claude Code 的工作目录
- Biome 作为唯一 formatter + linter，不做 ESLint/Prettier 混用
- 提交前 lint-staged 自动 biome check --write
- commit message 遵循 conventional commits（commitlint 强制）

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。
