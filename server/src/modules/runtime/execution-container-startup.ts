import { resolve } from 'node:path'
import { AttemptExecutionContainers, assertExclusiveToolScheduling, resolveExecutionContainerUser } from './attempt-execution-containers.ts'
import { DockerExecutionBackend } from './docker-execution-backend.ts'
import { DshAcpRuntimeAdapter } from './dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, withExecutionContainerOverlay, type DshRuntimeInstallation } from './dsh-runtime-installation.ts'

/**
 * Execution container startup check (execution isolation plan 4.9), shared by the server and the real-DSH
 * acceptance probes so both run DSH the same way: check the execution image's toolchain, add the execution
 * container overlay, re-run the DSH preflight with it, and require DSH to schedule bash and write tools
 * exclusively (plan 3.7). Throws on any failure; the caller decides whether that makes the Runtime
 * unavailable (server) or aborts (probe). Never falls back to running DSH on the host.
 */
export async function startExecutionContainers(
  base: DshRuntimeInstallation,
  options: { projectRoot: string; dataRoot: string; image: string | undefined },
): Promise<{ containers: AttemptExecutionContainers; installation: DshRuntimeInstallation }> {
  const containers = new AttemptExecutionContainers(new DockerExecutionBackend(), {
    image: options.image ?? '',
    user: resolveExecutionContainerUser(),
  })
  await containers.preflight()
  const installation = await withExecutionContainerOverlay(base, { projectRoot: options.projectRoot })
  await preflightDshRuntime(installation)
  const catalog = await new DshAcpRuntimeAdapter({
    runtimeId: 'execution-container-admission',
    runtimeRoot: resolve(options.dataRoot, 'dsh-attempts'),
    dshRepository: installation.home,
    process: installation.process,
  }).listTools()
  assertExclusiveToolScheduling(catalog)
  return { containers, installation }
}
