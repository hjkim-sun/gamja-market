'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { useAuth } from '@/features/auth/AuthProvider';

const authLinkClassName =
  'inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl px-2 py-2.5 text-sm font-bold text-stone-600 transition hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-500 sm:px-3';

export function HeaderAuth() {
  const { status, user, error, authRouteMissing, refresh, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);

    try {
      await logout();
    } catch {
      // 실패 시 사용자 상태를 유지하고 재시도 안내만 보여준다.
      setLogoutError('로그아웃에 실패했어요. 다시 시도해 주세요.');
    } finally {
      setLoggingOut(false);
    }
  }

  if (status === 'loading') {
    return (
      <span className="text-xs text-stone-400" role="status">
        확인 중…
      </span>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-0.5 sm:gap-1">
        <span className="hidden truncate text-xs text-stone-500 sm:inline" role="alert">
          {error ?? '로그인 상태를 확인할 수 없습니다.'}
        </span>
        {user === null && authRouteMissing ? (
          <>
            <Link href="/login" className={authLinkClassName}>
              로그인
            </Link>
            <Link href="/signup" className={authLinkClassName}>
              회원가입
            </Link>
          </>
        ) : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          다시 시도
        </Button>
      </div>
    );
  }

  if (status === 'authenticated' && user) {
    return (
      <div className="flex min-w-0 flex-col items-end">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <span
            className="hidden min-w-0 max-w-[9rem] truncate text-sm font-semibold text-stone-700 md:inline lg:max-w-[12rem]"
            title={user.email}
          >
            {user.email}
          </span>
          <Button variant="ghost" onClick={() => void handleLogout()} disabled={loggingOut}>
            {loggingOut ? '처리 중…' : '로그아웃'}
          </Button>
        </div>
        {logoutError ? (
          <span className="max-w-[12rem] text-right text-xs font-semibold text-red-600" role="alert">
            {logoutError}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5 sm:gap-1">
      <Link href="/login" className={authLinkClassName}>
        로그인
      </Link>
      <Link href="/signup" className={authLinkClassName}>
        회원가입
      </Link>
    </div>
  );
}
