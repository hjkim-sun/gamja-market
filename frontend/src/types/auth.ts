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

/** 계약의 fields 허용 키. 필드 오류가 없으면 빈 객체다. */
export type AuthFieldName = 'email' | 'password' | 'password_confirmation';

// types/api.ts로 이동. 기존 import 경로(@/types/auth)를 보존하기 위해 re-export한다.
export { ApiError, type ApiErrorBody, type ApiErrorCode, type ApiErrorFields } from '@/types/api';
