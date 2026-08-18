import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'

import { spawnCli } from './spawn-cli'

export interface ClaudeRunResult {
  answer: string
  sessionId?: string
}

export interface RunClaudeOptions {
  prompt: string
  cwd: string
  signal?: AbortSignal
}

interface ClaudeResultEvent {
  type: 'result'
  is_error?: boolean
  result?: string
  session_id?: string
}

function isResultEvent(value: unknown): value is ClaudeResultEvent {
  if (!value || typeof value !== 'object') return false
  return (value as { type?: unknown }).type === 'result'
}

export async function runClaude(
  options: RunClaudeOptions,
): Promise<ClaudeRunResult> {
  // Windows 下 prompt 走 stdin（`-p` 后不跟参数即读 stdin），其他平台直接作为 `-p <prompt>`。
  const useStdin = process.platform === 'win32'
  const args = [
    '-p',
    ...(useStdin ? [] : [options.prompt]),
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  const child = spawnCli('claude', args, {
    cwd: options.cwd,
    stdin: useStdin ? 'pipe' : 'ignore',
  })

  // AbortSignal → 手动 kill 子进程
  const abortHandler = () => child.kill()
  options.signal?.addEventListener('abort', abortHandler, { once: true })

  // 后台读取 stderr
  const stderrPromise = new Response(
    child.stderr as ReadableStream<Uint8Array> | null,
  ).text()

  // stdin 输入（仅 Windows）
  if (useStdin) {
    const sink = child.stdin!
    if (typeof sink === 'number') throw new Error('unexpected stdin fd')
    sink.write(options.prompt)
    sink.end()
  }

  const lines = createInterface({
    input: Readable.fromWeb(
      child.stdout as ReadableStream<Uint8Array>,
    ) as NodeJS.ReadableStream,
  })

  let finalResult: ClaudeRunResult | undefined
  let resultError: Error | undefined

  try {
    for await (const line of lines) {
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!isResultEvent(event)) continue
      if (event.is_error) {
        resultError = new Error(event.result || 'Claude Code 执行失败')
        continue
      }
      if (typeof event.result === 'string') {
        finalResult = {
          answer: event.result,
          sessionId: event.session_id,
        }
      }
    }

    // 如果 stderr 还没读完，等它结束
    const stderr = await stderrPromise

    if (options.signal?.aborted) {
      throw new Error('Claude Code 执行已取消')
    }
    if (resultError) throw resultError

    const exitCode = await child.exited
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Claude Code 退出，状态码 ${exitCode}`)
    }
    if (!finalResult) {
      throw new Error('Claude Code 没有返回最终结果')
    }

    return finalResult
  } finally {
    options.signal?.removeEventListener('abort', abortHandler)
    lines.close()
  }
}
