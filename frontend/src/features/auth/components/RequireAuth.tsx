'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * 인증이 필요한 라우트를 게이트한다. GuestOnly를 뒤집은 형태다(설계서 5.4).
 * 비로그인이면 next 파라미터를 보존해 /login으로 보낸다.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { status, error, refresh } = useAuth();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login?next=/requests/new');
  }, [status, router]);

  if (status === 'loading') {
    return (
      <p className="text-sm text-stone-500" role="status">
        로그인 상태를 확인하고 있어요…
      </p>
    );
  }

  if (status === 'anonymous') return null;

  if (status === 'error') {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5" role="alert">
        <p className="font-bold text-red-700">{error ?? '로그인 상태를 확인할 수 없습니다.'}</p>
        <Button type="button" variant="secondary" className="mt-4" onClick={() => void refresh()}>
          다시 시도
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
