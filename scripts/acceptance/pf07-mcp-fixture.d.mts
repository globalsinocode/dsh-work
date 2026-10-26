export interface Pf07McpReceipt {
  id: string
  operationKey: string
  value: string
  status: 'completed'
  createdAt: string
}

export interface Pf07McpFixture {
  url: string
  getReceipt(operationKey: string): Pf07McpReceipt | null
  setCatalogVersion(version: 1 | 2): void
  close(): Promise<void>
}

export function startPf07McpFixture(options: {
  token: string
  port?: number
  receiptPath?: string
  catalogVersion?: 1 | 2
}): Promise<Pf07McpFixture>
