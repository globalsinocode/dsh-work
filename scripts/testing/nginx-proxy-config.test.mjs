import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const templateUrl = new URL('../../deploy/nginx/default.conf.template', import.meta.url)
const proxyParamsUrl = new URL('../../deploy/nginx/proxy_params', import.meta.url)

const jsonLogVariables = [
  '$time_iso8601',
  '$request_id',
  '$request_method',
  '$uri',
  '$status',
  '$request_time',
  '$upstream_connect_time',
  '$upstream_header_time',
  '$upstream_response_time',
  '$upstream_addr',
]

const queryLeak = /\$request_uri|\$args|\$query_string|\$request(?![A-Za-z0-9_])/

function serverBlocks(template) {
  const blocks = []
  for (const match of template.matchAll(/^server\s*\{/gm)) {
    let depth = 0
    for (let index = match.index + match[0].length - 1; index < template.length; index += 1) {
      if (template[index] === '{') depth += 1
      else if (template[index] === '}') {
        depth -= 1
        if (depth === 0) {
          blocks.push(template.slice(match.index, index + 1))
          break
        }
      }
    }
  }
  return blocks
}

test('nginx JSON access log correlates the request and keeps query strings out', async () => {
  const template = await readFile(templateUrl, 'utf8')
  const format = template.match(/log_format\s+dsh_work_json\s+escape=json\s+([\s\S]*?);/)
  assert.ok(format, 'http-include scope must define log_format dsh_work_json escape=json')
  const body = format[1]
  for (const variable of jsonLogVariables) assert.ok(body.includes(variable), `JSON log must contain ${variable}`)
  assert.equal(queryLeak.test(body), false)
  const blocks = serverBlocks(template)
  assert.equal(blocks.length, 3)
  for (const block of blocks) {
    const logs = block.match(/access_log[^;]*;/g) ?? []
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^access_log\s+\/var\/log\/nginx\/access\.log\s+dsh_work_json\s*;$/)
    assert.equal(queryLeak.test(logs[0]), false)
  }
  let outside = template
  for (const block of blocks) outside = outside.replace(block, '')
  assert.equal(/\baccess_log\b/.test(outside), false)
})

test('proxy forwards the nginx request id and fails fast on connect while long responses stay open', async () => {
  const [template, proxyParams] = await Promise.all([
    readFile(templateUrl, 'utf8'),
    readFile(proxyParamsUrl, 'utf8'),
  ])
  assert.match(proxyParams, /^proxy_set_header\s+X-Request-Id\s+\$request_id\s*;/m)
  assert.equal(proxyParams.includes('$http_x_request_id'), false)
  assert.match(proxyParams, /^proxy_connect_timeout\s+5s\s*;/m)
  assert.match(template, /proxy_read_timeout\s+3600s\s*;/)
  assert.equal(template.match(/proxy_read_timeout\s+3600s\s*;/g)?.length, 2)
})
