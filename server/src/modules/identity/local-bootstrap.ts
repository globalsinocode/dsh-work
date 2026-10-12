import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

import { createDatabase } from '../../infrastructure/postgres/database.ts'
import { runMigrations } from '../../infrastructure/postgres/migration-runner.ts'
import { loadIdentityConfiguration } from './config.ts'
import { LocalAuthService, type LocalAccountInput } from './local-auth-service.ts'

const configuration = loadIdentityConfiguration()
if (configuration.mode !== 'local') throw new Error('初始化独立账号前请显式设置 DSH_WORK_AUTH_MODE=local')
if (!process.env.DSH_WORK_DATABASE_URL) throw new Error('DSH_WORK_DATABASE_URL 未配置')
const input = await readInput()
const database = createDatabase({ url: process.env.DSH_WORK_DATABASE_URL })
try {
  await runMigrations(database)
  const result = await new LocalAuthService(configuration, database).bootstrap(input)
  console.log(`独立管理员已初始化：${result.username}（${result.userId}）。后续账号请在“员工与权限”创建。`)
} finally {
  await database.end()
}

async function readInput(): Promise<LocalAccountInput> {
  if (!process.stdin.isTTY) {
    let body = ''
    for await (const chunk of process.stdin) {
      body += String(chunk)
      if (body.length > 16_384) throw new Error('初始化输入超过长度限制')
    }
    return JSON.parse(body) as LocalAccountInput
  }
  let muted = false
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk)
    callback()
  } })
  const prompts = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const username = await prompts.question('登录账号：')
    const existingUserId = (await prompts.question('绑定既有员工 ID（新建管理员请留空）：')).trim() || undefined
    const name = existingUserId ? '' : await prompts.question('管理员姓名：')
    const passwordQuestion = prompts.question('密码（15–128 字符，输入隐藏）：')
    muted = true
    const password = await passwordQuestion
    muted = false
    process.stdout.write('\n')
    const confirmation = prompts.question('再次输入密码：')
    muted = true
    const confirmed = await confirmation
    muted = false
    process.stdout.write('\n')
    if (password !== confirmed) throw new Error('两次密码不一致，未创建账号')
    return { username, name, password, existingUserId }
  } finally {
    muted = false
    prompts.close()
  }
}
