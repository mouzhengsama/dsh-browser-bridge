import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { BUILT_IN_ORIGINS } from '../src/links.js';
import { BridgeRuntime } from '../src/runtime.js';

describe('BridgeRuntime CORS origins', () => {
  it('always includes exact built-in web agent origins', async () => {
    const config = defaultConfig();
    config.allowedOrigins = ['https://custom.example'];
    const runtime = new BridgeRuntime({
      config,
      secrets: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
      },
    });
    const snapshot = await runtime.getConfigSnapshot();

    expect(snapshot.allowedOrigins).toEqual(expect.arrayContaining([
      'https://custom.example',
      ...BUILT_IN_ORIGINS,
    ]));
    await runtime.dispose();
  });
});
