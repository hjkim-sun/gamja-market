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
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

export type ApiErrorFields = Partial<Record<string, string>>;

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
