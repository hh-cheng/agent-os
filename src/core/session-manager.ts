//* 负责编排会话的持久化与重启恢复
import { randomUUID } from 'node:crypto'

import type { CliId } from '@/cli/types'
import type { SessionStore } from './session-store'

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed'

export interface Session {
  id: string // Agent OS 自己的会话 ID
  botId: string
  threadId: string // 负责找到飞书话题
  chatId: string // 划定群聊范围
  cliId: CliId // 记录以后交给哪个执行引擎，比如 Claude Code 或 Codex
  cliSessionId?: string
  workspaceDir: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface MessageAddress {
  messageId: string
  chatId: string
  threadId: string
  rootId: string
}

export interface ResolvedSession {
  session: Session
  isNew: boolean
}

export interface SessionManagerOptions {
  now?: () => Date
  createId?: () => string
  store?: SessionStore
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['idle', 'active', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
}

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  return `${botId}:${chatId}:${threadId}`
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly store?: SessionStore

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.store = options.store
  }

  get size(): number {
    return this.sessions.size
  }

  static async open(options: SessionManagerOptions = {}) {
    const manager = new SessionManager(options)

    const restored = (await options.store?.load()) ?? []
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      )
    }

    return manager
  }

  private async persist() {
    await this.store?.save([...this.sessions.values()])
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    )
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空')
    return this.updateCliSelection(sessionId, cliSessionId)
  }

  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, void 0)
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)

    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)

    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }

    return updated
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = 'claude',
    botId = 'default',
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message)
    const key = sessionKey(botId, message.chatId, threadId)
    const existing = this.sessions.get(key)
    if (existing) return { session: existing, isNew: false }

    const now = this.now().toISOString()
    const session: Session = {
      cliId,
      botId,
      threadId,
      workspaceDir,
      status: 'creating',
      id: this.createId(),
      chatId: message.chatId,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(key, session)

    try {
      await this.persist()
    } catch (err) {
      // 如果第一次保存失败，刚创建的内存会话也会删除。吓一跳消息可以重新创建，不会永远卡在 creating
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw err
    }

    return { session, isNew: true }
  }

  async transition(sessionId: string, nextStatus: SessionStatus) {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`)
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(
      sessionKey(updated.botId, updated.chatId, updated.threadId),
      updated,
    )

    try {
      await this.persist()
    } catch (err) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw err
    }

    return updated
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!workspaceDir) throw new Error('工作目录不能为空')
    if (current.workspaceDir === workspaceDir) return current

    const { cliSessionId: _previousCliSessionId, ...rest } = current
    const updated: Session = {
      ...rest,
      workspaceDir,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }
    return updated
  }
}
