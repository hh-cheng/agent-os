/**
 * 执行引擎调度器 — 统一启动 CLI 子进程，逐行解析 stream-json 输出，收集最终结果。
 *
 * ## 职责
 * 1. 通过 adapter 将 prompt 转成命令行参数，用 Bun.spawn 启动子进程。
 * 2. 监听 stdout 的 stream-json 逐行解析事件（session → result/error）。
 * 3. 等子进程退出后返回 `{ answer, sessionId }`。
 * 4. 支持超时、AbortSignal 取消、以及 sessionId 续写（resume）。
 *
 * ## 为什么用 Bun 原生写法
 * - `child.exited` 是 `Promise<number>`（直接退出码），不用 Node 的 `close` 事件。
 * - stdout/stderr 是 `ReadableStream`（Web Streams），用 `Readable.fromWeb()` 桥接
 *   到 readline 的流式接口。
 * - Bun.spawn 不支持 AbortSignal，需要用 `signal.addEventListener('abort', …)` 手动
 *   调用 `killCli()`。
 * - stdin 通过 `FileSink.write() + .end()` 写入，不是 Node 的 `child.stdin.write()`。
 * - Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码）。
 */

import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'

import { killCli, spawnCli } from './spawn-cli'
import {
  promptInputForPlatform,
  type CliAdapter,
  type CliRunResult,
} from './types'

/** 子进程默认超时：10 分钟。超时后 kill 进程树并抛出错误。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface RunCliOptions {
  /** 适配器（Claude Code / Codex），定义命令行构建方式和事件解析逻辑 */
  adapter: CliAdapter
  /** 传给 CLI 的提示词 */
  prompt: string
  /** CLI 工作目录 */
  cwd: string
  /** 续写会话 ID（有则走 --resume 路径） */
  sessionId?: string
  /** 外部取消信号 */
  signal?: AbortSignal
  /** 超时毫秒数，默认 10 分钟 */
  timeoutMs?: number
}

/**
 * 启动 CLI 子进程并等待其完成，返回模型回答和会话 ID。
 *
 * 流程：
 * 1. 构建命令行参数（新任务或续写）。
 * 2. Bun.spawn 启动子进程。
 * 3. stdin 写入 prompt（仅 Windows），或直接收口。
 * 4. stdout → readline → adapter.parseEvent → 收集 result/error。
 * 5. 等待 child.exited 获取退出码。
 * 6. 返回最终的 answer + sessionId，或抛出错误。
 * 7. finally 清理由：超时定时器、abort 监听器、readline。
 */
export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  // 1. 构建命令行参数 ────────────────────────────────────
  // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
  const promptInput = promptInputForPlatform(process.platform)
  const useStdin = promptInput === 'stdin'
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput)
    : adapter.buildArgs(prompt, promptInput)

  // 2. 启动子进程 ────────────────────────────────────────
  const child = spawnCli(adapter.command, args, { cwd, stdin: 'pipe' })

  // AbortSignal → kill 子进程（Bun.spawn 不支持 signal 选项，手动处理）
  const abortHandler = () => killCli(child)
  signal?.addEventListener('abort', abortHandler, { once: true })

  // 超时也 kill
  const timer = setTimeout(() => killCli(child), timeoutMs)

  // 3. stdin：Windows 写入 prompt，其他平台只收口 ────────
  const sink = child.stdin!
  // Bun 的 stdin 在 pipe 模式下是 FileSink；fd 数字表示 inherit/ignore 等不适用场景
  if (typeof sink === 'number') throw new Error('unexpected stdin fd')
  if (useStdin) sink.write(prompt)
  sink.end()

  // 4. 后台收集 stderr ─────────────────────────────────
  // Bun 子进程的 stderr 是 Web ReadableStream，用 Response.text() 读取全文。
  const stderrPromise = new Response(
    child.stderr as ReadableStream<Uint8Array> | null,
  ).text()

  // 5. stdout → readline 逐行解析 ──────────────────────
  // Bun ReadableStream → Node ReadableStream → readline 逐行消费
  const lines = createInterface({
    input: Readable.fromWeb(
      child.stdout as ReadableStream<Uint8Array>,
    ) as NodeJS.ReadableStream,
  })

  // 跟踪从事件流中观察到的 sessionId（resume 时 adapter 可能不在每条事件里重复返回）
  let observedSessionId = sessionId
  let finalResult: CliRunResult | undefined
  let resultError: Error | undefined

  try {
    // 6. 逐行解析 stream-json ──────────────────────────
    for await (const line of lines) {
      const event = adapter.parseEvent(line)
      if (!event) continue // 非事件行（verbose 日志等），跳过

      if (event.sessionId) observedSessionId = event.sessionId

      if (event.type === 'error') {
        resultError = new Error(event.message)
        continue // 不立即抛出，等子进程退出后再判断
      }

      if (event.type === 'result') {
        finalResult = {
          answer: event.answer,
          sessionId: event.sessionId ?? observedSessionId,
        }
      }
    }

    // 7. 结果校验 ──────────────────────────────────────
    // 等 stderr 读完（子进程退出后 stderr 流才会 close）
    const stderr = await stderrPromise

    // 优先检查外部取消
    if (signal?.aborted) {
      throw new Error(`${adapter.displayName} 执行已取消`)
    }
    // 如果 stream-json 中出现了 is_error 事件
    if (resultError) throw resultError

    // Bun 的 child.exited 是 Promise<number>，直接就是退出码
    const exitCode = await child.exited
    if (exitCode !== 0) {
      throw new Error(
        stderr.trim() || `${adapter.displayName} 退出，状态码 ${exitCode}`,
      )
    }

    // 防御：子进程正常退出但没输出 result 事件
    if (!finalResult) {
      throw new Error(`${adapter.displayName} 没有返回最终结果`)
    }

    return finalResult
  } finally {
    // 8. 清理 ──────────────────────────────────────────
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortHandler)
    lines.close()
  }
}
