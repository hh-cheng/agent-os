import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'

import type { CardJson } from './card'
import { parseMentions, type Mention } from './message-parser'

export interface IncomingMessage {
  messageId: string
  chatId: string
  chatType: string // 'p2p' 单聊 | 'group' 群聊
  messageType: string // 'text' | 'image' | 'post' | ...
  text: string // text 消息的正文（其他类型为空串）
  senderOpenId: string
  rootId: string // 指向话题的根消息，根消息自己的 rootId 为空
  threadId: string // 标记话题本身，同一话题里的消息共享这个 ID
  mentions: Mention[]
  rawContent: string
}

export interface BotOptions {
  appId: string
  appSecret: string
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>
}

export interface Bot {
  client: Lark.Client
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  updateCard: (messageId: string, card: CardJson) => Promise<void>
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    saveDir: string,
    fileName?: string,
  ) => Promise<string>
}

interface PostElement {
  tag?: string
  text?: string
  user_id?: string
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
}

function renderPostElement(element: PostElement): string {
  if (element.tag === 'at') return element.user_id ?? ''
  if (element.tag === 'br') return '\n'
  if (['text', 'a', 'code', 'code_block', 'md'].includes(element.tag ?? '')) {
    return element.text ?? ''
  }
  return ''
}

function getHeader(headers: unknown, name: string): string {
  if (typeof headers !== 'object' || headers === null) return ''

  const headerRecord = headers as Record<string, unknown>
  const getter = headerRecord.get
  const value =
    typeof getter === 'function'
      ? getter.call(headers, name)
      : (headerRecord[name] ?? headerRecord[name.toLowerCase()])
  const firstValue = Array.isArray(value) ? value[0] : value
  return typeof firstValue === 'string' ? firstValue : ''
}

function resourceExtension(
  type: 'image' | 'file',
  fileName: string | undefined,
  contentType: string,
): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : ''
  if (/^[a-z0-9]{1,10}$/.test(original)) return original

  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin')
}

function extractText(messageType: string, content: string): string {
  const parsed = JSON.parse(content)
  if (messageType === 'text') {
    return parsed.text ?? ''
  }
  if (messageType === 'post') {
    const paragraphs: any[][] = parsed.content ?? []
    return paragraphs
      .flat()
      .filter((el) => el.tag === 'text')
      .map((el) => el.text)
      .join('')
      .trim()
  }
  return ''
}

// 支持将日志或代码粘成飞书代码块
export function extractMessageText(
  messageType: string,
  content: string,
): string {
  const parsed = JSON.parse(content)

  if (messageType === 'text') {
    return parsed.text ?? ''
  }

  if (messageType === 'post') {
    const paragraphs: PostElement[][] = parsed.content ?? []
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }

  return ''
}

export function startBot(opts: BotOptions) {
  const { appId, appSecret, onMessage } = opts

  // 负责所有主动调 API 的动作
  const client = new Lark.Client({ appId, appSecret })

  const bot: Bot = {
    client,
    async reply(messageId, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })
      return res.data?.message_id
    },
    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })
      return res.data?.message_id
    },
    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    },
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })
      const contentType = getHeader(res.headers, 'content-type')
      const extension = resourceExtension(type, fileName, contentType)
      const savePath = join(saveDir, `${fileKey}.${extension}`)
      await mkdir(saveDir, { recursive: true })
      await res.writeFile(savePath)
      return savePath
    },
  }

  // 负责分发，按事件名路由到对应的处理函数
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const m = data.message
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractMessageText(m.message_type, m.content),
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      }
      await onMessage(msg, bot)
    },
  })

  // 维护 WebSocket 长连接，断了自动重连
  const wsClient = new Lark.WSClient({ appId, appSecret })
  wsClient.start({ eventDispatcher: dispatcher })

  return bot
}
