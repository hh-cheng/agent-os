import type { CliId } from '../cli/types'

export type SlashCommand =
  | { name: 'close' | 'status' | 'help' }
  | { name: 'cd'; path?: string }

const CD_RE = /^(?:@\S+\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/
const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/
const CLI_REQUEST_RE = /^(?:@\S+\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/

export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim()
  const cdMatch = CD_RE.exec(value)
  if (cdMatch) return { name: 'cd', path: cdMatch[1]?.trim() || void 0 }
  const match = COMMAND_RE.exec(value)
  if (!match) return
  return { name: match[1] as 'close' | 'status' | 'help' }
}

export interface CliRequest {
  cliId: CliId
  prompt: string
}

export function parseCliRequest(text: string): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(text.trim())
  if (!match) return
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? '').trim(),
  }
}
