import { Suspense } from 'react';

import { RequestBrowser } from '@/features/requests/components/RequestBrowser';
import { mockRequests, requestCategories } from '@/lib/mock/requests';

function RequestBrowserFallback() {
  return <div className="h-96 animate-pulse rounded-2xl border border-stone-200 bg-white" aria-label="구매요청 불러오는 중" />;
}

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6 sm:py-14">
      <section className="mb-9 max-w-3xl">
        <p className="mb-3 text-sm font-black text-leaf-700">BUYER FIRST MARKET</p>
        <h1 className="break-keep text-3xl font-black leading-tight tracking-tight text-stone-950 sm:text-5xl">
          사고 싶은 물건을 올리면,
          <br />
          <span className="text-potato-600">판매자가 찾아옵니다.</span>
        </h1>
        <p className="mt-5 break-keep text-base leading-7 text-stone-600 sm:text-lg">
          원하는 스펙과 가격을 먼저 알려주세요. 가지고 있는 판매자들이 직접 제안할 거예요.
        </p>
      </section>

      <Suspense fallback={<RequestBrowserFallback />}>
        <RequestBrowser requests={mockRequests} categories={requestCategories} />
      </Suspense>
    </div>
  );
}
