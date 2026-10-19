import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function createContext(root) {
  const failures = new Set()
  const cache = new Map()
  const check = {
    root,
    failures,
    assert(condition, message) {
      if (!condition) failures.add(message)
    },
    files(paths) {
      for (const path of paths) check.assert(existsSync(resolve(root, path)), `${path} 文件不存在`)
    },
    read(path) {
      if (!cache.has(path)) {
        try {
          cache.set(path, readFileSync(resolve(root, path), 'utf8'))
        } catch {
          failures.add(`${path} 无法读取`)
          cache.set(path, '')
        }
      }
      return cache.get(path)
    },
    json(path) {
      try {
        return JSON.parse(check.read(path))
      } catch {
        failures.add(`${path} 不是有效 JSON`)
        return null
      }
    },
    includes(path, values) {
      const source = check.read(path)
      for (const value of values) check.assert(source.includes(value), `${path} 缺少 ${value}`)
    },
    excludes(path, values) {
      const source = check.read(path)
      for (const value of values) check.assert(!source.includes(value), `${path} 不应包含 ${value}`)
    },
  }
  return check
}

export function pnpmCommands(source) {
  return [...source.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)].map(match => match[1])
}

export function workflowCommands(source) {
  const commands = []
  let blockIndent
  for (const line of source.split(/\r?\n/)) {
    const run = line.match(/^(\s*)run:\s*(.*)$/)
    if (run) {
      blockIndent = /^[|>][-+]?\s*$/.test(run[2]) ? run[1].length : undefined
      if (blockIndent === undefined) commands.push(...pnpmCommands(run[2]))
    } else if (blockIndent !== undefined && line.trim()) {
      if (line.search(/\S/) <= blockIndent) blockIndent = undefined
      else if (!line.trimStart().startsWith('#')) commands.push(...pnpmCommands(line))
    }
  }
  return commands
}
