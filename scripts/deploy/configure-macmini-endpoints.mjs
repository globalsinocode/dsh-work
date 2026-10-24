#!/usr/bin/env node

import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'

const options = parseArguments(process.argv.slice(2))
const source = await readFile(options.envFile, 'utf8')
const workbenchPort = readPort(source, 'DSH_WORK_WORKBENCH_PORT', 4174)
// 与服务端 allowedWorkbenchOriginPorts 一致：入口端口集合是
// {绑定端口, DSH_WORK_MOBILE_PORT}，生产用 443 承载不带端口的域名入口。
const workbenchOriginPorts = new Set([workbenchPort, readPort(source, 'DSH_WORK_MOBILE_PORT', 4175)])
const adminPort = readPort(source, 'DSH_WORK_ADMIN_PORT', 4180)
const adminOriginPorts = new Set([adminPort])
const bindAddresses = unique(options.bindAddresses, 'bind address')
for (const address of bindAddresses) {
  if (!isPrivateIpv4(address)) throw new Error(`绑定地址必须是 RFC1918 IPv4: ${address}`)
}
const workbenchOrigins = unique(options.workbenchOrigins.map(
  value => normalizeOrigin(value, workbenchOriginPorts, '员工端'),
), '员工端 Origin')
const adminOrigins = unique(options.adminOrigins.map(
  value => normalizeOrigin(value, adminOriginPorts, '管理端'),
), '管理端 Origin')
for (const address of bindAddresses) {
  if (!workbenchOrigins.some(value => new URL(value).hostname === address)) {
    throw new Error(`员工端 Origin 缺少绑定地址 ${address}`)
  }
  if (!adminOrigins.some(value => new URL(value).hostname === address)) {
    throw new Error(`管理端 Origin 缺少绑定地址 ${address}`)
  }
}
const workbenchDefault = normalizeOrigin(
  options.workbenchDefault ?? workbenchOrigins[0], workbenchOriginPorts, '员工端默认',
)
const adminDefault = normalizeOrigin(
  options.adminDefault ?? adminOrigins[0], adminOriginPorts, '管理端默认',
)
if (!workbenchOrigins.includes(workbenchDefault) || !adminOrigins.includes(adminDefault)) {
  throw new Error('默认 Origin 必须包含在对应允许列表中')
}

const updates = new Map([
  ['DSH_WORK_BIND_ADDRESS', bindAddresses[0]],
  ['DSH_WORK_BIND_ADDRESSES', bindAddresses.join(',')],
  ['DSH_WORK_WORKBENCH_ORIGINS', workbenchOrigins.join(',')],
  ['DSH_WORK_ADMIN_ORIGINS', adminOrigins.join(',')],
  ['DSH_WORK_WORKBENCH_DEFAULT_ORIGIN', workbenchDefault],
  ['DSH_WORK_ADMIN_DEFAULT_ORIGIN', adminDefault],
  ['AI_HUB_WORKBENCH_PORTAL_URL', workbenchDefault],
  ['AI_HUB_ADMIN_PORTAL_URL', adminDefault],
  ['AI_HUB_WORKBENCH_REDIRECT_URI', `${workbenchDefault}/auth/workbench/callback`],
  ['AI_HUB_ADMIN_REDIRECT_URI', `${adminDefault}/auth/admin/callback`],
])
const seen = new Set()
const result = source.split('\n').map((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=/.exec(line)
  if (!match || !updates.has(match[1])) return line
  if (seen.has(match[1])) throw new Error(`runtime.env 包含重复变量 ${match[1]}`)
  seen.add(match[1])
  return `${match[1]}=${updates.get(match[1])}`
})
for (const [key, value] of updates) {
  if (!seen.has(key)) result.push(`${key}=${value}`)
}
const temporary = `${options.output}.new-${process.pid}`
try {
  await writeFile(temporary, `${result.filter((line, index, lines) => line || index < lines.length - 1).join('\n')}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await rename(temporary, options.output)
  await chmod(options.output, 0o600)
} finally {
  await rm(temporary, { force: true })
}

function parseArguments(args) {
  const parsed = {
    bindAddresses: [], workbenchOrigins: [], adminOrigins: [],
    envFile: '', output: '', workbenchDefault: undefined, adminDefault: undefined,
  }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--bind-address') parsed.bindAddresses.push(args[++index])
    else if (name === '--workbench-origin') parsed.workbenchOrigins.push(args[++index])
    else if (name === '--admin-origin') parsed.adminOrigins.push(args[++index])
    else if (name === '--env-file') parsed.envFile = args[++index]
    else if (name === '--output') parsed.output = args[++index]
    else if (name === '--workbench-default-origin') parsed.workbenchDefault = args[++index]
    else if (name === '--admin-default-origin') parsed.adminDefault = args[++index]
    else throw new Error(`未知参数: ${name}`)
  }
  if (!parsed.envFile || !parsed.output || !parsed.bindAddresses.length
    || !parsed.workbenchOrigins.length || !parsed.adminOrigins.length) {
    throw new Error('必须提供 env、output、bind、workbench 和 admin 参数')
  }
  return parsed
}

function readPort(source, key, fallback) {
  const values = source.split('\n').filter(line => line.startsWith(`${key}=`))
  if (values.length > 1) throw new Error(`runtime.env 包含重复变量 ${key}`)
  const value = Number(values[0]?.slice(key.length + 1) ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${key} 必须是有效端口`)
  return value
}

function normalizeOrigin(value, expectedPorts, label) {
  const portList = [...expectedPorts].sort((left, right) => left - right).join('、')
  let url
  try { url = new URL(value) } catch { throw new Error(`${label} Origin 无效: ${value}`) }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (value !== value.toLowerCase() || url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !expectedPorts.has(port)) {
    throw new Error(`${label} 必须是端口 ${portList} 之一的小写 HTTPS Origin`)
  }
  if (!isAllowedHostname(url.hostname)) throw new Error(`${label} 主机名无效: ${url.hostname}`)
  return `https://${url.hostname}${port === 443 ? '' : `:${port}`}`
}

function unique(values, label) {
  if (values.some(value => !value) || new Set(values).size !== values.length) {
    throw new Error(`${label} 不能包含空项或重复项`)
  }
  return values
}

function isPrivateIpv4(value) {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) return false
  const [first, second] = parts.map(Number)
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function isAllowedHostname(value) {
  if (/^\d+(?:\.\d+){3}$/.test(value)) return isPrivateIpv4(value)
  return value.includes('.') && value.length <= 253
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}
