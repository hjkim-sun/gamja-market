/**
 * 서버 컴포넌트는 상대 경로로 fetch할 수 없으므로 FastAPI의 절대 origin이 필요하다(설계서 3.4).
 * 로컬은 BACKEND_API_ORIGIN, Vercel은 서비스 바인딩 URL을 쓴다.
 */
export function resolveServerApiBase(): string | undefined {
  if (process.env.VERCEL === '1') {
    return process.env.BACKEND_SERVICE_ORIGIN?.trim() || undefined;
  }

  const origin = process.env.BACKEND_API_ORIGIN?.trim();
  return origin || undefined;
}
