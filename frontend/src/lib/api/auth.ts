import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type { AuthResponse, AuthUser, LoginRequest, SignupRequest } from '@/types/auth';

/**
 * 브라우저는 백엔드 주소를 직접 호출하지 않는다. 동일 출처 상대 경로로만 호출하고
 * next.config.ts의 rewrite가 FastAPI로 전달한다.
 */
const AUTH_BASE = '/api/auth';

const ALLOWED_FIELD_KEYS = ['email', 'password', 'password_confirmation'] as const;

async function readUser(response: Response): Promise<AuthUser> {
  if (!response.ok) throw await toApiError(response, ALLOWED_FIELD_KEYS);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  const user = isRecord(body) ? (body as Partial<AuthResponse>).user : undefined;
  if (!isRecord(user) || typeof user.id !== 'string' || typeof user.email !== 'string') {
    throw internalError(response.status);
  }

  return { id: user.id, email: user.email };
}

/** 가입은 세 필드를 그대로 보낸다. 비밀번호 원문은 요청 외부에 보관하지 않는다. */
export async function signup(payload: SignupRequest, signal?: AbortSignal): Promise<AuthUser> {
  return readUser(await request('/signup', postInit(payload, signal), AUTH_BASE));
}

/** 로그인은 확인값을 보내지 않는다. 추가 필드는 서버에서 422다. */
export async function login(payload: LoginRequest, signal?: AbortSignal): Promise<AuthUser> {
  return readUser(await request('/login', postInit(payload, signal), AUTH_BASE));
}

export async function me(signal?: AbortSignal): Promise<AuthUser> {
  return readUser(await request('/me', { method: 'GET', signal }, AUTH_BASE));
}

/** 204는 본문이 없으므로 JSON으로 읽지 않는다. */
export async function logout(signal?: AbortSignal): Promise<void> {
  const response = await request('/logout', postInit({}, signal), AUTH_BASE);
  if (!response.ok) throw await toApiError(response, ALLOWED_FIELD_KEYS);
}
