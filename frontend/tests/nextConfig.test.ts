import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config';

describe('Next 보안 헤더 설정', () => {
  it('모든 경로에서 framing을 금지하고 기존 rewrite 동작을 보존한다', async () => {
    if (!nextConfig.headers) throw new Error('미구현: CSP frame-ancestors 및 X-Frame-Options 헤더');
    const rules = await nextConfig.headers();
    const all = rules?.find((rule) => rule.source === '/:path*');
    expect(all).toBeDefined();
    const headers = Object.fromEntries((all?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(typeof nextConfig.rewrites).toBe('function');
  });
});
