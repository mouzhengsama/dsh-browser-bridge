import { createServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeHttpServer } from './server.js';

export class LocalConnectorServer {
  private server: HttpServer | undefined;
  private listeningPort: number | undefined;

  constructor(private readonly bridge: BridgeHttpServer) {}

  get port(): number {
    if (this.listeningPort === undefined) {
      throw new Error('Local connector is not running');
    }
    return this.listeningPort;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  async start(preferredPort: number): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.bridge.handleNodeRequest(req, res);
    });
    this.server = server;
    try {
      await this.listenOn(server, preferredPort);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || preferredPort === 0) {
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
