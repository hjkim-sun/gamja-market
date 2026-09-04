import type { Metadata } from 'next';

import { RequestForm } from '@/features/requests/components/RequestForm';

export const metadata: Metadata = {
  title: '구매요청 등록',
  description: '찾고 있는 물건과 원하는 거래 조건을 등록하세요.',
};

export default function NewRequestPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-9">
        <p className="text-sm font-black text-leaf-700">새 구매요청</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-stone-950 sm:text-4xl">어떤 물건을 찾고 있나요?</h1>
        <p className="mt-3 text-base leading-7 text-stone-600">원하는 조건을 알려주면 판매자가 먼저 제안할 수 있어요.</p>
      </div>
      <RequestForm />
    </div>
  );
}
