import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from '../src/security/file-secrets.js';
import { MemorySecretStore } from '../src/security/secrets.js';

describe('FileSecretStore', () => {
  let dir: string;
  let keyring: MemorySecretStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-secrets-'));
    keyring = new MemorySecretStore();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips values larger than the Windows keyring 2560-char cap', async () => {
    const store = new FileSecretStore({ rootDir: dir, keyring, namespace: 'ns-large' });
    const huge = 'x'.repeat(20_000);
    await store.set('oauth-refresh-tokens', huge);
    expect(await store.get('oauth-refresh-tokens')).toBe(huge);
    // The encrypted file should not contain the plaintext in cleartext.
    const file = path.join(dir, 'ns-large', 'oauth-refresh-tokens.bin');
    const blob = await fs.readFile(file, 'utf8');
    expect(blob.includes('xxxxxxxxxxxx')).toBe(false);
    // The keyring should only store the small master key.
    const masterKey = await keyring.get('oauth-file-master-key');
    expect(masterKey).toBeTruthy();
    expect(Buffer.from(masterKey ?? '', 'base64').length).toBe(32);
  });

  it('persists across instances using the same keyring', async () => {
    const a = new FileSecretStore({ rootDir: dir, keyring, namespace: 'ns-persist' });
    await a.set('foo', 'bar');
    const b = new FileSecretStore({ rootDir: dir, keyring, namespace: 'ns-persist' });
    expect(await b.get('foo')).toBe('bar');
  });

  it('returns undefined for missing keys and idempotently deletes', async () => {
    const store = new FileSecretStore({ rootDir: dir, keyring, namespace: 'ns-missing' });
    expect(await store.get('absent')).toBeUndefined();
    await store.delete('absent');
    await store.set('present', 'value');
    expect(await store.get('present')).toBe('value');
    await store.delete('present');
    expect(await store.get('present')).toBeUndefined();
  });
});
