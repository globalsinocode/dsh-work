import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'

import { createPlatformToolBridge } from './platform-tool-bridge.ts'
import { compileToolContract, toolPreconditionFailed, type PlatformToolContract } from './platform-tool-contract.ts'
import { platformToolContracts } from './platform-tool-contracts.ts'

const baseContract: PlatformToolContract = {
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { value: { type: 'string', minLength: 1 } }, required: ['value'],
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    properties: { result: { type: 'string' } }, required: ['result'],
  },
  effect: 'read', retryPolicy: 'safe', concurrencyPolicy: 'concurrent',
  completionSemantics: 'completed', timeoutMs: 1000, maxOutputBytes: 1024,
}

test('all governed platform tool contracts compile in strict JSON Schema mode', () => {
  for (const contract of Object.values(platformToolContracts)) assert.doesNotThrow(() => compileToolContract(contract))
})

test('python output budget accepts the runner maximum after JSON serialization', () => {
  const result = {
    exitCode: 0,
    stdout: '\u0000'.repeat(1_048_576),
    stderr: '\u0000'.repeat(1_048_576),
    artifacts: Array.from({ length: 20 }, (_, index) => ({ name: `${index}-${'x'.repeat(497)}`, size: 10 * 1024 * 1024 })),
  }
  const validators = compileToolContract(platformToolContracts.python_execute)
  assert.equal(validators.output(result), true)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= platformToolContracts.python_execute.maxOutputBytes)
})

test('authorization probe distinguishes revocation from an unavailable authorization service', async () => {
  let authorization: 'revoked' | 'unavailable' | 'allowed' = 'revoked'
  const bridge = await createPlatformToolBridge({}, 1, async () => {
    if (authorization === 'revoked') throw Object.assign(new Error('revoked'), { code: 'permission_denied' })
    if (authorization === 'unavailable') throw new Error('authorization database unavailable')
  })
  try {
    assert.deepEqual(await probeAuthorization(bridge.socket), {
      status: 403, body: { error: '当前执行授权已撤销' },
    })
    authorization = 'unavailable'
    assert.deepEqual(await probeAuthorization(bridge.socket), {
      status: 503, body: { error: '当前执行授权检查暂不可用' },
    })
    authorization = 'allowed'
    assert.deepEqual(await probeAuthorization(bridge.socket), {
      status: 200, body: { authorized: true },
    })
  } finally { await bridge.close() }
})

test('platform bridge validates input and output with stable error envelopes', async () => {
  let calls = 0
  const bridge = await createPlatformToolBridge({ sample: {
    contract: baseContract,
    handler: async input => { calls++; return input['value'] === 'bad-output' ? { unexpected: true } : { result: input['value'] } },
  } }, 3)
  try {
    assert.deepEqual(await call(bridge.socket, 'sample', { value: 'ok' }), { status: 200, body: { result: 'ok' } })
    const invalidInput = await call(bridge.socket, 'sample', { value: '' })
    assert.equal(invalidInput.status, 422)
    const inputError = requireError(invalidInput.body)
    assert.equal(inputError.code, 'TOOL_INPUT_INVALID')
    assert.match(inputError.message, /工具参数不符合契约/)
    assert.equal(inputError.retryable, false)
    assert.equal(inputError.effect_state, 'not_started')
    assert.equal(calls, 1, '输入无效时不能进入处理器')
    const invalidOutput = await call(bridge.socket, 'sample', { value: 'bad-output' })
    assert.equal(invalidOutput.status, 502)
    assert.equal(requireError(invalidOutput.body).code, 'TOOL_OUTPUT_INVALID')
    const overLimit = await call(bridge.socket, 'sample', { value: 'over-limit' })
    assert.equal(overLimit.status, 429)
    assert.equal(requireError(overLimit.body).code, 'TOOL_CALL_LIMIT_EXCEEDED')
    assert.equal(calls, 2, '超过调用上限时不能进入处理器')
  } finally { await bridge.close() }
})

test('platform bridge distinguishes authorization, safe read timeout and unknown write result', async () => {
  const waitForever = async (_input: Record<string, unknown>, signal: AbortSignal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    return { result: 'never' }
  }
  let authorization: 'revoked' | 'unavailable' | 'allowed' = 'revoked'
  const bridge = await createPlatformToolBridge({
    read: { contract: { ...baseContract, timeoutMs: 10 }, handler: waitForever },
    write: { contract: { ...baseContract, effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 10 }, handler: waitForever },
  }, 4, async () => {
    if (authorization === 'revoked') throw Object.assign(new Error('revoked'), { code: 'permission_denied' })
    if (authorization === 'unavailable') throw new Error('authorization database unavailable')
  })
  try {
    const denied = await call(bridge.socket, 'read', { value: 'x' })
    assert.equal(denied.status, 403)
    assert.equal(requireError(denied.body).code, 'TOOL_PERMISSION_DENIED')
    authorization = 'unavailable'
    const unavailable = await call(bridge.socket, 'read', { value: 'x' })
    assert.deepEqual(requireError(unavailable.body), {
      code: 'TOOL_AUTHORIZATION_UNAVAILABLE', message: '当前工具授权检查暂不可用，工具未执行',
      retryable: true, effect_state: 'not_started',
    })
    authorization = 'allowed'
    const readTimeout = await call(bridge.socket, 'read', { value: 'x' })
    assert.deepEqual(requireError(readTimeout.body), {
      code: 'TOOL_TIMEOUT', message: '工具调用超时', retryable: true, effect_state: 'not_started',
    })
    const writeTimeout = await call(bridge.socket, 'write', { value: 'x' })
    const writeError = requireError(writeTimeout.body)
    assert.equal(writeError.code, 'TOOL_RESULT_UNKNOWN')
    assert.equal(writeError.retryable, false)
    assert.equal(writeError.effect_state, 'unknown')
  } finally { await bridge.close() }
})

test('write completion stays unknown when the post-effect authorization check is unavailable', async () => {
  let checks = 0
  let calls = 0
  const bridge = await createPlatformToolBridge({ write: {
    contract: { ...baseContract, effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized' },
    handler: async input => { calls++; return { result: input['value'] } },
  } }, 1, async () => {
    checks++
    if (checks === 2) throw new Error('authorization database unavailable')
  })
  try {
    const response = await call(bridge.socket, 'write', { value: 'x' })
    assert.equal(response.status, 503)
    assert.deepEqual(requireError(response.body), {
      code: 'TOOL_AUTHORIZATION_UNAVAILABLE',
      message: '工具执行后授权复核暂不可用，写入效果可能已发生；核对实际效果后再决定后续操作',
      retryable: false,
      effect_state: 'unknown',
    })
    assert.equal(calls, 1)
  } finally { await bridge.close() }
})

test('platform bridge rejects overlapping serialized calls before the second effect starts', async () => {
  let release!: () => void
  let calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const bridge = await createPlatformToolBridge({ write: {
    contract: { ...baseContract, effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized' },
    handler: async input => { calls++; await gate; return { result: input['value'] } },
  } }, 2)
  try {
    const first = call(bridge.socket, 'write', { value: 'first' })
    await waitFor(() => calls === 1)
    const conflicting = await call(bridge.socket, 'write', { value: 'second' })
    assert.equal(conflicting.status, 409)
    assert.deepEqual(requireError(conflicting.body), {
      code: 'TOOL_CONFLICT', message: '该工具已有调用正在执行，请等待结果后再调用', retryable: false, effect_state: 'not_started',
    })
    assert.equal(calls, 1)
    release()
    assert.deepEqual(await first, { status: 200, body: { result: 'first' } })
  } finally {
    release()
    await bridge.close()
  }
})

test('platform bridge preserves governed conflict and unavailable failures', async () => {
  const bridge = await createPlatformToolBridge({
    conflict: {
      contract: { ...baseContract, effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized' },
      handler: async () => { throw Object.assign(new Error('版本已变化'), { status: 409, code: 'VERSION_CONFLICT' }) },
    },
    unavailable: {
      contract: baseContract,
      handler: async () => { throw Object.assign(new Error('依赖暂不可用'), { status: 503, code: 'DEPENDENCY_UNAVAILABLE' }) },
    },
  }, 2)
  try {
    const conflict = requireError((await call(bridge.socket, 'conflict', { value: 'x' })).body)
    assert.equal(conflict.code, 'VERSION_CONFLICT')
    assert.equal(conflict.effect_state, 'unknown')
    assert.equal(conflict.retryable, false)
    const unavailable = requireError((await call(bridge.socket, 'unavailable', { value: 'x' })).body)
    assert.equal(unavailable.code, 'DEPENDENCY_UNAVAILABLE')
    assert.equal(unavailable.effect_state, 'not_started')
    assert.equal(unavailable.retryable, true)
  } finally { await bridge.close() }
})

test('platform bridge marks write failures after handler start as an unknown effect', async () => {
  let checks = 0
  const writeContract = { ...baseContract, effect: 'write' as const, retryPolicy: 'never' as const, concurrencyPolicy: 'serialized' as const }
  const bridge = await createPlatformToolBridge({
    invalid_output: { contract: writeContract, handler: async () => ({ unexpected: true }) },
    failed: { contract: writeContract, handler: async () => { throw new Error('after write') } },
    revoked_after: { contract: writeContract, handler: async input => ({ result: input['value'] }) },
  }, 3, async () => {
    checks++
    if (checks === 5) throw Object.assign(new Error('revoked after execution'), { code: 'permission_denied' })
  })
  try {
    const invalid = requireError((await call(bridge.socket, 'invalid_output', { value: 'x' })).body)
    assert.equal(invalid.code, 'TOOL_OUTPUT_INVALID')
    assert.equal(invalid.effect_state, 'unknown')
    const failed = requireError((await call(bridge.socket, 'failed', { value: 'x' })).body)
    assert.equal(failed.code, 'TOOL_RESULT_UNKNOWN')
    assert.equal(failed.effect_state, 'unknown')
    const revoked = requireError((await call(bridge.socket, 'revoked_after', { value: 'x' })).body)
    assert.equal(revoked.code, 'TOOL_PERMISSION_DENIED')
    assert.equal(revoked.effect_state, 'unknown')
  } finally { await bridge.close() }
})

test('platform bridge preserves caller-correctable write preconditions', async () => {
  const bridge = await createPlatformToolBridge({ write: {
    contract: { ...baseContract, effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized' },
    handler: async () => { throw toolPreconditionFailed('执行 Python 前必须先激活对应 Skill') },
  } }, 1)
  try {
    const response = await call(bridge.socket, 'write', { value: 'x' })
    assert.equal(response.status, 422)
    assert.deepEqual(requireError(response.body), {
      code: 'TOOL_PRECONDITION_FAILED',
      message: '执行 Python 前必须先激活对应 Skill',
      retryable: false,
      effect_state: 'not_started',
    })
  } finally { await bridge.close() }
})

test('serialized lock remains held after timeout until the underlying write handler settles', async () => {
  let release!: () => void
  let calls = 0
  let firstSettled = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const bridge = await createPlatformToolBridge({ write: {
    contract: { ...baseContract, effect: 'write', retryPolicy: 'never', concurrencyPolicy: 'serialized', timeoutMs: 10 },
    handler: async input => {
      calls++
      if (calls === 1) {
        await gate // Deliberately ignores AbortSignal to exercise fail-closed locking.
        firstSettled = true
      }
      return { result: input['value'] }
    },
  } }, 3)
  try {
    const timedOut = requireError((await call(bridge.socket, 'write', { value: 'first' })).body)
    assert.equal(timedOut.code, 'TOOL_RESULT_UNKNOWN')
    const conflicting = requireError((await call(bridge.socket, 'write', { value: 'second' })).body)
    assert.equal(conflicting.code, 'TOOL_CONFLICT')
    assert.equal(calls, 1)
    release()
    await waitFor(() => firstSettled)
    assert.deepEqual(await call(bridge.socket, 'write', { value: 'third' }), {
      status: 200, body: { result: 'third' },
    })
  } finally {
    release()
    await bridge.close()
  }
})

test('PF-01 write operations persist completion and replay the receipt without a second side effect', async () => {
  let calls = 0
  let stored: import('./platform-tool-bridge.ts').PlatformToolOperationRecord | undefined
  const bridge = await createPlatformToolBridge({ write: {
    contract: { ...baseContract, effect: 'write', retryPolicy: 'verify-first' },
    async handler(input) { calls += 1; return { result: input['value'] } },
  } }, 3, undefined, {
    async begin() {
      if (stored) return { ...stored, execute: false }
      stored = { id: 'operation-1', status: 'accepted', receipt: {}, errorCode: null, execute: true }
      return stored
    },
    async resolve(input) {
      stored = { id: input.operationId, status: input.status, receipt: input.receipt, errorCode: input.errorCode ?? null, execute: false }
    },
  })
  try {
    assert.deepEqual(await call(bridge.socket, 'write', { value: 'once' }, 'call-1'), {
      status: 200, body: { result: 'once' },
    })
    assert.deepEqual(await call(bridge.socket, 'write', { value: 'once' }, 'call-2'), {
      status: 200, body: { result: 'once' },
    })
    assert.equal(calls, 1)
    assert.equal(stored?.status, 'completed')
  } finally {
    await bridge.close()
  }
})

test('PF-01 asynchronous writes remain accepted after acknowledgement and cannot execute twice', async () => {
  let calls = 0
  let stored: import('./platform-tool-bridge.ts').PlatformToolOperationRecord | undefined
  const bridge = await createPlatformToolBridge({ write: {
    contract: { ...baseContract, effect: 'write', retryPolicy: 'verify-first', completionSemantics: 'accepted' },
    async handler(input) { calls += 1; return { result: input['value'] } },
  } }, 2, undefined, {
    async begin() {
      if (stored) return { ...stored, execute: false }
      stored = { id: 'operation-async', status: 'accepted', receipt: {}, errorCode: null, execute: true }
      return stored
    },
    async resolve(input) {
      stored = { id: input.operationId, status: input.status, receipt: input.receipt, errorCode: input.errorCode ?? null, execute: false }
    },
  })
  try {
    assert.deepEqual(await call(bridge.socket, 'write', { value: 'queued' }, 'call-1'), {
      status: 200, body: { result: 'queued' },
    })
    assert.equal(stored?.status, 'accepted')
    assert.deepEqual(stored?.receipt, { result: { result: 'queued' } })
    const repeated = await call(bridge.socket, 'write', { value: 'queued' }, 'call-2')
    assert.equal(repeated.status, 409)
    assert.equal(requireError(repeated.body).code, 'TOOL_OPERATION_IN_PROGRESS')
    assert.equal(calls, 1)
    assert.equal(stored?.status, 'accepted', 'duplicate delivery must not corrupt the pending operation')
  } finally {
    await bridge.close()
  }
})

interface ToolHttpBody {
  result?: string
  error?: { code: string; message: string; retryable: boolean; effect_state: string }
}

function requireError(body: ToolHttpBody): NonNullable<ToolHttpBody['error']> {
  assert.ok(body.error)
  return body.error
}

function call(socketPath: string, tool: string, input: unknown, callId?: string): Promise<{ status: number; body: ToolHttpBody }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input)
    const req = request({ socketPath, path: `/tools/${tool}`, method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      ...(callId ? { 'X-DSH-Tool-Call-ID': callId } : {}),
    } }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as ToolHttpBody }))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

function probeAuthorization(socketPath: string): Promise<{
  status: number
  body: { authorized?: boolean; error?: string }
}> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/authorize-execution', method: 'POST' }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(text) as { authorized?: boolean; error?: string },
      }))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}
