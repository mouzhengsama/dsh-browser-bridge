import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Entry } from '@napi-rs/keyring';
import type { SecretStore } from '../types.js';

const SERVICE_NAME = 'dsh-browser-bridge';

export function workspaceSecretNamespace(workspaceRoot: string): string {
  return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 20);
}

export class KeyringSecretStore implements SecretStore {
  readonly namespace: string;

  constructor(workspaceRoot: string) {
    this.namespace = workspaceSecretNamespace(workspaceRoot);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return new Entry(SERVICE_NAME, `${this.namespace}:${key}`).getPassword() ?? undefined;
    } catch (error) {
      if (/NoEntry|not found|does not exist/i.test(String(error))) {
        return undefined;
      }
      throw new Error(`Unable to read secret "${key}" from the OS keyring: ${String(error)}`);
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      new Entry(SERVICE_NAME, `${this.namespace}:${key}`).setPassword(value);
    } catch (error) {
      throw new Error(`Unable to store secret "${key}" in the OS keyring: ${String(error)}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      new Entry(SERVICE_NAME, `${this.namespace}:${key}`).deletePassword();
    } catch (error) {
      if (!/NoEntry|not found|does not exist/i.test(String(error))) {
        throw new Error(`Unable to delete secret "${key}" from the OS keyring: ${String(error)}`);
      }
    }
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function ensureSecret(
  store: SecretStore,
  key: string,
  bytes = 32,
): Promise<string> {
  const existing = await store.get(key);
  if (existing) {
    return existing;
  }
  const value = generateSecret(bytes);
  await store.set(key, value);
  return value;
}
