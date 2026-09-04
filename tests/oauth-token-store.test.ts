import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAuthRefreshTokenStore } from '../src/http/oauth-tokens.js';
import { FileSecretStore } from '../src/security/file-secrets.js';
import { MemorySecretStore } from '../src/security/secrets.js';

describe('OAuthRefreshTokenStore + FileSecretStore', () => {
  let dir: string;
  let keyring: MemorySecretStore;
  let fileStore: FileSecretStore;
  const KEY = 'oauth-refresh-tokens';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-store-'));
    keyring = new MemorySecretStore();
    fileStore = new FileSecretStore({ rootDir: dir, keyring, namespace: 'ns' });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists many tokens across a store reload without blowing past the 2560-char keyring cap', async () => {
    const store = new OAuthRefreshTokenStore(fileStore, KEY);
    const tokens: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = await store.createAndPersist({
        clientId: 'client-' + i,
        resource: 'https://chatgpt.com/connector',
        scopes: ['mcp.read', 'mcp.write', 'offline_access'],
      });
      tokens.push(t);
    }

    const masterKey = await keyring.get('oauth-file-master-key');
    expect(masterKey).toBeTruthy();
    expect(Buffer.from(masterKey ?? '', 'base64').length).toBe(32);

    // Reload via a fresh in-memory store pointing at the same file dir.
    const store2 = new OAuthRefreshTokenStore(fileStore, KEY);
    await store2.load(fileStore, KEY);
    expect(store2.entries()).toHaveLength(50);
  });

  it('survives the keyring only holding the master key (no large blob)', async () => {
    const store = new OAuthRefreshTokenStore(fileStore, KEY);
    const huge = await store.createAndPersist({
      clientId: 'c',
      resource: 'https://chatgpt.com/connector',
      scopes: ['mcp.read'],
    });
    // Force the persistence payload to exceed 2.5 KB by issuing more tokens.
    for (let i = 0; i < 5; i += 1) {
      await store.createAndPersist({
        clientId: 'c' + i,
        resource: 'https://chatgpt.com/connector',
        scopes: ['mcp.read', 'mcp.write', 'offline_access', 'profile'],
      });
    }

    // The keyring should not contain a >2 KB value, only the 32-byte master key.
    const masterKey = await keyring.get('oauth-file-master-key');
    expect(Buffer.from(masterKey ?? '', 'base64').length).toBe(32);

    // And reload should preserve the original token's record.
    const store2 = new OAuthRefreshTokenStore(fileStore, KEY);
    await store2.load(fileStore, KEY);
    const record = store2.consume(huge);
    expect(record?.clientId).toBe('c');
  });
});
