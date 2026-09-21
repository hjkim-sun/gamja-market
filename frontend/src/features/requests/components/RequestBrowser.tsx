'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import type { PurchaseRequestSummary } from '@/types/request';

import { RequestFilterBar, type RequestSort } from './RequestFilterBar';
import { RequestList } from './RequestList';

interface RequestBrowserProps {
  items: PurchaseRequestSummary[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
}

const validSorts: RequestSort[] = ['latest', 'price', 'applicants'];

export function RequestBrowser({ items, total, page, pageSize, categories }: RequestBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedCategory = searchParams.get('category') ?? '';
  const openOnly = searchParams.get('status') === 'open';
  const sortParam = searchParams.get('sort') as RequestSort | null;
  const sort = sortParam && validSorts.includes(sortParam) ? sortParam : 'latest';
  const query = searchParams.get('q') ?? '';

  const hasActiveFilters = Boolean(selectedCategory || openOnly || query.trim());
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function updateParam(key: 'category' | 'status' | 'sort', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && !(key === 'sort' && value === 'latest')) params.set(key, value);
    else params.delete(key);
    params.delete('page');
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }

  function goToPage(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    const nextQuery = params.toString();
    router.push(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }

  return (
    <>
      <RequestFilterBar
        categories={categories}
        selectedCategory={selectedCategory}
        openOnly={openOnly}
        sort={sort}
        resultCount={total}
        onCategoryChange={(category) => updateParam('category', category)}
        onOpenOnlyChange={(checked) => updateParam('status', checked ? 'open' : '')}
        onSortChange={(nextSort) => updateParam('sort', nextSort)}
      />
      <RequestList requests={items} hasActiveFilters={hasActiveFilters} />
      {total > pageSize ? (
        <nav className="mt-8 flex items-center justify-center gap-3" aria-label="페이지네이션">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
            className="min-h-10 rounded-lg border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            이전
          </button>
          <span className="text-sm text-stone-500">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => goToPage(page + 1)}
            className="min-h-10 rounded-lg border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            다음
          </button>
        </nav>
      ) : null}
    </>
  );
}
