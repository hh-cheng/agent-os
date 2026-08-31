//* 程序内部交接单
export interface CollaborationMessage {
  dispatchId: string // 标识当前投递
  taskId: string // 标识整项写作
  fromBotId: string
  toBotId: string
  workspaceDir: string
  prompt: string
}

export function collaborationTurnKey(message: CollaborationMessage) {
  return `${message.taskId}:${message.toBotId}`
}

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>()

  register(message: CollaborationMessage) {
    this.messages.set(message.dispatchId, message)
  }

  consume(dispatchId: string, toBotId: string) {
    const message = this.messages.get(dispatchId)
    if (!message || message.toBotId !== toBotId) return
    this.messages.delete(dispatchId)
    return message
  }
}
