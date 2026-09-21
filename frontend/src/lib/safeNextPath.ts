/**
 * `next` 쿼리 파라미터가 앱 내부 상대 경로일 때만 그 경로를 신뢰한다.
 * `/`로 시작하지 않거나 `//`로 시작하면(스킴 상대 URL) 오픈 리다이렉트가 되므로 거부한다.
 */
export function resolveSafeNextPath(next: string | null | undefined): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}
