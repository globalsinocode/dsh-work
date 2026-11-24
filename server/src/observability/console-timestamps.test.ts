import assert from 'node:assert/strict'
import test from 'node:test'

import { installTimestampedConsole } from './console-timestamps.ts'

test('文本日志单行化，只有带有效 at 的单参数 JSON 对象保持原样，重复安装幂等', () => {
  const calls: unknown[][] = []
  const target = {
    log: (...args: unknown[]) => calls.push(args),
    info: (...args: unknown[]) => calls.push(args),
    warn: (...args: unknown[]) => calls.push(args),
    error: (...args: unknown[]) => calls.push(args),
  }
  installTimestampedConsole(target, () => new Date('2026-11-24T02:00:00.000Z'))
  target.log('hello', 1)
  target.error('failed', new Error('line 1\nline 2'))
  target.warn('  {"event":"x","at":"2026-11-24T02:00:00.000Z"}  ')
  target.info('{"event":"missing-at"}')
  target.info('[1,2,3]')
  target.warn('{not-json}')
  installTimestampedConsole(target, () => new Date('2026-11-24T03:00:00.000Z'))
  target.error('again')
  assert.deepEqual(calls[0], ['2026-11-24T02:00:00.000Z [log] hello 1'])
  assert.match(String(calls[1]?.[0]), /^2026-11-24T02:00:00.000Z \[error\] failed Error: line 1\\nline 2/)
  assert.deepEqual(calls[2], ['  {"event":"x","at":"2026-11-24T02:00:00.000Z"}  '])
  assert.deepEqual(calls[3], ['2026-11-24T02:00:00.000Z [info] {"event":"missing-at"}'])
  assert.deepEqual(calls[4], ['2026-11-24T02:00:00.000Z [info] [1,2,3]'])
  assert.deepEqual(calls[5], ['2026-11-24T02:00:00.000Z [warn] {not-json}'])
  assert.deepEqual(calls[6], ['2026-11-24T02:00:00.000Z [error] again'])
})
