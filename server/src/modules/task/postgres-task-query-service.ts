import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { RunRepository } from '../run/run-repository.ts'
import type { TaskRepository } from './task-repository.ts'

const tenantId = 'tenant-dsh-work'

/** Read model for PF-01 API/event Tasks. It exposes persisted evidence only. */
export class PostgresTaskQueryService {
  private readonly database: DatabaseClient
  private readonly tasks: TaskRepository
  private readonly runs: RunRepository

  constructor(
    database: DatabaseClient,
    tasks: TaskRepository,
    runs: RunRepository,
  ) {
    this.database = database
    this.tasks = tasks
    this.runs = runs
  }

  async get(taskId: string) {
    const task = await this.tasks.getTask(tenantId, taskId)
    if (!task) return null
    const run = await this.runs.getRunForTask(tenantId, taskId)
    const operations = await this.tasks.listOperations(tenantId, taskId)
    const events = run ? await this.runs.readEvents(tenantId, run.id) : []
    const artifacts = await this.database<{
      id: string
      versionId: string
      name: string
      artifactType: string
      version: number
      sizeBytes: number
      createdAt: Date
    }[]>`
      select a.id, av.id as "versionId", a.name, a.artifact_type as "artifactType",
             av.version_no as version, f.size_bytes as "sizeBytes", av.created_at as "createdAt"
        from artifacts a
        join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
       where a.tenant_id = ${tenantId} and a.task_id = ${taskId}
       order by av.created_at asc, av.id asc
    `
    const answer = [...events].reverse().find(event => event.eventType === 'assistant.completed')?.displayMessage ?? null
    return {
      task,
      run,
      result: {
        answer,
        artifacts: artifacts.map(item => ({ ...item, createdAt: item.createdAt.toISOString() })),
        operations,
      },
      events,
    }
  }
}
