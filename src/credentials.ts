import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** DSH's credential service owns persistence. Never emulate it with a local key file. */
export interface Credentials {
  resolve(reference: string): Promise<{ value: string; source?: string } | undefined>;
  set(reference: string, value: string): Promise<void>;
  unset(reference: string): Promise<void>;
}
export type CredentialSecret = { apiKey: string; checked?: string };
export class CredentialFailure extends Error {}
export class EmbeddingCredentials {
  private readonly legacy: string;
  private readonly metadata: string;
  constructor(private root: string, private provider: () => Credentials | undefined) {
    this.legacy = join(root, 'embedding-secret.json');
    this.metadata = join(root, 'embedding-credential-state.json');
  }
  private host(): Credentials {
    let host: Credentials | undefined;
    try { host = this.provider(); } catch { /* No raw host error may escape. */ }
    if (!host?.resolve || !host.set || !host.unset) throw new CredentialFailure('DSH 凭据服务不可用，语义回想暂用本地检索');
    return host;
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (e) { if (e instanceof CredentialFailure) throw e; throw new CredentialFailure('DSH 凭据操作未完成，请稍后重试'); }
  }
  async read(reference: string, fingerprint: (key: string) => string): Promise<CredentialSecret | null> {
    return this.safe(async () => {
      const host = this.host();
      let saved = await host.resolve(reference);
      if (existsSync(this.legacy)) {
        const original = readFileSync(this.legacy, 'utf8');
        const legacy = JSON.parse(original) as CredentialSecret;
        if (typeof legacy.apiKey !== 'string' || !legacy.apiKey.trim() || /[\r\n]/.test(legacy.apiKey)) throw new CredentialFailure('旧密钥文件无法迁移，原文件已保留');
        if (saved?.value && saved.value !== legacy.apiKey) throw new CredentialFailure('DSH 凭据与旧密钥不一致，已保留两份数据并暂停语义服务，请先核对');
        if (saved?.source !== 'file') await host.set(reference, legacy.apiKey);
        saved = await host.resolve(reference);
        if (saved?.value !== legacy.apiKey) throw new CredentialFailure('凭据迁移读回校验失败，原密钥文件已保留');
        // Reuse only a capability check that really belongs to this config and key.
        this.markChecked(reference, legacy.checked === fingerprint(legacy.apiKey) ? legacy.checked : undefined);
        if (readFileSync(this.legacy, 'utf8') !== original) throw new CredentialFailure('旧密钥文件在迁移中发生变化，已保留原文件');
        unlinkSync(this.legacy);
      }
      if (!saved?.value) return null;
      let checked: string | undefined;
      try {
        const state = JSON.parse(readFileSync(this.metadata, 'utf8'));
        if (state.version === 1 && state.reference === reference && typeof state.checked === 'string') checked = state.checked;
      } catch { /* Missing or damaged metadata requires a fresh check. */ }
      return { apiKey: saved.value, checked };
    });
  }
  async save(reference: string, value: string): Promise<void> {
    await this.safe(async () => {
      const host = this.host();
      await host.set(reference, value);
      if ((await host.resolve(reference))?.value !== value) throw new CredentialFailure('凭据保存读回校验失败，请重试');
      this.markChecked(reference);
    });
  }
  discardLegacy(): void {
    try { if (existsSync(this.legacy)) unlinkSync(this.legacy); }
    catch { throw new CredentialFailure('新凭据已保存，但旧密钥文件尚未移除，请重试'); }
  }
  async clear(reference: string): Promise<void> {
    await this.safe(async () => {
      const host = this.host();
      const previous = await host.resolve(reference);
      await host.unset(reference);
      if ((await host.resolve(reference))?.value) {
        if (previous?.source === 'file') {
          await host.set(reference, previous.value);
          if ((await host.resolve(reference))?.value !== previous.value) throw new CredentialFailure('环境凭据发生冲突且恢复未完成，请在 DSH 中核对凭据');
        }
        throw new CredentialFailure('仍存在同名环境凭据，请在 DSH 中移除后重试');
      }
      this.markChecked(reference);
    });
  }
  markChecked(reference: string, checked?: string) {
    const temporary = this.metadata + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      // This file contains only a reference and SHA-256 check fingerprint, never the key.
      writeFileSync(temporary, JSON.stringify({ version: 1, reference, checked }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.metadata); chmodSync(this.metadata, 0o600);
    } catch { throw new CredentialFailure('凭据检查状态无法保存，请稍后重试'); }
    finally { try { unlinkSync(temporary); } catch {} }
  }
}
