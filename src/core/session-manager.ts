//* 负责编排会话的持久化与重启恢复
import { randomUUID } from 'node:crypto'

import type { CliId } from '@/cli/types'
import type { SessionStore } from './session-store'

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed'

export interface Session {
  id: string // Agent OS 自己的会话 ID
  threadId: string // 负责找到飞书话题
  chatId: string // 划定群聊范围
  cliId: CliId // 记录以后交给哪个执行引擎，比如 Claude Code 或 Codex
  cliSessionId?: string
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
  creating: ['active', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
}

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId
}

function sessionKey(chatId: string, threadId: string): string {
  return `${chatId}:${threadId}`
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
        sessionKey(session.chatId, session.threadId),
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
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空')

    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.chatId, updated.threadId)
    this.sessions.set(key, updated)

    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }

    return updated
  }

  async resolve(message: MessageAddress): Promise<ResolvedSession> {
    const threadId = topicIdOf(message)
    const key = sessionKey(message.chatId, threadId)
    const existing = this.sessions.get(key)
    if (existing) return { session: existing, isNew: false }

    const now = this.now().toISOString()
    const session: Session = {
      id: this.createId(),
      threadId,
      chatId: message.chatId,
      cliId: 'claude',
      status: 'creating',
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
    const key = sessionKey(updated.chatId, updated.threadId)
    this.sessions.set(sessionKey(updated.chatId, updated.threadId), updated)

    try {
      await this.persist()
    } catch (err) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw err
    }

    return updated
  }
}
