//* 负责具体的读写文件
import { z } from 'zod'
import { dirname } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { isRecord } from '../utils'
import type { Session } from './session-manager'

export interface SessionStore {
  load(): Promise<Session[]>
  save(sessions: Session[]): Promise<void>
}

const SessionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  botId: z.string().min(1),
  cliId: z.enum(['claude', 'codex']),
  cliSessionId: z.string().min(1).optional(),
  workspaceDir: z.string().min(1),
  status: z.enum(['creating', 'active', 'idle', 'closed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

// 给旧记录补充确实的 botId 和 workspaceDir
function migrateLegacySession(
  row: unknown,
  legacyBotId: string,
  defaultWorkspaces: Readonly<Record<string, string>>,
): { candidate: unknown; migrated: boolean } {
  if (!isRecord(row)) return { candidate: row, migrated: false }

  const needsBotId = !('botId' in row)
  const needsWorkspace = !('workspaceDir' in row)
  if (!needsBotId && !needsWorkspace) {
    return { candidate: row, migrated: false }
  }

  const candidate: Record<string, unknown> = { ...row }
  if (needsBotId) candidate.botId = legacyBotId
  const botId =
    typeof candidate.botId === 'string' ? candidate.botId : legacyBotId
  if (needsWorkspace) {
    candidate.workspaceDir = defaultWorkspaces[botId] ?? process.cwd()
  }
  return { candidate, migrated: true }
}

function recoverInterruptedSession(session: Session): Session {
  if (session.status !== 'creating' && session.status !== 'active') {
    return session
  }
  return { ...session, status: 'idle' }
}

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly legacyBotId = 'default',
    private readonly defaultWorkspaces: Readonly<Record<string, string>> = {},
  ) {}

  async load(): Promise<Session[]> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const rows: unknown = JSON.parse(content)
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`)
    }

    const sessions: Session[] = []
    let needsCleanup = false
    for (const row of rows) {
      const { candidate, migrated } = migrateLegacySession(
        row,
        this.legacyBotId,
        this.defaultWorkspaces,
      )

      const result = SessionSchema.safeParse(candidate)

      if (!result.success) {
        needsCleanup = true
        continue
      }

      if (migrated) needsCleanup = true

      const recovered = recoverInterruptedSession(result.data)
      if (recovered.status !== result.data.status) needsCleanup = true
      sessions.push(recovered)
    }
    if (needsCleanup) await this.save(sessions)
    return sessions
  }

  save(sessions: Session[]): Promise<void> {
    const snapshot = JSON.stringify(sessions, null, 2)
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      await writeFile(tempPath, `${snapshot}\n`, 'utf8')
      await rename(tempPath, this.filePath)
    }

    // 因为对同一文件并发调用 writeFile() 并不安全所以用 writeQueue 让快照按顺序落盘
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}
