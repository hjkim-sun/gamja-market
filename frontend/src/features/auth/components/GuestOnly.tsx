'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useAuth } from '@/features/auth/AuthProvider';

/**
 * 이미 인증된 상태로 /signup·/login에 접근하면 복원 완료 후 /로 보낸다.
 * 복원 중에는 폼을 깜빡이며 노출하지 않는다.
 */
export function GuestOnly({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  if (status === 'loading' || status === 'authenticated') {
    return (
      <p className="text-sm text-stone-500" role="status">
        로그인 상태를 확인하고 있어요…
      </p>
    );
  }

  return <>{children}</>;
}
