export type CliId = 'claude'

export type CliPromptInput = 'argument' | 'stdin'

// Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。
export function promptInputForPlatform(
  platform: NodeJS.Platform,
): CliPromptInput {
  return platform === 'win32' ? 'stdin' : 'argument'
}

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'result'; answer: string; sessionId?: string }
  | { type: 'error'; message: string; sessionId?: string }

export interface CliAdapter {
  readonly id: CliId
  readonly command: string
  readonly displayName: string
  buildArgs(prompt: string, promptInput: CliPromptInput): string[]
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[]
  parseEvent(line: string): CliEvent | undefined
}

export interface CliRunResult {
  answer: string
  sessionId?: string
}
