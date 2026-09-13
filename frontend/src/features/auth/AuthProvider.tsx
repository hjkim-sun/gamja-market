'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import * as authApi from '@/lib/api/auth';
import { ApiError, type AuthUser, type LoginRequest, type SignupRequest } from '@/types/auth';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** 복원 실패(통신/5xx) 안내. 401은 오류가 아니라 anonymous다. */
  error: string | null;
  refresh: () => Promise<void>;
  signup: (payload: SignupRequest) => Promise<AuthUser>;
  login: (payload: LoginRequest) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

export const RESTORE_ERROR_MESSAGE = '로그인 상태를 확인할 수 없습니다.';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 요청 세대 번호. /me 복원과 로그인/로그아웃 응답이 역전되어도
   * 최신 세대가 아닌 응답은 상태에 반영하지 않는다.
   */
  const generationRef = useRef(0);

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrent = useCallback((generation: number) => generationRef.current === generation, []);

  const applyUser = useCallback((nextUser: AuthUser) => {
    setUser(nextUser);
    setStatus('authenticated');
    setError(null);
  }, []);

  /** 쿠키 기준으로 현재 회원을 다시 확인한다. 401은 anonymous, 그 밖의 실패는 error다. */
  const restore = useCallback(
    async (signal?: AbortSignal) => {
      const generation = nextGeneration();

      try {
        const nextUser = await authApi.me(signal);
        if (signal?.aborted || !isCurrent(generation)) return;
        applyUser(nextUser);
      } catch (caught) {
        if (signal?.aborted || !isCurrent(generation)) return;

        if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
          setUser(null);
          setStatus('anonymous');
          setError(null);
          return;
        }

        // 통신 실패와 5xx는 비로그인으로 단정하지 않는다.
        setStatus('error');
        setError(RESTORE_ERROR_MESSAGE);
      }
    },
    [applyUser, isCurrent, nextGeneration],
  );

  useEffect(() => {
    const controller = new AbortController();
    void restore(controller.signal);
    // StrictMode의 effect 재실행에서도 앞선 복원 요청을 정리한다.
    return () => controller.abort();
  }, [restore]);

  useEffect(() => {
    // 다른 탭의 로그아웃·세션 만료를 반영한다. 고정 주기 폴링은 만들지 않는다.
    function handleRevalidate() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void restore();
    }

    window.addEventListener('focus', handleRevalidate);
    document.addEventListener('visibilitychange', handleRevalidate);
    return () => {
      window.removeEventListener('focus', handleRevalidate);
      document.removeEventListener('visibilitychange', handleRevalidate);
    };
  }, [restore]);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    await restore();
  }, [restore]);

  /** 성공 응답으로 즉시 상태를 갱신한다. 실패는 기존 인증 상태를 덮어쓰지 않고 그대로 던진다. */
  const runAuthRequest = useCallback(
    async (call: () => Promise<AuthUser>) => {
      const generation = nextGeneration();
      const nextUser = await call();
      if (isCurrent(generation)) applyUser(nextUser);
      return nextUser;
    },
    [applyUser, isCurrent, nextGeneration],
  );

  const signup = useCallback(
    (payload: SignupRequest) => runAuthRequest(() => authApi.signup(payload)),
    [runAuthRequest],
  );

  const login = useCallback(
    (payload: LoginRequest) => runAuthRequest(() => authApi.login(payload)),
    [runAuthRequest],
  );

  const logout = useCallback(async () => {
    const generation = nextGeneration();
    // 실패 시 사용자 상태를 유지한다. 호출자가 재시도 안내를 보여준다.
    await authApi.logout();
    if (!isCurrent(generation)) return;
    setUser(null);
    setStatus('anonymous');
    setError(null);
  }, [isCurrent, nextGeneration]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, error, refresh, signup, login, logout }),
    [status, user, error, refresh, signup, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth는 AuthProvider 내부에서만 사용할 수 있습니다.');
  return context;
}
