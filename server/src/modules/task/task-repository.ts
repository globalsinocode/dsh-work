import type { DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type {
  CreateTaskInput,
  RegisterTaskOperationInput,
  ResolveTaskOperationInput,
  TaskOperationRecord,
  TaskRecord,
} from './task-types.ts'

export interface TaskRepository {
  createTask(input: CreateTaskInput, tx?: DatabaseTransaction): Promise<TaskRecord>
  getTask(tenantId: string, taskId: string, tx?: DatabaseTransaction): Promise<TaskRecord | null>
  registerOperation(input: RegisterTaskOperationInput, tx?: DatabaseTransaction): Promise<TaskOperationRecord>
  acceptOperation(input: RegisterTaskOperationInput, tx?: DatabaseTransaction): Promise<{ operation: TaskOperationRecord; created: boolean }>
  getOperation(tenantId: string, operationId: string): Promise<TaskOperationRecord | null>
  listOperations(tenantId: string, taskId: string): Promise<TaskOperationRecord[]>
  resolveOperation(input: ResolveTaskOperationInput): Promise<TaskOperationRecord>
}
