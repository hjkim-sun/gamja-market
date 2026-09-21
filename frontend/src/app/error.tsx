'use client';

import { Button } from '@/components/ui/Button';

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/** 서버 컴포넌트에서 던져진 예외의 최후 방어선. 목업으로 대체하지 않는다(설계서 6.3). */
export default function AppError({ reset }: AppErrorProps) {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center" role="alert">
        <p className="font-bold text-red-700">데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
        <Button type="button" variant="secondary" className="mt-4" onClick={reset}>
          다시 시도
        </Button>
      </div>
    </div>
  );
}
