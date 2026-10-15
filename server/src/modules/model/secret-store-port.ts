import { stateConflict } from '../../domain/request-errors.ts'
export interface SecretStorePort {
  put(reference: string, secret: string): Promise<void>
  remove(reference: string): Promise<void>
  exists(reference: string): Promise<boolean>
}

/** DSH keeps the current API key. This adapter deliberately cannot read or overwrite it. */
export class DshManagedSecretStore implements SecretStorePort {
  async put(): Promise<void> {
    throw new Error('当前凭据由 DSH Credentials Provider 管理，请在 DSH 中更新')
  }

  async remove(): Promise<void> {
    throw new Error('当前凭据由 DSH Credentials Provider 管理，请在 DSH 中撤销')
  }

  async exists(reference: string): Promise<boolean> {
    return reference.trim().length > 0
  }
}

export class MemorySecretStore implements SecretStorePort {
  private readonly secrets = new Set<string>()

  async put(reference: string, secret: string) {
    if (!secret.trim()) throw stateConflict('密钥不能为空')
    this.secrets.add(reference)
  }

  async remove(reference: string) {
    this.secrets.delete(reference)
  }

  async exists(reference: string) {
    return this.secrets.has(reference)
  }
}
