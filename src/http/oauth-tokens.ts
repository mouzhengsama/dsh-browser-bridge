import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SecretStoreLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthAccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
}

export interface OAuthRefreshTokenRecord {
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signature(signingKey: string, encodedHeader: string, encodedPayload: string): string {
  return createHmac('sha256', signingKey).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createAccessToken(options: {
  signingKey: string;
  issuer: string;
  audience: string;
  subject: string;
  scopes: string[];
  lifetimeSeconds?: number;
  now?: number;
}): string {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: OAuthAccessTokenClaims = {
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    scope: options.scopes,
    iat: now,
    exp: now + (options.lifetimeSeconds ?? 900),
    jti: randomBytes(16).toString('hex'),
  };
  const encodedHeader = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = base64Url(JSON.stringify(claims));
  return `${encodedHeader}.${encodedPayload}.${signature(options.signingKey, encodedHeader, encodedPayload)}`;
}

export function verifyAccessToken(
  signingKey: string,
  token: string,
  expectedIssuer: string,
  expectedAudience: string,
  now = Math.floor(Date.now() / 1000),
): OAuthAccessTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  if (!encodedHeader || !encodedPayload || !encodedSignature) return undefined;
  if (!safeEqual(encodedSignature, signature(signingKey, encodedHeader, encodedPayload))) {
    return undefined;
  }

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !header
    || typeof header !== 'object'
    || (header as { alg?: unknown }).alg !== 'HS256'
    || !claims
    || typeof claims !== 'object'
  ) {
    return undefined;
  }
  const record = claims as Partial<OAuthAccessTokenClaims>;
  if (
    record.iss !== expectedIssuer
    || record.aud !== expectedAudience
    || typeof record.sub !== 'string'
    || !Array.isArray(record.scope)
    || !record.scope.every((scope) => typeof scope === 'string')
    || typeof record.iat !== 'number'
    || typeof record.exp !== 'number'
    || typeof record.jti !== 'string'
    || record.iat > now
    || record.exp <= now
  ) {
    return undefined;
  }
  return record as OAuthAccessTokenClaims;
}

function digestToken(value: string): string {
  return createHmac('sha256', value).digest('base64url');
}

export class OAuthRefreshTokenStore {
  private readonly records = new Map<string, OAuthRefreshTokenRecord & { tokenHash: string }>();

  static readonly DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly secretStore?: SecretStoreLike,
    private readonly secretKey?: string,
  ) {}

  create(record: Omit<OAuthRefreshTokenRecord, 'expiresAt'>, lifetimeMs = OAuthRefreshTokenStore.DEFAULT_TTL_MS): string {
    const token = `dsh_bridge_refresh_${randomBytes(32).toString('base64url')}`;
    const stored: OAuthRefreshTokenRecord & { tokenHash: string } = {
      ...record,
      expiresAt: Date.now() + lifetimeMs,
      tokenHash: digestToken(token),
    };
    this.records.set(stored.tokenHash, stored);
    return token;
  }

  createWithToken(
    token: string,
    record: Omit<OAuthRefreshTokenRecord, 'expiresAt'>,
    lifetimeMs = OAuthRefreshTokenStore.DEFAULT_TTL_MS,
  ): void {
    const stored: OAuthRefreshTokenRecord & { tokenHash: string } = {
      ...record,
      expiresAt: Date.now() + lifetimeMs,
      tokenHash: digestToken(token),
    };
    this.records.set(stored.tokenHash, stored);
  }

  async createAndPersist(
    record: Omit<OAuthRefreshTokenRecord, 'expiresAt'>,
    lifetimeMs = OAuthRefreshTokenStore.DEFAULT_TTL_MS,
  ): Promise<string> {
    const token = this.create(record, lifetimeMs);
    await this.persistIfConfigured();
    return token;
  }

  has(token: string): boolean {
    return this.records.has(digestToken(token));
  }

  entries(): Array<{ token: string; record: OAuthRefreshTokenRecord }> {
    const now = Date.now();
    return [...this.records.values()]
      .filter((record) => record.expiresAt > now)
      .map((record) => {
        const { tokenHash, ...rest } = record;
        return { token: tokenHash, record: rest };
      });
  }

  entriesWithTokens(): Array<{ token: string; record: OAuthRefreshTokenRecord }> {
    const now = Date.now();
    return [...this.records.values()]
      .filter((record) => record.expiresAt > now)
      .map(({ tokenHash, ...record }) => ({ token: tokenHash, record }));
  }

  consume(token: string): OAuthRefreshTokenRecord | undefined {
    const tokenHash = digestToken(token);
    const record = this.records.get(tokenHash);
    if (!record) return undefined;
    this.records.delete(tokenHash);
    if (record.expiresAt <= Date.now()) return undefined;
    const { tokenHash: _tokenHash, ...result } = record;
    return result;
  }

  async consumeAndPersist(token: string): Promise<OAuthRefreshTokenRecord | undefined> {
    const record = this.consume(token);
    if (record) await this.persistIfConfigured();
    return record;
  }

  clear(): void {
    this.records.clear();
  }

  async clearAndPersist(): Promise<void> {
    this.records.clear();
    if (this.secretStore && this.secretKey) await this.secretStore.delete(this.secretKey);
  }

  revoke(token: string): boolean {
    const tokenHash = digestToken(token);
    const existed = this.records.delete(tokenHash);
    return existed;
  }

  async revokeAndPersist(token: string): Promise<boolean> {
    const existed = this.revoke(token);
    if (existed) await this.persistIfConfigured();
    return existed;
  }

  private async persistIfConfigured(): Promise<void> {
    if (this.secretStore && this.secretKey) {
      await this.persist(this.secretStore, this.secretKey);
    }
  }

  async persist(store: SecretStoreLike, key: string): Promise<void> {
    const now = Date.now();
    const active = [...this.records.values()].filter((record) => record.expiresAt > now);
    await store.set(key, JSON.stringify(active));
  }

  async load(store: SecretStoreLike, key: string): Promise<void> {
    const raw = await store.get(key);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed.filter((entry): entry is OAuthRefreshTokenRecord & { tokenHash?: unknown } =>
            entry
            && typeof entry === 'object'
            && typeof (entry as { tokenHash?: unknown }).tokenHash === 'string'
            && typeof (entry as OAuthRefreshTokenRecord).clientId === 'string'
            && typeof (entry as OAuthRefreshTokenRecord).resource === 'string'
            && Array.isArray((entry as OAuthRefreshTokenRecord).scopes)
            && typeof (entry as OAuthRefreshTokenRecord).expiresAt === 'number')
        : [];
      const now = Date.now();
      for (const entry of entries) {
        if (entry.expiresAt > now) {
          this.records.set(entry.tokenHash as string, entry as OAuthRefreshTokenRecord & { tokenHash: string });
        }
      }
    } catch (error) {
      console.warn('[dsh-browser-bridge] failed to load persisted refresh tokens', error);
      await store.delete(key);
    }
  }
}

export interface OAuthClientRecord {
  clientId: string;
  clientName?: string | undefined;
  redirectUris: string[];
  createdAt: string;
}

export class OAuthPersistentClientStore {
  private readonly clients = new Map<string, OAuthClientRecord>();

  constructor(
    private readonly store?: SecretStoreLike,
    private readonly key?: string,
  ) {}

  async load(): Promise<void> {
    if (!this.store || !this.key) return;
    const raw = await this.store.get(this.key);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed.filter((entry): entry is OAuthClientRecord =>
            entry
            && typeof entry === 'object'
            && typeof (entry as OAuthClientRecord).clientId === 'string'
            && Array.isArray((entry as OAuthClientRecord).redirectUris)
            && (entry as OAuthClientRecord).redirectUris.every((uri) => typeof uri === 'string'))
        : [];
      for (const entry of entries) this.clients.set(entry.clientId, entry);
    } catch (error) {
      console.warn('[dsh-browser-bridge] failed to load persisted OAuth clients', error);
      await this.store.delete(this.key);
    }
  }

  get(clientId: string): OAuthClientRecord | undefined {
    return this.clients.get(clientId);
  }

  set(client: OAuthClientRecord): void {
    this.clients.set(client.clientId, client);
  }

  async save(client: OAuthClientRecord): Promise<void> {
    this.set(client);
    await this.persist();
  }

  async persist(): Promise<void> {
    if (this.store && this.key) {
      await this.store.set(this.key, JSON.stringify([...this.clients.values()]));
    }
  }

  async clear(): Promise<void> {
    this.clients.clear();
    if (this.store && this.key) await this.store.delete(this.key);
  }
}
