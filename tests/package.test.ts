import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('dsh bundle package', () => {
  it('declares the dsh bundle manifest and points its patch at the package root', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as {
      name: string;
      dsh?: {
        bundle?: { patch?: string };
        client?: { platform?: string; inject?: string[] };
      };
      exports?: Record<string, { import?: string; default?: string; types?: string }>;
      files?: string[];
    };
    const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');

    expect(packageJson.name).toBe('@dsh/browser-bridge');
    expect(packageJson.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    expect(packageJson.exports?.['./dsh']?.import).toBe('./dist/dsh-plugin.js');
    expect(packageJson.exports?.['./client']?.default).toBe('./dist/client.js');
    expect(packageJson.exports?.['./client']?.types).toBe('./dist/client.d.ts');
    expect(packageJson.dsh?.client).toMatchObject({
      platform: 'web',
      inject: expect.arrayContaining([
        '@deepseek-ai/dsh-client-ui-conversation',
      ]),
    });
    expect(packageJson.files).toContain('cordis.patch.yml');
    expect(patch).toContain("name: '@dsh/browser-bridge'");
  });
});
