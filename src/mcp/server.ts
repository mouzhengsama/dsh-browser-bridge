import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BridgeConfig, WorkspaceAdapter } from '../types.js';

function result(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value } as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: error instanceof Error ? error.message : String(error),
    }],
  };
}

function guarded<T>(handler: () => Promise<T> | T): Promise<CallToolResult> {
  return Promise.resolve()
    .then(handler)
    .then(result)
    .catch(failure);
}

export function createBridgeMcpServer(
  adapter: WorkspaceAdapter,
  config: BridgeConfig,
): McpServer {
  const server = new McpServer({
    name: 'dsh-browser-bridge',
    version: '0.1.0',
  });

  server.registerTool(
    'bridge_info',
    {
      description: 'Describe the exposed workspace and enabled capabilities.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => guarded(() => ({
      workspace: '.',
      pathPolicy: 'workspace-relative',
      capabilities: config.capabilities,
      limits: config.limits,
    })),
  );

  if (config.capabilities.read) {
    server.registerTool(
      'list_files',
      {
        description: 'List workspace files matching glob patterns. Paths are workspace-relative.',
        inputSchema: z.object({
          patterns: z.array(z.string()).optional().describe('Glob patterns; defaults to **/*'),
          limit: z.number().int().positive().optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ patterns, limit }) => guarded(() => adapter.listFiles(patterns, limit)),
    );

    server.registerTool(
      'list_directory',
      {
        description: 'List a directory tree without following symbolic links.',
        inputSchema: z.object({
          directory: z.string().optional().describe('Workspace-relative directory; defaults to root'),
          depth: z.number().int().min(0).max(10).optional(),
          limit: z.number().int().positive().optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ directory, depth, limit }) => guarded(
        () => adapter.listDirectory(directory, depth, limit),
      ),
    );

    server.registerTool(
      'search_text',
      {
        description: 'Search text files in the workspace and return line/column matches.',
        inputSchema: z.object({
          query: z.string().min(1),
          isRegex: z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          include: z.array(z.string()).optional().describe('Optional file glob patterns'),
          limit: z.number().int().positive().optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ query, ...options }) => guarded(() => adapter.searchText(query, options)),
    );

    server.registerTool(
      'read_file',
      {
        description: 'Read a UTF-8 text file with a SHA-256 version for optimistic patching.',
        inputSchema: z.object({
          path: z.string().min(1),
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ path, startLine, endLine }) => guarded(
        () => adapter.readFile(path, startLine, endLine),
      ),
    );
  }

  if (config.capabilities.write) {
    server.registerTool(
      'apply_patch',
      {
        description:
          'Apply a multi-file unified diff after validating every hunk and optional file versions.',
        inputSchema: z.object({
          patch: z.string().min(1),
          expectedVersions: z.record(z.string(), z.string()).optional(),
        }),
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      ({ patch, expectedVersions }) => guarded(
        () => adapter.applyPatch(patch, expectedVersions),
      ),
    );
  }

  if (config.capabilities.command) {
    server.registerTool(
      'run_command',
      {
        description:
          'Start a shell command in the workspace and optionally wait for initial output or completion.',
        inputSchema: z.object({
          command: z.string().min(1),
          cwd: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          waitMs: z.number().int().min(0).optional(),
        }),
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      (options) => guarded(() => adapter.runCommand(options)),
    );

    server.registerTool(
      'get_command_output',
      {
        description:
          'Read command output incrementally using the previous nextOffset; optionally wait for more output.',
        inputSchema: z.object({
          commandId: z.string().min(1),
          offset: z.number().int().min(0).optional(),
          waitMs: z.number().int().min(0).optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ commandId, offset, waitMs }) => guarded(
        () => adapter.getCommandOutput(commandId, offset, waitMs),
      ),
    );

    server.registerTool(
      'send_command_input',
      {
        description: 'Send text to a running command stdin, optionally closing stdin afterward.',
        inputSchema: z.object({
          commandId: z.string().min(1),
          input: z.string().default(''),
          close: z.boolean().optional(),
        }),
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      ({ commandId, input, close }) => guarded(
        () => adapter.sendCommandInput(commandId, input, close),
      ),
    );

    server.registerTool(
      'terminate_command',
      {
        description: 'Terminate a running command.',
        inputSchema: z.object({ commandId: z.string().min(1) }),
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      ({ commandId }) => guarded(() => adapter.terminateCommand(commandId)),
    );
  }

  if (config.capabilities.lsp) {
    server.registerTool(
      'get_diagnostics',
      {
        description: 'Start the configured language server for a file and return its diagnostics.',
        inputSchema: z.object({
          path: z.string().optional(),
          waitMs: z.number().int().min(0).max(10_000).optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ path, waitMs }) => guarded(() => adapter.getDiagnostics(path, waitMs)),
    );

    server.registerTool(
      'lsp_query',
      {
        description:
          'Query the dsh language-server seam for precise definition, reference, implementation, or hover results.',
        inputSchema: z.object({
          operation: z.enum([
            'goToDefinition',
            'findReferences',
            'goToImplementation',
            'hover',
          ]),
          path: z.string().min(1),
          line: z.number().int().positive(),
          character: z.number().int().positive(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      ({ operation, path, line, character }) => guarded(async () => {
        if (!adapter.queryLsp) {
          throw new Error('The active workspace adapter does not expose semantic LSP queries');
        }
        return adapter.queryLsp({ operation, path, line, character });
      }),
    );
  }

  if (config.capabilities.progress) {
    server.registerTool(
      'report_progress',
      {
        description: 'Record the current task stage so the local host UI can display remote progress.',
        inputSchema: z.object({
          stage: z.string().min(1),
          message: z.string().min(1),
          percent: z.number().min(0).max(100).optional(),
          completed: z.boolean().optional(),
        }),
        annotations: { idempotentHint: false },
      },
      (progress) => guarded(() => adapter.reportProgress(progress)),
    );

    server.registerTool(
      'get_progress',
      {
        description: 'Return the most recently reported task progress.',
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      () => guarded(() => adapter.getProgress() ?? null),
    );
  }

  return server;
}
