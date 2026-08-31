import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { LanguageServerConfig } from '../types.js';
import type { WorkspaceFiles } from '../workspace/files.js';

interface DiagnosticParams {
  uri: string;
  diagnostics: unknown[];
  version?: number;
}

interface OpenDocument {
  contentVersion: string;
  documentVersion: number;
}

interface LanguageServerSession {
  config: LanguageServerConfig;
  child: ChildProcessWithoutNullStreams;
  connection: MessageConnection;
  initialized: Promise<void>;
  diagnostics: Map<string, DiagnosticParams>;
  opened: Map<string, OpenDocument>;
  waiters: Map<string, Set<() => void>>;
  stderr: string;
}

function normalizedExtensions(config: LanguageServerConfig): string[] {
  return config.extensions.map((extension) => (
    extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  ));
}

export class LanguageServerManager {
  private readonly sessions = new Map<string, LanguageServerSession>();

  constructor(
    private readonly workspace: WorkspaceFiles,
    private readonly configs: LanguageServerConfig[],
  ) {}

  async getDiagnostics(filePath?: string, waitMs = 1_000): Promise<unknown> {
    if (!filePath) {
      return {
        configuredServers: this.configs.map(({ id, extensions, command }) => ({
          id,
          extensions,
          command,
          running: this.sessions.has(id),
        })),
        diagnostics: [...this.sessions.values()].flatMap((session) => (
          [...session.diagnostics.values()]
        )),
      };
    }

    const extension = path.extname(filePath).toLowerCase();
    const config = this.configs.find((candidate) => normalizedExtensions(candidate).includes(extension));
    if (!config) {
      return {
        path: filePath,
        diagnostics: [],
        available: false,
        message: `No language server is configured for "${extension || '(no extension)'}" files`,
      };
    }

    const file = await this.workspace.readFile(filePath);
    const absolute = await this.workspace.paths.resolve(file.path, { mustExist: true });
    const uri = pathToFileURL(absolute).href;
    const session = await this.ensureSession(config);
    await session.initialized;

    const previous = session.opened.get(uri);
    const documentVersion = (previous?.documentVersion ?? 0) + 1;
    const notification = new Promise<void>((resolve) => {
      const waiters = session.waiters.get(uri) ?? new Set<() => void>();
      waiters.add(resolve);
      session.waiters.set(uri, waiters);
    });

    if (!previous) {
      session.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: config.languageId ?? extension.slice(1),
          version: documentVersion,
          text: file.content,
        },
      });
    } else if (previous.contentVersion !== file.version) {
      session.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: documentVersion },
        contentChanges: [{ text: file.content }],
      });
    }
    session.opened.set(uri, { contentVersion: file.version, documentVersion });

    await Promise.race([
      notification,
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(waitMs, 10_000)))),
    ]);
    const diagnostic = session.diagnostics.get(uri);
    return {
      path: file.path,
      serverId: config.id,
      available: true,
      diagnostics: diagnostic?.diagnostics ?? [],
      version: diagnostic?.version,
      stderr: session.stderr || undefined,
    };
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => {
      try {
        await Promise.race([
          session.connection.sendRequest('shutdown'),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        session.connection.sendNotification('exit');
      } catch {
        // The process may already have exited.
      }
      session.connection.dispose();
      if (!session.child.killed) {
        session.child.kill();
      }
    }));
  }

  private async ensureSession(config: LanguageServerConfig): Promise<LanguageServerSession> {
    const existing = this.sessions.get(config.id);
    if (existing) {
      return existing;
    }

    const child = spawn(config.command, config.args, {
      cwd: this.workspace.paths.root,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const connection = createMessageConnection(child.stdout, child.stdin);
    const session: LanguageServerSession = {
      config,
      child,
      connection,
      initialized: Promise.resolve(),
      diagnostics: new Map(),
      opened: new Map(),
      waiters: new Map(),
      stderr: '',
    };
    this.sessions.set(config.id, session);

    child.stderr.on('data', (chunk: Buffer | string) => {
      session.stderr = `${session.stderr}${chunk.toString()}`.slice(-16_384);
    });
    child.on('exit', () => {
      this.sessions.delete(config.id);
    });
    connection.onNotification('textDocument/publishDiagnostics', (params: DiagnosticParams) => {
      session.diagnostics.set(params.uri, params);
      const waiters = session.waiters.get(params.uri);
      session.waiters.delete(params.uri);
      for (const resolve of waiters ?? []) {
        resolve();
      }
    });
    connection.listen();

    const rootUri = pathToFileURL(this.workspace.paths.root).href;
    session.initialized = connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspace.paths.root) }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          synchronization: { dynamicRegistration: false },
        },
      },
      initializationOptions: config.initializationOptions,
      clientInfo: { name: 'dsh-browser-bridge', version: '0.1.0' },
    }).then(() => {
      connection.sendNotification('initialized', {});
    }).catch((error: unknown) => {
      this.sessions.delete(config.id);
      child.kill();
      throw new Error(`Language server "${config.id}" failed to initialize: ${String(error)}`);
    });
    return session;
  }
}
