/**
 * `next` 쿼리 파라미터가 앱 내부 상대 경로일 때만 그 경로를 신뢰한다.
 * 스킴 상대 URL(`//`), 역슬래시, 제어 문자(탭·개행은 URL 파서가 지워 `//`가 된다)는
 * 오픈 리다이렉트가 되므로 거부하고, 통과한 값도 같은 origin으로 파싱되는지 확인한 뒤
 * 정규화한 경로로 다시 조립한다.
 */
const PARSE_BASE = 'http://gamja.invalid';

export function resolveSafeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  if (next.includes('\\') || /[\u0000-\u001F\u007F]/.test(next)) return '/';

  let url: URL;
  try {
    url = new URL(next, PARSE_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== PARSE_BASE) return '/';

  // `/a/..//evil`처럼 정규화 결과가 `//`로 시작하면 다시 스킴 상대 URL이 된다.
  if (url.pathname.startsWith('//')) return '/';

  return `${url.pathname}${url.search}${url.hash}`;
}
