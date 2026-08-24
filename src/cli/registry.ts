import { CodexAdapter } from './codex-adapter'
import { ClaudeAdapter } from './claude-adapter'
import type { CliAdapter, CliId } from './types'

const adapters: Record<CliId, CliAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
}

export function getCliAdapter(id: CliId): CliAdapter {
  return adapters[id]
}

export function listCliAdapters(): CliAdapter[] {
  return Object.values(adapters)
}

export function parseCliId(value: string | undefined): CliId {
  if (!value) return 'claude'
  if (value === 'claude' || value === 'codex') return value
  throw new Error(`不支持的 DEFAULT_CLI: ${value}，请填写 claude 或 codex`)
}
