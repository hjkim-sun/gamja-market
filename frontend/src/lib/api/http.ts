import { ApiError, type ApiErrorBody, type ApiErrorCode, type ApiErrorFields } from '@/types/api';

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
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
  'SELF_APPLICATION_FORBIDDEN',
  'REQUEST_NOT_OPEN',
  'ALREADY_APPLIED',
  'PAYLOAD_TOO_LARGE',
  'INVALID_IMAGE',
  'PHOTO_LIMIT_EXCEEDED',
  'PHOTO_STORAGE_UNAVAILABLE',
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFields(value: unknown, allowedKeys: readonly string[]): ApiErrorFields {
  if (!isRecord(value)) return {};

  const fields: ApiErrorFields = {};
  for (const key of allowedKeys) {
    const message = value[key];
    if (typeof message === 'string' && message) fields[key] = message;
  }
  return fields;
}

/** 상태 코드만으로 code를 추정한다. 계약 본문이 없거나 깨진 응답의 대비책이다. */
export function fallbackCode(status: number): ApiErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'INVALID_ORIGIN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'EMAIL_ALREADY_EXISTS';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

export async function toApiError(
  response: Response,
  allowedFieldKeys: readonly string[],
): Promise<ApiError> {
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
    fields: parseFields(isRecord(error) ? error.fields : undefined, allowedFieldKeys),
  });
}

export function networkError(): ApiError {
  return new ApiError({
    code: 'NETWORK_ERROR',
    message: NETWORK_ERROR_MESSAGE,
    status: 0,
  });
}

export function internalError(status: number): ApiError {
  return new ApiError({
    code: 'INTERNAL_ERROR',
    message: UNKNOWN_ERROR_MESSAGE,
    status,
  });
}

/**
 * 브라우저는 백엔드 주소를 직접 호출하지 않는다. 동일 출처 상대 경로로만 호출하고
 * next.config.ts의 rewrite가 FastAPI로 전달한다. 서버 컴포넌트에서는 baseUrl로
 * 절대 URL을 지정한다(설계서 3.4).
 */
export async function request(
  path: string,
  init: RequestInit,
  baseUrl = '',
): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    // 통신 자체가 실패한 경우다. 응답 본문이 없으므로 계약 오류와 구분한다.
    throw networkError();
  }
}

const REQUESTED_WITH = 'gamja-market';

export function postInit(body: unknown, signal?: AbortSignal): RequestInit {
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
