import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SecretStore } from '../types.js';

/**
 * File-backed secret store for OAuth state that can exceed the Windows
 * Credential Manager's per-entry size cap. Values are AES-256-GCM encrypted;
 * the keyring stores only the 32-byte file encryption key.
 */
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MASTER_KEY_NAME = 'oauth-file-master-key';

function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length <= IV_BYTES + 16) {
    throw new Error('encrypted secret is truncated');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = blob.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export interface FileSecretStoreOptions {
  rootDir: string;
  keyring: SecretStore;
  namespace?: string;
  masterKeyName?: string;
}

export class FileSecretStore implements SecretStore {
  private readonly dir: string;
  private readonly masterKey: string;
  private keyPromise: Promise<Buffer> | undefined;

  constructor(private readonly options: FileSecretStoreOptions) {
    const namespace = options.namespace
      ?? (options.keyring as { namespace?: string }).namespace
      ?? 'default';
    this.dir = path.join(options.rootDir, namespace);
    this.masterKey = options.masterKeyName ?? MASTER_KEY_NAME;
  }

  private entryPath(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.bin`);
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    const raw = await this.options.keyring.get(this.masterKey);
    if (!raw) {
      const key = randomBytes(KEY_BYTES);
      await this.options.keyring.set(this.masterKey, key.toString('base64'));
      return key;
    }

    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error('OAuth file-store master key must be 32 bytes');
    }
    return key;
  }

  private getKey(): Promise<Buffer> {
    this.keyPromise ??= this.loadOrCreateKey();
    return this.keyPromise;
  }

  async get(key: string): Promise<string | undefined> {
    const file = this.entryPath(key);
    try {
      const blob = await fs.readFile(file);
      return decrypt(blob, await this.getKey());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.entryPath(key);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, encrypt(value, await this.getKey()), { mode: 0o600 });
    await fs.rename(temp, file);
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.entryPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
