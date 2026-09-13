import type { Metadata } from 'next';

import { GuestOnly } from '@/features/auth/components/GuestOnly';
import { LoginForm } from '@/features/auth/components/LoginForm';

export const metadata: Metadata = {
  title: '로그인',
  description: '가입한 이메일과 비밀번호로 로그인하세요.',
};

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8">
        <h1 className="text-3xl font-black tracking-tight text-stone-950">로그인</h1>
        <p className="mt-3 text-base leading-7 text-stone-600">
          감자마켓 계정으로 구매요청을 관리하세요.
        </p>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card sm:p-8">
        <GuestOnly>
          <LoginForm />
        </GuestOnly>
      </div>
    </div>
  );
}
