import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import express, { type Request, type Response } from 'express';
import { createBridgeMcpServer } from '../mcp/server.js';
import { LocalConnectorServer } from './connector.js';
import type { BridgeConfig, WorkspaceAdapter } from '../types.js';
import {
  bodyMethodName,
  type BridgeHttpAccessEvent,
  headerOriginHostname,
  headerUserAgent,
  parseRequestBodyLimit,
  RequestLimiter,
  RequestSecurity,
  requestLimits,
  writeJsonError,
} from './security.js';

export type { BridgeHttpAccessEvent } from './security.js';

interface McpSession {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
}

export interface BridgeHttpCarrier {
  readonly host: '127.0.0.1' | '0.0.0.0';
  readonly port: number;
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

export interface BridgeHttpServerOptions {
  config: BridgeConfig;
  adapter: WorkspaceAdapter;
  secretPath: string;
  bearerToken?: string | undefined;
  carrier?: BridgeHttpCarrier | undefined;
  localConnectorPort?: number | undefined;
  onAccessLog?: ((event: BridgeHttpAccessEvent) => void) | undefined;
}

export class BridgeHttpServer {
  readonly mcpPath: string;
  readonly healthPath: string;
  readonly security: RequestSecurity;
  private readonly sessions = new Map<string, McpSession>();
  private readonly limiter: RequestLimiter;
  private server: HttpServer | undefined;
  private listeningPort: number | undefined;
  private routeDisposer: (() => void) | undefined;
  readonly localConnector: LocalConnectorServer;

  constructor(private readonly options: BridgeHttpServerOptions) {
    this.mcpPath = `/mcp/${encodeURIComponent(options.secretPath)}`;
    this.healthPath = `${this.mcpPath}/health`;
    this.security = new RequestSecurity(options.config.allowedOrigins, options.bearerToken);
    this.security.onAccessLog = options.onAccessLog;
    this.limiter = new RequestLimiter(
      options.config.limits.requestsPerMinute,
      options.config.limits.maxConcurrentRequests,
    );
    this.localConnector = new LocalConnectorServer(this);
  }

  get localOrigin(): string {
    if (this.listeningPort === undefined) {
      throw new Error('HTTP server is not running');
    }
    const host = this.options.carrier?.host === '0.0.0.0' || this.options.config.host === '0.0.0.0'
      ? '127.0.0.1'
      : this.options.carrier?.host ?? this.options.config.host;
    if (this.options.carrier && this.localConnector.running) {
      return `http://127.0.0.1:${this.localConnector.port}`;
    }
    return `http://${host}:${this.listeningPort}`;
  }

  get mcpUrl(): string {
    return `${this.localOrigin}${this.mcpPath}`;
  }

  async start(): Promise<void> {
    if (this.server || this.routeDisposer) {
      return;
    }
    if (this.options.carrier) {
      this.routeDisposer = this.options.carrier.register({
        kind: 'prefix',
        path: this.mcpPath,
        handler: (req, res) => this.handleNodeRequest(req, res),
      });
      this.listeningPort = this.options.carrier.port;
      await this.localConnector.start(
        this.options.localConnectorPort ?? this.options.config.localConnectorPort ?? 0,
      );
      console.info('[dsh-browser-bridge] local connector started', {
        port: this.localConnector.port,
      });
      return;
    }

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: this.options.config.limits.requestBodyLimit }));
    app.use(this.mcpPath, this.security.middleware());

    app.get(this.healthPath, (_req, res) => {
      res.json({
        ok: true,
        protocol: 'streamable-http',
        sessions: this.sessions.size,
      });
    });
    app.post(
      this.mcpPath,
      requestLimits(
        this.options.config.limits.requestsPerMinute,
        this.options.config.limits.maxConcurrentRequests,
      ),
      (req, res) => {
        void this.handlePost(req, res);
      },
    );
    app.get(this.mcpPath, (req, res) => {
      void this.handleSessionVerb(req, res);
    });
    app.delete(this.mcpPath, (req, res) => {
      void this.handleSessionVerb(req, res);
    });

    this.server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(
        this.options.config.port,
        this.options.config.host,
        () => {
          this.server!.off('error', reject);
          const address = this.server!.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Unable to determine listening port'));
            return;
          }
          this.listeningPort = address.port;
          resolve();
        },
      );
    });
  }

  allowPublicOrigin(origin: string): void {
    this.security.allowPublicOrigin(origin);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async ({ transport, server }) => {
      await Promise.allSettled([transport.close(), server.close()]);
    }));
    await this.localConnector.stop();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      this.listeningPort = undefined;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    this.routeDisposer?.();
    this.routeDisposer = undefined;
    this.listeningPort = undefined;
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.headers['mcp-session-id'];
      const id = typeof sessionId === 'string' ? sessionId : undefined;
      if (id) {
        const session = this.sessions.get(id);
        if (!session) {
          jsonRpcError(res, 404, -32_001, 'Session not found');
          return;
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32_000, 'Bad Request: initialization request required');
        return;
      }

      let session!: McpSession;
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, session);
        },
      });
      const server = createBridgeMcpServer(this.options.adapter, this.options.config);
      session = { transport, server };
      transport.onclose = () => {
        if (transport.sessionId) {
          this.sessions.delete(transport.sessionId);
        }
        void server.close();
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32_603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async handleSessionVerb(req: Request, res: Response): Promise<void> {
    try {
      const header = req.headers['mcp-session-id'];
      const sessionId = typeof header === 'string' ? header : undefined;
      if (!sessionId) {
        res.status(400).send('Missing MCP-Session-Id');
        return;
      }
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.status(404).send('Session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).send(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const accessContext: { bodyMethod?: string } = {};
    this.logNodeAccess(req, res, accessContext);

    this.security.applyCorsHeaders(req, res);
    const isPreflight = req.method?.toUpperCase() === 'OPTIONS';
    const failure = this.security.authorize(req, { skipBearer: isPreflight });
    if (failure) {
      writeJsonError(res, failure.status, failure.message, failure.authenticate);
      return;
    }
    if (isPreflight) {
      res.writeHead(204);
      res.end();
      return;
    }

    const decision = this.limiter.begin(req);
    if (!decision.allowed) {
      writeJsonError(res, decision.status!, decision.message!);
      return;
    }
    res.once('finish', decision.release);
    res.once('close', decision.release);

    const pathname = new URL(req.url ?? '/', 'http://bridge.local').pathname;
    if (pathname === this.healthPath && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        protocol: 'streamable-http',
        sessions: this.sessions.size,
      }));
      return;
    }
    if (pathname !== this.mcpPath) {
      writeJsonRpcErrorNode(res, 404, -32_001, 'Not Found');
      res.end();
      return;
    }

    try {
      if (req.method === 'POST') {
        const body = await this.readJsonBody(req);
        const bodyMethod = bodyMethodName(body);
        if (bodyMethod) {
          accessContext.bodyMethod = bodyMethod;
        }
        await this.handleNodePost(req, res, body);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        await this.handleNodeSessionVerb(req, res);
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        writeJsonError(res, 500, error instanceof Error ? error.message : String(error));
      } else {
        res.destroy();
      }
    }
  }

  private logNodeAccess(
    req: IncomingMessage,
    res: ServerResponse,
    accessContext: { bodyMethod?: string },
  ): void {
    const startedAt = Date.now();
    const originAllowed = this.security.getAllowedCorsOrigin(req) !== undefined;
    const hasOrigin = Boolean(req.headers.origin);
    const hasAuthorization = Boolean(req.headers.authorization);
    const sessionHeader = req.headers['mcp-session-id'];
    const hasSessionId = typeof sessionHeader === 'string' && sessionHeader.length > 0;
    const origin = headerOriginHostname(req.headers.origin);
    const userAgent = headerUserAgent(req.headers['user-agent']);
    res.once('finish', () => {
      this.security.onAccessLog?.({
        method: req.method,
        status: res.statusCode,
        reason: 'response',
        durationMs: Date.now() - startedAt,
        hasOrigin,
        originAllowed,
        hasAuthorization,
        hasSessionId,
        ...(origin ? { origin } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(accessContext.bodyMethod ? { bodyMethod: accessContext.bodyMethod } : {}),
      });
    });
  }

  private async handleNodePost(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonRpcErrorNode(res, 404, -32_001, 'Session not found');
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      writeJsonRpcErrorNode(res, 400, -32_000, 'Bad Request: initialization request required');
      return;
    }

    let session!: McpSession;
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        this.sessions.set(newSessionId, session);
      },
    });
    const server = createBridgeMcpServer(this.options.adapter, this.options.config);
    session = { transport, server };
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
      void server.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private async handleNodeSessionVerb(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (!sessionId) {
      writeJsonError(res, 400, 'Missing MCP-Session-Id');
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(res, 404, 'Session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const maxBytes = parseRequestBodyLimit(this.options.config.limits.requestBodyLimit);
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`Request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
    if (total === 0) {
      throw new Error('Request body is required');
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error('Request body must be valid JSON');
    }
  }
}

function writeJsonRpcErrorNode(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}
