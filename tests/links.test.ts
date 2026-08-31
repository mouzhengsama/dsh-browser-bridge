import { describe, expect, it } from 'vitest';
import { BUILT_IN_LINKS, BUILT_IN_ORIGINS } from '../src/links.js';

describe('built-in links', () => {
  it('uses unique HTTPS origins suitable for exact CORS matching', () => {
    expect(BUILT_IN_LINKS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(BUILT_IN_LINKS.map(link => link.id)).size).toBe(BUILT_IN_LINKS.length);
    for (const link of BUILT_IN_LINKS) {
      expect(new URL(link.url).protocol).toBe('https:');
    }
    expect(new Set(BUILT_IN_ORIGINS).size).toBe(BUILT_IN_ORIGINS.length);
  });

  it('covers domestic and international web agents and Kimi redirects', () => {
    expect(BUILT_IN_ORIGINS).toEqual(expect.arrayContaining([
      'https://chatgpt.com',
      'https://workbuddy.cn',
      'https://doubao.com',
      'https://chat.deepseek.com',
      'https://hunyuan.tencent.com',
      'https://kimi.moonshot.cn',
      'https://www.kimi.com',
    ]));
  });
});
