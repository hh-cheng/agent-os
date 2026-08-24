# AGENTS - agent-os

## 目标

本项目是飞书场景下的 AI 编程指挥台，支持 `/claude` 与 `/codex` 任务入口，核心是基于 Bun 与飞书 Lark WebSocket 的会话编排服务。

## 运行与栈约束

- 使用 Bun 作为主要运行时，尽量避免引入 Node-only 的执行方式。
- 使用 `bun` 命令运行脚本与构建，不默认切换到 npm/pnpm/yarn（除非项目已有明确流程）。
- TypeScript + ESM 项目；遵循 `package.json`/`tsconfig` 内既有规范。
- Biome 为唯一 lint/format 工具，不额外使用 ESLint/Prettier。

## 命令

- `bun dev`：启动 `src/index.ts`
- `bun build`：`bun build src/index.ts --outdir dist --target bun`
- `bun probe:cli`：调试 CLI stream-json 输出
- `bun lint` / `bun lint:fix`：Biome 检查

## 质量与流程

- 提交前确保 `Biome` 通过；`AGENTS.md` 中的约定与 `CLAUDE.md` 保持一致。
- 文件改动为 `*.ts/x` 或 `*.js/x` 时，`.claude/hooks/lint-changed.sh` 会按文件自动执行 `bun biome check --write`。
- 绝不提交真实凭证；通过 `.env` / `.env.example` 管理。
- Git 提交遵循 conventional commits。

## 与 .claude/.codex 对齐

- `.claude/settings.json` 与 `.codex/settings.json` 都定义了 `PostToolUse` 自动 lint 规则；`settings.local.json` 规定了可执行命令白名单与 MCP 开关。
- `.codex/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`（链接到 `CLAUDE.md`）用于统一编辑器级行为约束。
