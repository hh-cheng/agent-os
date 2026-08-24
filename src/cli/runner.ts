import { killCli, spawnCli } from './spawn-cli'
import type { CliAdapter, CliEvent, CliRunResult } from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface RunCliOptions {
  cwd: string
  prompt: string
  adapter: CliAdapter
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: CliEvent) => void
}

export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
  } = options

  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId)
    : adapter.buildArgs(prompt)

  const child = spawnCli(adapter.command, args, {
    cwd,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  let timedOut = false
  let observedSessionId = sessionId
  let resultError: Error | undefined
  let finalResult: CliRunResult | undefined

  const timer = setTimeout(() => {
    timedOut = true
    killCli(child)
  }, timeoutMs)

  const finish = () => clearTimeout(timer)

  function processLine(line: string) {
    for (const event of adapter.parseEvents(line)) {
      onEvent?.(event)
      if ('sessionId' in event && event.sessionId) {
        observedSessionId = event.sessionId
      }
      if (event.type === 'error') {
        resultError = new Error(event.message)
        continue
      }
      if (event.type === 'result') {
        finalResult = {
          answer: event.answer,
          sessionId: event.sessionId ?? observedSessionId,
          ...(event.stats ? { stats: event.stats } : {}),
        }
      }
    }
  }

  // Read stdout as a Web ReadableStream (Bun native)
  const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const stdoutDecoder = new TextDecoder()
  let stdoutBuffer = ''

  const readStdout = async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read()
        if (done) break
        stdoutBuffer += stdoutDecoder.decode(value, { stream: true })
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() || ''
        for (const line of lines) processLine(line)
      }
      // flush remaining buffer
      if (stdoutBuffer) processLine(stdoutBuffer)
    } catch {
      // stream was cancelled (signal abort / kill)
    }
  }

  // Read stderr as a Web ReadableStream
  const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader()
  const stderrDecoder = new TextDecoder()

  const readStderr = async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read()
        if (done) break
        stderr += stderrDecoder.decode(value, { stream: true })
      }
    } catch {
      // stream was cancelled
    }
  }

  // Wait for all streams and process to finish
  let exitCode = 0
  try {
    await Promise.all([
      readStdout(),
      readStderr(),
      child.exited.then((code) => {
        exitCode = code
      }),
    ])
  } catch {
    // safety net: Bun.spawn already throws synchronously on spawn failure,
    // but child.exited may reject if the internal watcher fails
  }

  finish()

  if (timedOut) {
    throw new Error(`${adapter.displayName} 执行超时`)
  }
  if (signal?.aborted) {
    throw new Error(`${adapter.displayName} 执行已取消`)
  }
  if (resultError) throw resultError
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `${adapter.displayName} 退出，状态码 ${exitCode}`,
    )
  }
  if (!finalResult) {
    throw new Error(`${adapter.displayName} 没有返回最终结果`)
  }
  return finalResult
}
