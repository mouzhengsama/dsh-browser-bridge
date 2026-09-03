import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeHttpCarrier } from '../http/server.js';
import { recordJsonlDiagnostic } from '../dsh-plugin.js';
import type {
  BridgeConfigSnapshot,
  BridgeConfigUpdate,
  BridgeConnectionInfo,
  BridgeStatus,
} from '../types.js';
import { DesktopBrowserHost } from './desktop-host.js';
import type {
  BridgeControlAction,
  BridgeControlResponse,
  BridgeControlSnapshot,
} from './types.js';

export const BRIDGE_CONTROL_PATH = '/browser-bridge/control';
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

export interface BridgeControlRuntime {
  readonly status: BridgeStatus;
  start(): Promise<BridgeStatus>;
  stop(): Promise<void>;
  resetPath(): Promise<void>;
  getConnectionInfo(): Promise<BridgeConnectionInfo>;
  getConfigSnapshot(): Promise<BridgeConfigSnapshot>;
  updateConfig(update: BridgeConfigUpdate): Promise<BridgeConfigSnapshot>;
  createOAuthPairingCode(): import('../types.js').OAuthPairingCode;
  revokeAllOAuthGrants(): Promise<void>;
}

function writeJson(
  res: ServerResponse,
  status: number,
  response: BridgeControlResponse,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(response));
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function parseConfigUpdate(value: unknown): BridgeConfigUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('update must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowSecretPathOnly = optionalBoolean(
    record.allowSecretPathOnly,
    'update.allowSecretPathOnly',
  );
  let allowedOrigins: string[] | undefined;
  if (record.allowedOrigins !== undefined) {
    if (!Array.isArray(record.allowedOrigins)) {
      throw new Error('update.allowedOrigins must be an array');
    }
    allowedOrigins = record.allowedOrigins.map((item) => {
      if (typeof item !== 'string') throw new Error('update.allowedOrigins must contain strings');
      return item;
    });
  }
  const tunnel = record.tunnel;
  if (!tunnel || typeof tunnel !== 'object' || Array.isArray(tunnel)) {
    throw new Error('update.tunnel must be an object');
  }
  const fields = tunnel as Record<string, unknown>;
  const provider = optionalString(fields.provider, 'update.tunnel.provider');
  if (
    provider !== undefined
    && provider !== 'none'
    && provider !== 'cloudflare'
    && provider !== 'cloudflare-named'
    && provider !== 'ngrok'
    && provider !== 'localtunnel'
  ) {
    throw new Error('update.tunnel.provider is invalid');
  }
  const result: BridgeConfigUpdate['tunnel'] = {};
  if (provider !== undefined) result.provider = provider;
  const cloudflareNamedDomain = optionalString(
    fields.cloudflareNamedDomain,
    'update.tunnel.cloudflareNamedDomain',
  );
  if (cloudflareNamedDomain !== undefined) {
    result.cloudflareNamedDomain = cloudflareNamedDomain;
  }
  const cloudflareNamedToken = optionalString(
    fields.cloudflareNamedToken,
    'update.tunnel.cloudflareNamedToken',
  );
  if (cloudflareNamedToken !== undefined) {
    result.cloudflareNamedToken = cloudflareNamedToken;
  }
  const ngrokDomain = optionalString(fields.ngrokDomain, 'update.tunnel.ngrokDomain');
  if (ngrokDomain !== undefined) result.ngrokDomain = ngrokDomain;
  const ngrokUseHttpProxy = optionalBoolean(
    fields.ngrokUseHttpProxy,
    'update.tunnel.ngrokUseHttpProxy',
  );
  if (ngrokUseHttpProxy !== undefined) result.ngrokUseHttpProxy = ngrokUseHttpProxy;
  return {
    ...(allowSecretPathOnly === undefined ? {} : { allowSecretPathOnly }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    tunnel: result,
  };
}

function parseAction(value: unknown): BridgeControlAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Control request must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const action = requiredString(record.action, 'action');
  const workspaceId = requiredString(record.workspaceId, 'workspaceId');
  if (
    action === 'bridge.start'
    || action === 'bridge.stop'
    || action === 'bridge.reset'
    || action === 'bridge.connection'
    || action === 'bridge.config.get'
    || action === 'browser.hide'
  ) {
    return { action, workspaceId };
  }
  if (action === 'bridge.oauth.pair') {
    return { action, workspaceId };
  }
  if (action === 'bridge.oauth.revoke') {
    return { action, workspaceId };
  }
  if (action === 'bridge.config.update') {
    return {
      action,
      workspaceId,
      update: parseConfigUpdate(record.update),
    };
  }
  if (action === 'browser.open' || action === 'browser.navigate') {
    return {
      action,
      workspaceId,
      paneId: requiredString(record.paneId, 'paneId'),
      url: requiredString(record.url, 'url'),
    };
  }
  if (
    action === 'browser.back'
    || action === 'browser.forward'
    || action === 'browser.reload'
    || action === 'browser.stop'
    || action === 'browser.close'
  ) {
    return {
      action,
      workspaceId,
      paneId: requiredString(record.paneId, 'paneId'),
    };
  }
  if (action === 'browser.bounds') {
    if (!Array.isArray(record.panes)) throw new Error('panes must be an array');
    const panes = record.panes.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Each visible pane must be an object');
      }
      const pane = item as Record<string, unknown>;
      const bounds = pane.bounds;
      if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
        throw new Error('Pane bounds must be an object');
      }
      const rect = bounds as Record<string, unknown>;
      return {
        id: requiredString(pane.id, 'pane id'),
        bounds: {
          x: Number(rect.x),
          y: Number(rect.y),
          width: Number(rect.width),
          height: Number(rect.height),
        },
      };
    });
    return { action, workspaceId, panes };
  }
  throw new Error(`Unknown control action "${action}"`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error('Content-Type must be application/json');
  }
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTROL_BODY_BYTES) {
    throw new Error('Control request body is too large');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_CONTROL_BODY_BYTES) {
      throw new Error('Control request body is too large');
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error('Control request body is required');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class BridgeControlHttpService {
  constructor(
    private readonly runtime: BridgeControlRuntime,
    readonly browser: DesktopBrowserHost,
  ) {}

  register(webServer: BridgeHttpCarrier): () => void {
    return webServer.register({
      kind: 'prefix',
      path: BRIDGE_CONTROL_PATH,
      handler: (req, res) => this.handle(req, res),
    });
  }

  async dispose(): Promise<void> {
    await this.browser.dispose();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rendererHeader = req.headers['x-dsh-desktop-renderer'];
    void recordJsonlDiagnostic('browser-bridge-control.jsonl', {
      stage: 'control-request',
      method: req.method,
      url: req.url,
      remoteAddress: req.socket.remoteAddress,
      rendererHeaderPresent: typeof rendererHeader === 'string' && rendererHeader.length > 0,
      secFetchSite: req.headers['sec-fetch-site'],
    });
    console.info('[dsh-browser-bridge] control request', {
      method: req.method,
      url: req.url,
      remoteAddress: req.socket.remoteAddress,
      rendererHeaderPresent: typeof rendererHeader === 'string' && rendererHeader.length > 0,
      rendererHeaderLength: typeof rendererHeader === 'string' ? rendererHeader.length : 0,
      secFetchSite: req.headers['sec-fetch-site'],
      contentType: req.headers['content-type'],
    });
    if (!isLoopback(req.socket.remoteAddress)) {
      writeJson(res, 403, { ok: false, error: 'Bridge controls are available only on localhost' });
      return;
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      writeJson(res, 403, { ok: false, error: 'Cross-site Bridge control requests are forbidden' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://bridge.local');
    try {
      if (req.method === 'GET' && url.pathname === `${BRIDGE_CONTROL_PATH}/snapshot`) {
        const workspaceId = requiredString(url.searchParams.get('workspaceId'), 'workspaceId');
        const snapshot = await this.snapshot(workspaceId);
        void recordJsonlDiagnostic('browser-bridge-control.jsonl', {
          stage: 'control-snapshot-result',
          workspaceId,
          bridge: {
            state: snapshot.bridge.state,
            tunnelProvider: snapshot.bridge.tunnelProvider,
            publicOrigin: snapshot.bridge.publicOrigin,
            localOrigin: snapshot.bridge.localOrigin,
          },
          browser: {
            available: snapshot.browser.available,
            reason: snapshot.browser.reason,
            unavailableReasonCode: snapshot.browser.unavailableReasonCode,
            panes: snapshot.browser.panes.length,
          },
        });
        writeJson(res, 200, { ok: true, data: snapshot });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BRIDGE_CONTROL_PATH}/action`) {
        console.info('[dsh-browser-bridge] control action body read started');
        const action = parseAction(await readJson(req));
        console.info('[dsh-browser-bridge] control action body read completed', {
          action: action.action,
        });
        const result = await this.execute(action);
      void recordJsonlDiagnostic('browser-bridge-control.jsonl', {
        stage: 'control-action-result',
        action: action.action,
        resultKind: typeof result,
      });
        writeJson(res, 200, { ok: true, data: result });
        return;
      }
      writeJson(res, 404, { ok: false, error: 'Unknown Bridge control endpoint' });
    } catch (error) {
      console.error('[dsh-browser-bridge] control request failed', {
        method: req.method,
        url: req.url,
        error: error instanceof Error ? error.message : String(error),
      });
      void recordJsonlDiagnostic('browser-bridge-control.jsonl', {
        stage: 'control-request-failed',
        method: req.method,
        url: req.url,
        error: error instanceof Error ? error.message : String(error),
      });
      writeJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async snapshot(workspaceId: string): Promise<BridgeControlSnapshot> {
    return {
      bridge: this.runtime.status,
      configuration: await this.runtime.getConfigSnapshot(),
      browser: await this.browser.snapshot(workspaceId),
    };
  }

  private async execute(action: BridgeControlAction): Promise<unknown> {
    if (action.action === 'bridge.start') return this.runtime.start();
    if (action.action === 'bridge.stop') {
      await this.runtime.stop();
      return this.runtime.status;
    }
    if (action.action === 'bridge.reset') {
      await this.runtime.resetPath();
      return this.runtime.status;
    }
    if (action.action === 'bridge.connection') {
      return this.runtime.getConnectionInfo();
    }
    if (action.action === 'bridge.config.get') {
      return this.runtime.getConfigSnapshot();
    }
    if (action.action === 'bridge.config.update') {
      return this.runtime.updateConfig(action.update);
    }
    if (action.action === 'bridge.oauth.pair') {
      return this.runtime.createOAuthPairingCode();
    }
    if (action.action === 'bridge.oauth.revoke') {
      await this.runtime.revokeAllOAuthGrants();
      return this.runtime.status;
    }
    if (action.action === 'browser.open') {
      return this.browser.open(action.workspaceId, action.paneId, action.url);
    }
    if (action.action === 'browser.navigate') {
      return this.browser.navigate(action.workspaceId, action.paneId, action.url);
    }
    if (
      action.action === 'browser.back'
      || action.action === 'browser.forward'
      || action.action === 'browser.reload'
      || action.action === 'browser.stop'
    ) {
      return this.browser.navigation(
        action.workspaceId,
        action.paneId,
        action.action.slice('browser.'.length) as 'back' | 'forward' | 'reload' | 'stop',
      );
    }
    if (action.action === 'browser.close') {
      await this.browser.close(action.workspaceId, action.paneId);
      return this.snapshot(action.workspaceId);
    }
    if (action.action === 'browser.bounds') {
      return this.browser.setBounds(action.workspaceId, action.panes);
    }
    await this.browser.hide(action.workspaceId);
    return this.snapshot(action.workspaceId);
  }
}
