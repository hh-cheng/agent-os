# Claude Code 流式事件链实现

## 概述

Agent OS 通过 `claude -p <prompt> --output-format stream-json --verbose` 启动 Claude Code CLI 子进程，逐行解析其 JSON 流输出，提取会话 ID、工具调用、上下文用量、最终结果等信息，并通过 `CliAdapter` 接口抽象化不同 CLI 引擎的差异。

## 架构层次

```
调用方（src/index.ts）
    │  runCli({ adapter, prompt, cwd, … })
    ▼
┌──────────────────────────────────────┐
│  src/cli/runner.ts — 子进程编排       │
│  · Bun.spawn 启动 CLI                  │
│  · Web ReadableStream 读取 stdout      │
│  · 逐行 → adapter.parseEvents(line)    │
│  · 超时 / 取消 / 错误 → throw          │
└─────────────┬────────────────────────┘
              │ 逐行 JSON
    ▼
┌──────────────────────────────────────┐
│  src/cli/claude-adapter.ts — 事件解析  │
│  · JSON.parse(line) → CliEvent[]      │
│  · 映射 Claude 原生事件 → 统一事件      │
└─────────────┬────────────────────────┘
              │ CliEvent[]
    ▼
┌──────────────────────────────────────┐
│  src/cli/types.ts — 统一事件模型       │
│  · session / tool_start / tool_end    │
│  · context / result / error           │
└──────────────────────────────────────┘
```

## 核心类型（`src/cli/types.ts`）

### CliAdapter 接口

```typescript
interface CliAdapter {
  readonly id: CliId           // 'claude'
  readonly command: string      // 'claude'
  readonly displayName: string  // 'Claude Code'
  buildArgs(prompt: string): string[]
  buildResumeArgs(prompt: string, sessionId: string): string[]
  parseEvents(line: string): CliEvent[]
}
```

- `buildArgs` — 新会话的命令行参数
- `buildResumeArgs` — 带 `--resume <sessionId>` 的续写参数
- `parseEvents` — 把一行 JSON 解析成一个或多个 `CliEvent`

### 统一事件类型 `CliEvent`

| 事件 | 含义 | 典型触发 |
|------|------|---------|
| `session` | 拿到 Claude Code 会话 ID | system/init 事件 |
| `tool_start` | 工具调用开始 | assistant/tool_use block |
| `tool_end` | 工具调用结束（含成功/失败） | user/tool_result block |
| `context` | 上下文窗口用量 | assistant 消息中的 usage |
| `result` | 最终回答文本 + 统计 | result 事件（非 error） |
| `error` | 执行失败 | result 事件（is_error=true） |

### CliRunResult

```typescript
interface CliRunResult {
  answer: string        // 最终回答文本
  sessionId?: string    // 会话 ID，供 --resume 续写
  stats?: CliRunStats   // 耗时、轮次、token 用量等
}
```

## 事件解析流程（`src/cli/claude-adapter.ts`）

`ClaudeAdapter.parseEvents(line)` 对每一行 JSON 按 `event.type` 分发：

### 1. system/init → `session`

```json
{ "type": "system", "subtype": "init", "session_id": "abc123" }
```

→ 输出 `{ type: "session", sessionId: "abc123" }`

这是最早出现的事件，`runner.ts` 会记录 `observedSessionId`，后续 `--resume` 续写时用此 ID 重连同一会话。

### 2. assistant 消息 → `context` + `tool_start`

每一条 `assistant` 消息可能同时带有 token 用量和工具调用块。解析时：

- **context**：从 `message.usage` 提取 `input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens`，总和作为 `usedTokens`
- **tool_start**：遍历 `message.content[]`，筛选 `type === "tool_use"` 的 block，把工具名映射为中文标签

```json
{
  "type": "assistant",
  "message": {
    "usage": { "input_tokens": 500, "output_tokens": 100 },
    "content": [
      { "type": "tool_use", "id": "toolu_01", "name": "Read", "input": { "file_path": "/src/a.ts" } }
    ]
  }
}
```

→ 输出两条：
- `{ type: "context", usedTokens: 600 }`
- `{ type: "tool_start", toolUseId: "toolu_01", toolName: "Read", label: "读取文件", detail: "src/a.ts" }`

工具标签映射（`TOOL_LABELS`）：

| 工具名 | 中文标签 | detail 来源 |
|--------|---------|------------|
| Bash | 运行命令 | description 字段 |
| Read | 读取文件 | file_path 短路径 |
| Write | 写入文件 | file_path 短路径 |
| Edit | 修改文件 | file_path 短路径 |
| Glob | 查找文件 | pattern 字段 |
| Grep | 搜索代码 | pattern 字段 |
| Agent / Task | 启动子任务 | description 字段 |
| WebSearch | 搜索资料 | query 字段 |
| （其他） | 调用 \<name\> | 无 |

### 3. user/tool_result → `tool_end`

```json
{
  "type": "user",
  "message": {
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_01", "is_error": false }
    ]
  }
}
```

→ 输出 `{ type: "tool_end", toolUseId: "toolu_01", failed: false }`

`is_error === true` 时 `failed` 为 true，表示工具执行失败（如命令返回非零退出码）。

### 4. result → `result` 或 `error`

```json
{ "type": "result", "is_error": false, "result": "回答文本", "session_id": "abc123", "duration_ms": 12000, "num_turns": 3, "usage": { … }, "modelUsage": { … } }
```

- `is_error === false` → `{ type: "result", answer: "回答文本", sessionId: "abc123", stats: { … } }`
- `is_error === true` → `{ type: "error", message: "错误信息", sessionId: "abc123" }`

stats 从 `duration_ms`、`num_turns`、`usage`、`modelUsage` 提取，含总 token 数、输入/输出 token、缓存读写 token、上下文窗口大小等。

## 子进程编排（`src/cli/runner.ts`）

### Bun.spawn 启动

```typescript
const child = spawnCli(adapter.command, args, {
  cwd,
  signal,
  stdio: ['ignore', 'pipe', 'pipe'],  // stdin ignore, stdout/stderr pipe
})
```

`spawnCli` 是 `Bun.spawn` 的薄封装（`src/cli/spawn-cli.ts`），跨平台（Windows 用 `taskkill /T /F` 杀进程树）。

### stdout 流式读取

与 Node.js `readline` 不同，Bun 的 `Subprocess.stdout` 是 Web-standard `ReadableStream<Uint8Array>`。读取方式：

```
1. child.stdout.getReader() → ReadableStreamDefaultReader
2. TextDecoder.decode(chunk, { stream: true }) → 追加到缓冲区
3. 按 \n 切割成行，逐行调用 adapter.parseEvents(line)
4. 流结束时 flush 剩余缓冲区
```

### 三路并行等待

```typescript
await Promise.all([
  readStdout(),   // 读取 stdout，逐行解析事件
  readStderr(),   // 收集 stderr 到字符串
  child.exited,   // Bun 的退出 Promise，resolve 为退出码
])
```

三者并行推进，任一完成都不会阻塞另外两路。`child.exited` 是 Bun `Subprocess` 的原生属性，等价于 Node.js 的 `close` 事件。

### 错误与退出处理

退出后按优先级判断：

| 优先级 | 条件 | 抛出的错误 |
|--------|------|-----------|
| 1 | `timedOut === true` | `Claude Code 执行超时`（默认 10 分钟） |
| 2 | `signal.aborted` | `Claude Code 执行已取消` |
| 3 | `resultError` 存在（流中收到 error 事件） | 直接抛出 resultError |
| 4 | `exitCode !== 0` | `stderr 内容` 或 `Claude Code 退出，状态码 N` |
| 5 | `finalResult` 为 undefined | `Claude Code 没有返回最终结果` |

### 超时与取消

- **超时**：`setTimeout` 10 分钟后调用 `killCli(child)`，标记 `timedOut = true`
- **取消**：外部通过 `AbortSignal` 控制，`signal` 传入 `spawnCli` → Bun 在 abort 时自动 kill 子进程。`readStdout`/`readStderr` 在 stream cancel 时 catch 住异常不抛，退出后由第 2 优先级判断

## 完整事件序列示例

一次典型的 `claude -p "读 README.md" --output-format stream-json --verbose` 执行，JSON 行序列如下：

```
→ {"type":"system","subtype":"init","session_id":"abc123",...}
   parseEvents → [{ type: "session", sessionId: "abc123" }]
   runner 记录 observedSessionId = "abc123"

→ {"type":"assistant","message":{"usage":{...},"content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"README.md"}}]}}
   parseEvents → [
     { type: "context", usedTokens: 234 },
     { type: "tool_start", toolUseId: "toolu_01", toolName: "Read", label: "读取文件", detail: "README.md" }
   ]

→ {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","is_error":false}]}}
   parseEvents → [{ type: "tool_end", toolUseId: "toolu_01", failed: false }]

→ {"type":"assistant","message":{"content":[{"type":"text","text":"README 内容如下..."}]}}
   parseEvents → [] （纯文本回复，无事件）

→ {"type":"result","result":"README 内容如下...","session_id":"abc123","duration_ms":5000,"num_turns":1,...}
   parseEvents → [{
     type: "result",
     answer: "README 内容如下...",
     sessionId: "abc123",
     stats: { durationMs: 5000, turns: 1, totalTokens: 500, ... }
   }]
   runner 收到 result → 记录 finalResult
```

## 与调用方的衔接

`src/index.ts` 调用 `runCli` 的典型方式：

```typescript
const result = await runCli({
  adapter: claudeAdapter,
  prompt: "用户的自然语言指令",
  sessionId: session.cliSessionId,  // 续写时传入，首次为 undefined
  cwd: cliWorkdir,
  signal: abortController.signal,
  onEvent: (event) => {
    // 实时更新飞书卡片：进度条、工具名、token 用量
  },
})
// result: { answer: string, sessionId: string, stats?: CliRunStats }
```

`onEvent` 回调实时接收解析后的事件，调用方据此更新飞书互动卡片（进度状态、当前执行的工具名、上下文用量等），实现用户在飞书中“看到” Claude Code 的执行过程。

## 关键设计决策

1. **适配器模式**：`CliAdapter` 接口把 CLI 引擎差异封装在 `buildArgs` / `parseEvents` 里，`runner` 只做进程编排，不感知具体 CLI。未来接入 Codex 等只需实现新的 adapter。

2. **Web Stream 而非 Node.js Stream**：Bun 的 `Subprocess` 暴露的是 Web-standard `ReadableStream`，不用 Node.js 的 `EventEmitter` 风格 API。手动用 `getReader()` + `TextDecoder` 分行，避免引入 `node:readline` 的兼容问题。

3. **一行 JSON 可产出多个 CliEvent**：一条 `assistant` 消息可能同时有 `usage`（context 事件）和多个 `tool_use`（tool_start 事件），`parseEvents` 返回数组，runner 逐个处理。

4. **会话 ID 追踪**：`sessionId` 从 `system/init` 事件获取，贯穿整个流式解析，最终回写到结果和错误事件里。runner 的 `observedSessionId` 在未收到 init 事件时 fallback 到 `options.sessionId`（续写时传入）。

5. **killCli 跨平台**：Linux/macOS 发 SIGTERM（信号 15），Windows 用 `taskkill /T /F` 杀整个进程树（`/T` 递归子进程，`/F` 强制）。