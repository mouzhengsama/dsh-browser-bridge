import { createServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeHttpServer } from './server.js';
import { constantTimeEqual } from './security.js';

const LOCAL_PAIRING_PATH = '/__local/oauth/pairing';

export class LocalConnectorServer {
  private server: HttpServer | undefined;
  private listeningPort: number | undefined;

  constructor(
    private readonly bridge: BridgeHttpServer,
    private readonly localPairingToken: string,
  ) {}

  get port(): number {
    if (this.listeningPort === undefined) {
      throw new Error('Local connector is not running');
    }
    return this.listeningPort;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  async start(preferredPort: number, options: { fixed?: boolean } = {}): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://bridge.local').pathname;
      if (pathname === LOCAL_PAIRING_PATH) {
        void this.handleLocalPairing(req, res);
        return;
      }
      void this.bridge.handleNodeRequest(req, res);
    });
    this.server = server;
    try {
      await this.listenOn(server, preferredPort);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || preferredPort === 0 || options.fixed) {
        throw error;
      }
      console.info(`[dsh-browser-bridge] connector port ${preferredPort} is in use, ` +
        'falling back to an ephemeral port');
      await this.listenOn(server, 0);
    }
  }

  private async listenOn(server: HttpServer, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine local connector port'));
          return;
        }
        this.listeningPort = address.port;
        resolve();
      });
    });
  }

  private async handleLocalPairing(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
        send(403, { error: 'Local pairing endpoint is loopback-only' });
        return;
      }
      if (req.headers.origin !== undefined) {
        send(403, { error: 'Browser requests are not allowed' });
        return;
      }
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        send(401, { error: 'Local pairing token required' });
        return;
      }
      if (!constantTimeEqual(authorization.slice('Bearer '.length), this.localPairingToken)) {
        send(401, { error: 'Invalid local pairing token' });
        return;
      }
      if (req.method !== 'POST') {
        send(405, { error: 'Method not allowed' });
        return;
      }
      for await (const _chunk of req) {
        // Drain the request body for keep-alive correctness.
      }
      send(200, this.bridge.createOAuthPairingCode());
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listeningPort = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
