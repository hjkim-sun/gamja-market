import { describe, expect, it } from 'vitest';

import { resolveSafeNextPath } from '@/lib/safeNextPath';

describe('로그인 next 경로 방어', () => {
  it.each([
    '/\\evil.example',
    decodeURIComponent('/%5Cevil.example'),
    '//evil.example',
    '/\t/evil.example',
    decodeURIComponent('/%0a/evil'),
    'javascript:alert(1)',
    'https://evil.example',
    '',
    null,
  ])('우회 입력 %s 를 루트로 보낸다', (input) => {
    expect(resolveSafeNextPath(input)).toBe('/');
  });

  it.each([
    ['/chats/123?tab=x#m', '/chats/123?tab=x#m'],
    ['/requests/new', '/requests/new'],
    ['/a/../b', '/b'],
  ])('안전한 경로 %s 를 보존하거나 정규화한다', (input, expected) => {
    expect(resolveSafeNextPath(input)).toBe(expected);
  });
});
