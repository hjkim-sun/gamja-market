import Link from 'next/link';

import type { PurchaseRequestSummary } from '@/types/request';

import { RequestCard } from './RequestCard';

interface RequestListProps {
  requests: PurchaseRequestSummary[];
  hasActiveFilters: boolean;
}

export function RequestList({ requests, hasActiveFilters }: RequestListProps) {
  if (requests.length === 0) {
    if (hasActiveFilters) {
      return (
        <div className="col-span-full rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-16 text-center">
          <div className="mb-4 text-4xl" aria-hidden="true">
            🥔
          </div>
          <p className="text-lg font-bold text-stone-800">조건에 맞는 구매요청이 없어요</p>
          <p className="mt-2 text-sm text-stone-500">검색어나 필터를 바꾸면 더 많은 요청을 볼 수 있어요.</p>
          <Link
            href="/"
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl border border-stone-300 bg-white px-4 text-sm font-bold text-stone-700 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500"
          >
            필터 초기화
          </Link>
        </div>
      );
    }

    return (
      <div className="col-span-full rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-16 text-center">
        <div className="mb-4 text-4xl" aria-hidden="true">
          🥔
        </div>
        <p className="text-lg font-bold text-stone-800">아직 등록된 구매요청이 없어요</p>
        <p className="mt-2 text-sm text-stone-500">첫 번째 구매요청을 등록해 보세요.</p>
        <Link
          href="/requests/new"
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-potato-400 px-4 text-sm font-bold text-stone-900 hover:bg-potato-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500"
        >
          구매요청 등록
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {requests.map((request) => (
        <RequestCard key={request.id} request={request} />
      ))}
    </div>
  );
}
