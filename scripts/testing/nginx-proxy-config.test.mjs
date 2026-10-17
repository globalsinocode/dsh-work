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

test('nginx JSON access log correlates the request and keeps query strings out', async () => {
  const template = await readFile(templateUrl, 'utf8')
  const format = template.match(/log_format\s+dsh_work_json\s+escape=json\s+([\s\S]*?);/)
  assert.ok(format, 'http-include scope must define log_format dsh_work_json escape=json')
  const body = format[1]
  for (const variable of jsonLogVariables) assert.ok(body.includes(variable), `JSON log must contain ${variable}`)
  assert.equal(body.includes('$request_uri'), false)
  assert.match(template, /access_log\s+\S+\s+dsh_work_json\s*;/)
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
