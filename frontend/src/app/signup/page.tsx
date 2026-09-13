import type { Metadata } from 'next';

import { GuestOnly } from '@/features/auth/components/GuestOnly';
import { SignupForm } from '@/features/auth/components/SignupForm';

export const metadata: Metadata = {
  title: '회원가입',
  description: '이메일과 비밀번호로 감자마켓 회원이 되세요.',
};

export default function SignupPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8">
        <h1 className="text-3xl font-black tracking-tight text-stone-950">회원가입</h1>
        <p className="mt-3 text-base leading-7 text-stone-600">
          이메일과 비밀번호만 입력하면 바로 시작할 수 있어요.
        </p>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card sm:p-8">
        <GuestOnly>
          <SignupForm />
        </GuestOnly>
      </div>
    </div>
  );
}
