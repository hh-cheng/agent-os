# agent-os

飞书场景下的 AI 编程指挥台。每个飞书话题对应一个 Agent OS 会话，可使用 Claude Code 或 Codex 执行任务，并显示任务进度卡片。

## 本地启动

### 1. 准备依赖

需要 Bun `>= 1.2.4`，以及至少一个已完成登录的 CLI：`claude` 或 `codex`。

```bash
bun install
```

### 2. 配置飞书机器人

复制示例配置和环境变量文件：

```bash
cp config/bots.example.json config/bots.json
cp .env.example .env
```

在 `config/bots.json` 中为每个机器人设置：

- `id`：机器人唯一标识；
- `appIdEnv` 与 `appSecretEnv`：对应 `.env` 中飞书应用凭证的变量名；
- `defaultCli`：新话题默认使用的 `claude` 或 `codex`；
- `workspace`：该机器人的默认工作目录，可使用相对路径或绝对路径。

然后在 `.env` 中填入对应飞书自建应用的 App ID 和 App Secret。`config/bots.json` 与 `.env` 均已忽略，不会被提交。

### 3. 启动服务

```bash
bun dev
```

启动成功后，服务会建立飞书 WebSocket 长连接，并打印已加载的机器人和 CLI 引擎。开发模式会监听源码变更并自动重启。

## 飞书使用方式

- `/claude <任务>`：在新话题中使用 Claude Code。
- `/codex <任务>`：在新话题中使用 Codex。
- `/status`：查看当前会话、CLI 会话 ID 与工作目录。
- `/cd`：查看当前话题的工作目录。
- `/cd <目录>`：切换当前话题的工作目录；下一条任务会在新目录创建 CLI 会话。
- `/close`：关闭当前话题会话。
- `/help`：查看可用命令。

## 常用命令

```bash
bun lint
bun build
bun probe:cli
```

## 接入 Claude Code

可先在本机验证 Claude Code 的流式输出：

```bash
claude -p "读取 package.json，告诉我项目名称" \
  --output-format stream-json \
  --verbose
```

`session.id` 由 Agent OS 生成，用于识别飞书话题和管理执行状态；`session_id` 由 Claude Code 返回，后续会以 `--resume <session_id>` 恢复本机上下文。
