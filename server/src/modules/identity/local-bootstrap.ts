import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

import { createDatabase } from '../../infrastructure/postgres/database.ts'
import { runMigrations } from '../../infrastructure/postgres/migration-runner.ts'
import { loadStartupIdentityConfiguration, localIdentityConfiguration } from './config.ts'
import { LocalAuthService, type LocalAccountInput } from './local-auth-service.ts'
import { invalidRequest } from '../../domain/request-errors.ts'

const configuration = loadStartupIdentityConfiguration()
if (!process.env.DSH_WORK_DATABASE_URL) throw new Error('DSH_WORK_DATABASE_URL 未配置')
const input = await readInput()
const database = createDatabase({ url: process.env.DSH_WORK_DATABASE_URL })
try {
  await runMigrations(database)
  const result = await new LocalAuthService(localIdentityConfiguration(configuration), database).bootstrap(input)
  console.log(`独立管理员已初始化：${result.username}（${result.userId}）。后续账号请在“员工与权限”创建。`)
} finally {
  await database.end()
}

async function readInput(): Promise<LocalAccountInput> {
  if (!process.stdin.isTTY) {
    // Decode once so a UTF-8 character (for example a Chinese name) split across chunks stays intact.
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += bytes.length
      if (size > 16_384) throw invalidRequest('初始化输入超过长度限制')
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as LocalAccountInput
  }
  let muted = false
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk)
    callback()
  } })
  const prompts = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const username = await prompts.question('登录账号（手机号或邮箱）：')
    const name = await prompts.question('管理员姓名：')
    const passwordQuestion = prompts.question('密码（8–64 字符，输入隐藏）：')
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
    return { username, name, password }
  } finally {
    muted = false
    prompts.close()
  }
}
