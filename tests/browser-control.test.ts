import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeControlHttpService } from '../src/browser/control-http.js';
import {
  DesktopBrowserHost,
  type ElectronLoader,
} from '../src/browser/desktop-host.js';
import type { BridgeConfigSnapshot, BridgeStatus } from '../src/types.js';
import type { BridgeHttpCarrier } from '../src/http/server.js';
import { recordJsonlDiagnostic } from '../src/dsh-plugin.js';

vi.mock('../src/dsh-plugin.js', () => ({
  recordJsonlDiagnostic: vi.fn(),
}));

type Route = Parameters<BridgeHttpCarrier['register']>[0];

class TestCarrier implements BridgeHttpCarrier {
  readonly host = '127.0.0.1' as const;
  private route: Route | undefined;
  private readonly server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://carrier.local').pathname;
    if (this.route && (
      pathname === this.route.path
      || pathname.startsWith(`${this.route.path}/`)
    )) {
      void this.route.handler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Carrier is not listening');
    return address.port;
  }

  get registeredRoute(): Route {
    if (!this.route) throw new Error('No route registered');
    return this.route;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, this.host, resolve));
  }

  register(route: Route): () => void {
    this.route = route;
    return () => {
      if (this.route === route) this.route = undefined;
    };
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

class FakeWebContents {
  private url = '';
  private destroyed = false;
  readonly navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return '';
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  async loadURL(url: string): Promise<void> {
    this.url = url;
  }

  reload(): void {}

  stop(): void {}

  close(): void {
    this.destroyed = true;
  }

  setWindowOpenHandler(): void {}

  on(): void {}

  removeAllListeners(): void {}
}

class FakeView {
  readonly webContents = new FakeWebContents();
  bounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(_options: unknown) {}

  setBackgroundColor(_color: string): void {}

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }
}

class FakeWindow {
  readonly children = new Set<FakeView>();
  readonly contentView = {
    addChildView: (view: FakeView) => this.children.add(view),
    removeChildView: (view: FakeView) => this.children.delete(view),
  };
  readonly webContents = new FakeWebContents();

  constructor(private readonly port: number) {
    void this.webContents.loadURL(`http://127.0.0.1:${port}/`);
  }

  isDestroyed(): boolean {
    return false;
  }

  isVisible(): boolean {
    return true;
  }

  getContentBounds(): { width: number; height: number } {
    return { width: 1200, height: 800 };
  }

  getZoomFactor(): number {
    return 1;
  }
}

function createLoader(port: number, window: FakeWindow): ElectronLoader {
  return async () => ({
    BrowserWindow: { getAllWindows: () => [window] },
    WebContentsView: FakeView,
  }) as never;
}

function createRuntime(): {
    runtime: {
      status: BridgeStatus;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      resetPath: ReturnType<typeof vi.fn>;
      getConnectionInfo: ReturnType<typeof vi.fn>;
      getConfigSnapshot: ReturnType<typeof vi.fn>;
      updateConfig: ReturnType<typeof vi.fn>;
    };
} {
  const status: BridgeStatus = {
    state: 'stopped',
    tunnelProvider: 'none',
  };
  return {
    runtime: {
      status,
      start: vi.fn(async () => {
        status.state = 'running';
        return status;
      }),
      stop: vi.fn(async () => {
        status.state = 'stopped';
      }),
      resetPath: vi.fn(async () => undefined),
      getConnectionInfo: vi.fn(async () => ({
        state: status.state,
        tunnelProvider: status.tunnelProvider,
        instructions: 'Use the MCP URL in a new agent conversation.',
      })),
      getConfigSnapshot: vi.fn(async (): Promise<BridgeConfigSnapshot> => ({
        editable: status.state === 'stopped' || status.state === 'failed',
        allowSecretPathOnly: false,
        allowedOrigins: [],
        tunnel: {
          provider: status.tunnelProvider,
          cloudflareNamedDomain: '',
          cloudflareNamedTokenConfigured: false,
          ngrokDomain: '',
          ngrokUseHttpProxy: false,
          localServiceUrl: 'http://127.0.0.1:48271',
        },
      })),
      updateConfig: vi.fn(async (): Promise<BridgeConfigSnapshot> => ({
        editable: status.state === 'stopped' || status.state === 'failed',
        allowSecretPathOnly: false,
        allowedOrigins: [],
        tunnel: {
          provider: status.tunnelProvider,
          cloudflareNamedDomain: '',
          cloudflareNamedTokenConfigured: false,
          ngrokDomain: '',
          ngrokUseHttpProxy: false,
          localServiceUrl: 'http://127.0.0.1:48271',
        },
      })),
    },
  };
}

const carriers: TestCarrier[] = [];
const services: BridgeControlHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(carriers.splice(0).map((carrier) => carrier.close()));
});

async function createFixture(): Promise<{
  carrier: TestCarrier;
  service: BridgeControlHttpService;
  runtime: ReturnType<typeof createRuntime>['runtime'];
}> {
  const carrier = new TestCarrier();
  await carrier.start();
  carriers.push(carrier);
  const window = new FakeWindow(carrier.port);
  const browser = new DesktopBrowserHost(
    carrier.port,
    undefined,
    createLoader(carrier.port, window),
  );
  const { runtime } = createRuntime();
  const service = new BridgeControlHttpService(runtime, browser);
  service.register(carrier);
  services.push(service);
  return { carrier, service, runtime };
}

async function invoke(
  route: Route,
  options: {
    method: string;
    url: string;
    remoteAddress?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let body = '';
  const req = {
    method: options.method,
    url: options.url,
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(options.body);
    },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value?: string) {
      body = value ?? '';
    },
  } as unknown as ServerResponse;
  await route.handler(req, res);
  return { status, body: JSON.parse(body) as unknown };
}

describe('BridgeControlHttpService', () => {
  it('serves snapshots, dispatches browser actions, and returns the latest snapshot on close', async () => {
    const { carrier, runtime } = await createFixture();

    const snapshot = await fetch(
      `http://127.0.0.1:${carrier.port}/browser-bridge/control/snapshot?workspaceId=workspace-a`,
    );
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()) as { ok: boolean }).toMatchObject({
      ok: true,
    });

    const opened = await fetch(
      `http://127.0.0.1:${carrier.port}/browser-bridge/control/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'browser.open',
          workspaceId: 'workspace-a',
          paneId: 'pane-1',
          url: 'example.com',
        }),
      },
    );
    expect(opened.status).toBe(200);
    expect((await opened.json()) as { data: { url: string } }).toMatchObject({
      data: { url: 'https://example.com/' },
    });

    const closed = await fetch(
      `http://127.0.0.1:${carrier.port}/browser-bridge/control/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'browser.close',
          workspaceId: 'workspace-a',
          paneId: 'pane-1',
        }),
      },
    );
    expect(closed.status).toBe(200);
    expect((await closed.json()) as { data: { browser: { panes: unknown[] } } })
      .toMatchObject({ data: { browser: { panes: [] } } });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('rejects non-loopback and cross-site control requests', async () => {
    const { carrier } = await createFixture();
    const route = carrier.registeredRoute;

    await expect(invoke(route, {
      method: 'GET',
      url: '/browser-bridge/control/snapshot?workspaceId=workspace-a',
      remoteAddress: '10.0.0.4',
    })).resolves.toMatchObject({
      status: 403,
      body: { ok: false },
    });

    await expect(invoke(route, {
      method: 'GET',
      url: '/browser-bridge/control/snapshot?workspaceId=workspace-a',
      headers: { 'sec-fetch-site': 'cross-site' },
    })).resolves.toMatchObject({
      status: 403,
      body: { ok: false },
    });
  });

  it('validates content type, JSON size, actions, URLs, and bounds', async () => {
    const { carrier } = await createFixture();
    const route = carrier.registeredRoute;

    await expect(invoke(route, {
      method: 'POST',
      url: '/browser-bridge/control/action',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, error: 'Content-Type must be application/json' },
    });

    await expect(invoke(route, {
      method: 'POST',
      url: '/browser-bridge/control/action',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).resolves.toMatchObject({
      status: 400,
      body: { ok: false },
    });

    await expect(invoke(route, {
      method: 'POST',
      url: '/browser-bridge/control/action',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'browser.open',
        workspaceId: 'workspace-a',
        paneId: 'pane-1',
        url: 'file:///etc/passwd',
      }),
    })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, error: 'Only HTTP and HTTPS browser URLs are allowed' },
    });

    await expect(invoke(route, {
      method: 'POST',
      url: '/browser-bridge/control/action',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'browser.bounds',
        workspaceId: 'workspace-a',
        panes: [{
          id: 'pane-1',
          bounds: { x: 'not-a-number', y: 0, width: 1, height: 1 },
        }],
      }),
    })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, error: 'Browser bounds must contain finite numbers' },
    });

    await expect(invoke(route, {
      method: 'POST',
      url: '/browser-bridge/control/action',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'browser.unknown', workspaceId: 'workspace-a' }),
    })).resolves.toMatchObject({
      status: 400,
      body: { ok: false },
    });

    await expect(invoke(route, {
      method: 'POST',
      url: '/browser-bridge/control/action',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(64 * 1024 + 1),
    })).resolves.toMatchObject({
      status: 400,
      body: { ok: false, error: 'Control request body is too large' },
    });
  });

  it('dispatches bridge lifecycle and connection actions', async () => {
    const { carrier, runtime } = await createFixture();
    const endpoint = `http://127.0.0.1:${carrier.port}/browser-bridge/control/action`;
    const action = async (value: unknown) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });

    expect((await (await action({
      action: 'bridge.start',
      workspaceId: 'workspace-a',
    })).json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(runtime.start).toHaveBeenCalledTimes(1);

    await action({ action: 'bridge.connection', workspaceId: 'workspace-a' });
    await action({ action: 'bridge.config.get', workspaceId: 'workspace-a' });
    await action({
      action: 'bridge.config.update',
      workspaceId: 'workspace-a',
      update: { tunnel: { provider: 'cloudflare' } },
    });
    await action({ action: 'bridge.reset', workspaceId: 'workspace-a' });
    await action({ action: 'bridge.stop', workspaceId: 'workspace-a' });
    expect(runtime.getConnectionInfo).toHaveBeenCalledTimes(1);
    expect(runtime.getConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(runtime.updateConfig).toHaveBeenCalledTimes(1);
    expect(runtime.resetPath).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    const connectionDiagnostic = vi.mocked(recordJsonlDiagnostic).mock.calls
      .map(([, details]) => details)
      .find((details) => details.action === 'bridge.connection');
    expect(connectionDiagnostic).toMatchObject({
      stage: 'control-action-result',
      resultKind: 'object',
    });
    expect(connectionDiagnostic).not.toHaveProperty('resultPreview');
  });
});
