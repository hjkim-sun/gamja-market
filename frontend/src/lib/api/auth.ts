import {
  ApiError,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiErrorFields,
  type AuthResponse,
  type AuthUser,
  type LoginRequest,
  type SignupRequest,
} from '@/types/auth';

/**
 * 브라우저는 백엔드 주소를 직접 호출하지 않는다. 동일 출처 상대 경로로만 호출하고
 * next.config.ts의 rewrite가 FastAPI로 전달한다.
 */
const AUTH_BASE = '/api/auth';

/** 상태 변경 POST에 붙이는 사용자 정의 헤더. FastAPI가 Origin과 함께 검사한다. */
const REQUESTED_WITH = 'gamja-market';

const NETWORK_ERROR_MESSAGE = '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
const UNKNOWN_ERROR_MESSAGE = '잠시 후 다시 시도해 주세요.';

const KNOWN_ERROR_CODES: readonly ApiErrorCode[] = [
  'VALIDATION_ERROR',
  'PASSWORD_MISMATCH',
  'EMAIL_ALREADY_EXISTS',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'INVALID_ORIGIN',
  'UNSUPPORTED_MEDIA_TYPE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
];

const ALLOWED_FIELD_KEYS = ['email', 'password', 'password_confirmation'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFields(value: unknown): ApiErrorFields {
  if (!isRecord(value)) return {};

  const fields: ApiErrorFields = {};
  for (const key of ALLOWED_FIELD_KEYS) {
    const message = value[key];
    if (typeof message === 'string' && message) fields[key] = message;
  }
  return fields;
}

/** 상태 코드만으로 code를 추정한다. 계약 본문이 없거나 깨진 응답의 대비책이다. */
function fallbackCode(status: number): ApiErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'INVALID_ORIGIN';
  if (status === 409) return 'EMAIL_ALREADY_EXISTS';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const error = isRecord(body) ? (body as Partial<ApiErrorBody>).error : undefined;
  const rawCode = isRecord(error) ? error.code : undefined;
  const code = KNOWN_ERROR_CODES.includes(rawCode as ApiErrorCode)
    ? (rawCode as ApiErrorCode)
    : fallbackCode(response.status);
  const rawMessage = isRecord(error) ? error.message : undefined;
  const message = typeof rawMessage === 'string' && rawMessage ? rawMessage : UNKNOWN_ERROR_MESSAGE;

  return new ApiError({
    code,
    message,
    status: response.status,
    fields: parseFields(isRecord(error) ? error.fields : undefined),
  });
}

function networkError(): ApiError {
  return new ApiError({
    code: 'NETWORK_ERROR',
    message: NETWORK_ERROR_MESSAGE,
    status: 0,
  });
}

async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${AUTH_BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    // 통신 자체가 실패한 경우다. 응답 본문이 없으므로 계약 오류와 구분한다.
    throw networkError();
  }
}

function postInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': REQUESTED_WITH,
    },
    body: JSON.stringify(body),
    signal,
  };
}

async function readUser(response: Response): Promise<AuthUser> {
  if (!response.ok) throw await toApiError(response);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: UNKNOWN_ERROR_MESSAGE,
      status: response.status,
    });
  }

  const user = isRecord(body) ? (body as Partial<AuthResponse>).user : undefined;
  if (!isRecord(user) || typeof user.id !== 'string' || typeof user.email !== 'string') {
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: UNKNOWN_ERROR_MESSAGE,
      status: response.status,
    });
  }

  return { id: user.id, email: user.email };
}

/** 가입은 세 필드를 그대로 보낸다. 비밀번호 원문은 요청 외부에 보관하지 않는다. */
export async function signup(payload: SignupRequest, signal?: AbortSignal): Promise<AuthUser> {
  return readUser(await request('/signup', postInit(payload, signal)));
}

/** 로그인은 확인값을 보내지 않는다. 추가 필드는 서버에서 422다. */
export async function login(payload: LoginRequest, signal?: AbortSignal): Promise<AuthUser> {
  return readUser(await request('/login', postInit(payload, signal)));
}

export async function me(signal?: AbortSignal): Promise<AuthUser> {
  return readUser(await request('/me', { method: 'GET', signal }));
}

/** 204는 본문이 없으므로 JSON으로 읽지 않는다. */
export async function logout(signal?: AbortSignal): Promise<void> {
  const response = await request('/logout', postInit({}, signal));
  if (!response.ok) throw await toApiError(response);
}
