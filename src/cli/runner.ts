import { killCli, spawnCli } from './spawn-cli.js'
import { promptInputForPlatform } from './types.js'
import type { CliAdapter, CliEvent, CliRunResult } from './types.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface RunCliOptions {
  adapter: CliAdapter
  prompt: string
  cwd: string
  sessionId?: string
  signal?: AbortSignal
  timeoutMs?: number
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
  // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
  const promptInput = promptInputForPlatform(process.platform)
  const useStdin = promptInput === 'stdin'
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput)
    : adapter.buildArgs(prompt, promptInput)

  const child = spawnCli(adapter.command, args, {
    cwd,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (child.stdin && typeof child.stdin !== 'number') {
    if (useStdin) child.stdin.write(prompt)
    child.stdin.end()
  }

  let observedSessionId = sessionId
  let observedAnswer: string | undefined
  let observedStats: CliRunResult['stats']
  let resultError: Error | undefined
  let stderr = ''
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    killCli(child)
  }, timeoutMs)
  const abort = () => killCli(child)
  signal?.addEventListener('abort', abort, { once: true })

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
        if (event.answer) observedAnswer = event.answer
        if (event.stats) observedStats = event.stats
      }
    }
  }

  async function readStdout() {
    const stdout = child.stdout as ReadableStream<Uint8Array>
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    }

    buffer += decoder.decode()
    if (buffer) processLine(buffer)
  }

  async function readStderr() {
    const stderrStream = child.stderr as ReadableStream<Uint8Array>
    const reader = stderrStream.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderr += decoder.decode(value, { stream: true })
    }
    stderr += decoder.decode()
  }

  let exitCode: number
  try {
    ;[, , exitCode] = await Promise.all([
      readStdout(),
      readStderr(),
      child.exited,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }

  if (timedOut) throw new Error(`${adapter.displayName} 执行超时`)
  if (signal?.aborted) throw new Error(`${adapter.displayName} 执行已取消`)
  if (resultError) throw resultError
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `${adapter.displayName} 退出，状态码 ${exitCode}`,
    )
  }
  if (!observedAnswer) {
    throw new Error(`${adapter.displayName} 没有返回最终结果`)
  }

  return {
    answer: observedAnswer,
    sessionId: observedSessionId,
    ...(observedStats ? { stats: observedStats } : {}),
  }
}
