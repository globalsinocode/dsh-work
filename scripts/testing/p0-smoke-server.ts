/**
 * P0 browser smoke server for `pnpm test:e2e`: in-memory data and test identities,
 * no PostgreSQL, AI Hub or DSH. Test-only; it is not part of a release and always
 * binds to 127.0.0.1.
 */
import { createServer } from 'node:http'

import { createSmokeRouter } from '../../server/src/testing/p0-smoke/smoke-router.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4290)
const router = createSmokeRouter()
const server = createServer((request, response) => void router.handle(request, response))
server.listen(port, '127.0.0.1', () => {
  console.log(`dsh-work P0 smoke server (test-only) listening on http://127.0.0.1:${port}`)
})
const shutdown = () => server.close(() => process.exit(0))
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
