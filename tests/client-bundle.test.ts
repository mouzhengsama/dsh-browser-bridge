import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_LINKS } from '../src/links.js';

const root = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

describe('dsh client bundle', () => {
  it('loads through the dsh ModuleLoader wrapper and exposes the client plugin', async () => {
    await execFileAsync(process.execPath, ['scripts/build-client.mjs'], { cwd: root });
    const source = await readFile(path.join(root, 'dist/client.js'), 'utf8');
    let loaded: Record<string, unknown> | undefined;
    const context = {
      window: {
        __ModuleLoader__: {
          load(payload: {
            id: string;
            factory: (loader: (id: string) => unknown) => unknown;
          }) {
            loaded = payload.factory((id) => require(id)) as Record<string, unknown>;
            expect(payload.id).toBe('@dsh/browser-bridge');
          },
        },
      },
      URL,
      URLSearchParams,
      console,
      setTimeout,
      clearTimeout,
      DOMException,
      fetch: () => {
        throw new Error('fetch should not run while loading the module');
      },
    };

    vm.runInNewContext(source, context);

    expect(loaded).toMatchObject({
      apply: expect.any(Function),
      inject: ['slots'],
      name: 'dsh-browser-bridge-client',
    });
  }, 30_000);

  it('keeps the browser tab strip visible in split mode and uses separate close buttons', async () => {
    const source = await readFile(path.join(root, 'src/client.tsx'), 'utf8');

    expect(source).toContain('className="dbb-tabs"');
    expect(source).toContain('data-layout={split ? \'split\' : \'single\'}');
    expect(source).not.toContain('!split && (');
    expect(source).not.toContain('role="button"\n                tabIndex={0}');
  });

  it('does not cap embedded browser tabs at two', async () => {
    const source = await readFile(path.join(root, 'src/client.tsx'), 'utf8');
    const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(sourceWithoutComments).not.toContain('MAX_PANES_PER_WORKSPACE');
    expect(sourceWithoutComments).not.toContain("disabled={panes.length >= 2}");
    expect(sourceWithoutComments).not.toContain("['pane-1', 'pane-2']");
    expect(sourceWithoutComments).toContain('function createPaneId');
  });

  it('includes the requested built-in Chinese web agent entries', async () => {
    const source = await readFile(path.join(root, 'src/client.tsx'), 'utf8');
    const urls = BUILT_IN_LINKS.map(link => link.url);
    expect(urls).toEqual(expect.arrayContaining([
      'https://chatgpt.com',
      'https://workbuddy.cn/app',
      'https://arena.ai/agent',
      'https://work.trae.cn',
      'https://qwenwork.cn/app/chat',
      'https://manus.im/app',
      'https://shunova.cc',
      'https://doubao.com/chat',
      'https://kimi.moonshot.cn',
    ]));
    expect(source).toContain("from './links.js'");
  });

  it('includes the collapsible tunnel settings and domestic web AI shortcuts', async () => {
    const source = await readFile(path.join(root, 'src/client.tsx'), 'utf8');

    expect(source).toContain('title="连接设置"');
    expect(source).toContain('Cloudflare Quick Tunnel（无需账号或域名）');
    expect(source).toContain('Cloudflare Named Tunnel');
    expect(source).toContain('Cloudflare HTTP 代理（可选）');
    expect(source).toContain('region1.v2.argotunnel.com:7844');
    expect(source).toContain('!cloudflaredHttpProxy.trim() !== !cloudflareEdgeAuthority.trim()');
    expect(source).toContain("from './links.js'");
  });

  it('shows separate connector credentials after the bridge is running', async () => {
    const source = await readFile(path.join(root, 'src/client.tsx'), 'utf8');

    expect(source).toContain('<section className="dbb-section" aria-label="Connector 配置">');
    expect(source).toContain('value={revealBearer');
    expect(source).toContain("copyConnectionValue('url')");
    expect(source).toContain("copyConnectionValue('bearer')");
  });
});
