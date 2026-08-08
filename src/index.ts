import 'dotenv/config'
// import { existsSync } from 'node:fs'
// import { execSync } from 'node:child_process'

import { startBot } from './im/lark'

// const VERSION = '0.1.0'
const appId = process.env.BOT_A_APP_ID
const appSecret = process.env.BOT_A_APP_SECRET

if (!appId || !appSecret) {
  console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET, 请检查 .env')
  process.exit(1)
}

// function hasCommand(cmd: string): boolean {
//   try {
//     execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: '/bin/sh' })
//     return true
//   } catch {
//     return false
//   }
// }

// function check(label: string, ok: boolean, hint: string): void {
//   console.log(`  ${ok ? '✅' : '⚠️ '} ${label}${ok ? '' : `  → ${hint}`}`)
// }

// console.log(`\nAgent OS v${VERSION} — 一个人，一队 Agent\n`)
// console.log('环境自检：')

// const bunMajor = Number(process.versions.bun.split('.')[0])
// check(`bun v${process.versions.bun}`, bunMajor >= 1, '需要 bun v1.3.14+')
// check(
//   '.env 配置文件',
//   existsSync('.env'),
//   '复制 .env.example 为 .env 并填入飞书凭证',
// )
// check(
//   'Claude Code CLI',
//   hasCommand('claude'),
//   '接入 CLI 前需要安装；无 Anthropic 订阅可使用 DeepSeek',
// )
// check('Codex CLI', hasCommand('codex'), '后续接入 Codex 前再安装')

console.log('Agent OS 启动，正在建立飞书长连接...')

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    console.log(
      `[收到] chat=${msg.chatId} type=${msg.chatType} sender=${msg.senderOpenId} 内容: ${msg.text}`,
    )
    const replyId = await bot.reply(msg.messageId, `收到：${msg.text}`)
    console.log(`[已回] message_id=${replyId}`)
  },
})
