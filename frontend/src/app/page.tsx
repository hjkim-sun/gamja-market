import { Suspense } from 'react';
import { headers } from 'next/headers';

import { requestCategories } from '@/features/requests/categories';
import { RequestBrowser } from '@/features/requests/components/RequestBrowser';
import { listRequests } from '@/lib/api/requests';
import { resolveServerApiBase } from '@/lib/api/serverBase';

export const dynamic = 'force-dynamic';

function RequestBrowserFallback() {
  return <div className="h-96 animate-pulse rounded-2xl border border-stone-200 bg-white" aria-label="구매요청 불러오는 중" />;
}

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function RequestBrowserSection({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const cookie = (await headers()).get('cookie') ?? undefined;
  const page = Number(firstValue(params.page) ?? '1');

  const { items, total, page: currentPage, pageSize } = await listRequests(
    {
      q: firstValue(params.q),
      category: firstValue(params.category),
      status: firstValue(params.status),
      sort: firstValue(params.sort) as 'latest' | 'price' | 'applicants' | undefined,
      page: Number.isFinite(page) && page > 0 ? page : 1,
    },
    { baseUrl: resolveServerApiBase(), cookie },
  );

  return (
    <RequestBrowser
      items={items}
      total={total}
      page={currentPage}
      pageSize={pageSize}
      categories={requestCategories}
    />
  );
}

export default function HomePage({ searchParams }: HomePageProps) {
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
        <RequestBrowserSection searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
