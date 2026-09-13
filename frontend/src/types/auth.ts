export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResponse {
  user: AuthUser;
}

export interface SignupRequest {
  email: string;
  password: string;
  password_confirmation: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** 설계서 4.2/4.3의 오류 code. 프론트는 message 문자열이 아니라 code로 분기한다. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'PASSWORD_MISMATCH'
  | 'EMAIL_ALREADY_EXISTS'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'INVALID_ORIGIN'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

/** 계약의 fields 허용 키. 필드 오류가 없으면 빈 객체다. */
export type AuthFieldName = 'email' | 'password' | 'password_confirmation';

export type ApiErrorFields = Partial<Record<AuthFieldName, string>>;

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields: ApiErrorFields;
  };
}

/** fetch 실패와 계약 오류 응답을 동일한 형태로 다루기 위한 오류 객체. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly fields: ApiErrorFields;

  constructor({
    code,
    message,
    status,
    fields = {},
  }: {
    code: ApiErrorCode;
    message: string;
    status: number;
    fields?: ApiErrorFields;
  }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}
