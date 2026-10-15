import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Router } from './router.ts'

// Every route main.ts registers must be documented in the OpenAPI files, and every documented
// operation must exist. Paths are compared with parameter names erased (`:id` ≡ `{agentId}`).
// Health probes (/health*) are operational endpoints outside the API documents.

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
type ApiDocument = 'admin' | 'workbench' | 'auth' | 'mobile-h5'
const methods = ['get', 'post', 'put', 'patch', 'delete']

/** Callable, chainable stand-in for every service: registration only stores handlers. */
const stub: unknown = new Proxy(function () {}, {
  get: (_target, property) => (property === 'then' ? undefined : stub),
  apply: () => stub,
})

async function applicationRoutes() {
  const router = new Router()
  const registrations = [...mainSource.matchAll(/import \{([^}]*)\} from '\.\/http\/([^']+)'/g)]
  for (const [, names, file] of registrations) {
    const module = await import(new URL(`./${file}`, import.meta.url).href) as Record<string, (...args: unknown[]) => void>
    for (const name of names!.split(',').map(item => item.trim()).filter(item => /^register\w+Routes$/.test(item))) {
      module[name]!(router, ...Array.from({ length: 12 }, () => stub))
    }
  }
  return router.listRoutes()
}

const normalize = (path: string) => path.replace(/:[A-Za-z_]\w*/g, '{}').replace(/\{[^}]+\}/g, '{}')

function documented(name: ApiDocument) {
  const api = JSON.parse(readFileSync(new URL(`../../../docs/development/openapi-${name}.json`, import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>
  }
  return new Set(Object.entries(api.paths).flatMap(([path, item]) =>
    Object.keys(item).filter(key => methods.includes(key)).map(method => `${method.toUpperCase()} ${normalize(path)}`)))
}

function classify(routes: Array<{ method: string; path: string }>) {
  const code = { admin: new Set<string>(), workbench: new Set<string>(), auth: new Set<string>(), other: new Set<string>() }
  for (const { method, path } of routes) {
    if (path.startsWith('/api/admin/v1/')) code.admin.add(`${method} ${normalize(path.slice('/api/admin/v1'.length))}`)
    else if (path.startsWith('/api/workbench/v1/')) code.workbench.add(`${method} ${normalize(path.slice('/api/workbench/v1'.length))}`)
    else if (path.startsWith('/auth/')) code.auth.add(`${method} ${normalize(path)}`)
    else code.other.add(`${method} ${path}`)
  }
  return code
}

test('main.ts registers routes only through register*Routes functions, apart from health probes', () => {
  const inline = [...mainSource.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*['`]([^'`]+)/g)].map(match => match[1]!)
  assert.ok(inline.length > 0)
  assert.deepEqual(inline.filter(path => !path.startsWith('/health')), [])
})

test('every registered API route is documented in OpenAPI and every documented operation exists', async () => {
  const routes = await applicationRoutes()
  assert.ok(routes.length > 200, `only ${routes.length} routes registered; route discovery is broken`)
  const code = classify(routes)
  assert.deepEqual([...code.other], [], 'routes outside /api/{admin,workbench}/v1 and /auth')

  for (const audience of ['admin', 'workbench'] as const) {
    const docs = documented(audience)
    assert.deepEqual([...code[audience]].filter(route => !docs.has(route)), [], `routes missing from openapi-${audience}.json`)
    assert.deepEqual([...docs].filter(route => !code[audience].has(route)), [], `operations in openapi-${audience}.json without a route`)
  }
  // Auth routes are registered per portal; the document uses an {audience} parameter.
  const auth = documented('auth')
  const portal = (route: string) => route.replace(/^(\w+) \/auth\/(?:workbench|admin)\//, '$1 /auth/{}/')
  assert.deepEqual([...code.auth].filter(route => !auth.has(route) && !auth.has(portal(route))), [], 'routes missing from openapi-auth.json')
  const authRoutes = new Set([...code.auth].flatMap(route => [route, portal(route)]))
  assert.deepEqual([...auth].filter(route => !authRoutes.has(route)), [], 'operations in openapi-auth.json without a route')
  // The mobile H5 document is a subset of the workbench API.
  assert.deepEqual([...documented('mobile-h5')].filter(route => !code.workbench.has(route)), [], 'operations in openapi-mobile-h5.json without a route')
})
