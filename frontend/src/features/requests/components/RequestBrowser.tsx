'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { MAX_LIST_PAGE } from '@/lib/api/requests';
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

/** 연속 토글을 묶어 마지막 선택 상태로 URL을 한 번만 갱신하는 대기 시간. */
const CATEGORY_DEBOUNCE_MS = 300;

export function RequestBrowser({ items, total, page, pageSize, categories }: RequestBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlCategories = categories.filter((category) => searchParams.getAll('category').includes(category));
  const urlCategoriesKey = urlCategories.join('\u0000');
  // RSC 응답 전에는 searchParams가 갱신되지 않으므로 선택 상태는 로컬에서 낙관적으로 관리한다.
  const [selectedCategories, setSelectedCategories] = useState(urlCategories);
  const selectedRef = useRef(selectedCategories);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openOnly = searchParams.get('status') === 'open';
  const sortParam = searchParams.get('sort') as RequestSort | null;
  const sort = sortParam && validSorts.includes(sortParam) ? sortParam : 'latest';
  const query = searchParams.get('q') ?? '';

  const hasActiveFilters = Boolean(selectedCategories.length > 0 || openOnly || query.trim());
  // 백엔드/SSR이 MAX_LIST_PAGE로 page를 제한하므로 UI도 같은 상한을 넘지 않게 한다.
  const totalPages = Math.min(MAX_LIST_PAGE, Math.max(1, Math.ceil(total / pageSize)));

  // 뒤로가기 등 외부 요인으로 URL이 바뀌면 로컬 선택 상태를 맞춘다. 대기 중인 토글이 있으면 덮어쓰지 않는다.
  useEffect(() => {
    if (timerRef.current !== null) return;
    if (selectedRef.current.join('\u0000') === urlCategoriesKey) return;
    selectedRef.current = urlCategories;
    setSelectedCategories(urlCategories);
    // urlCategories는 urlCategoriesKey에서 파생되므로 키만 의존성으로 둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCategoriesKey]);

  useEffect(() => clearPendingCategories, []); // eslint-disable-line react-hooks/exhaustive-deps

  function clearPendingCategories() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  // 대기 중인 카테고리 선택까지 반영한 현재 URL 파라미터를 만든다.
  function currentParams() {
    const params = new URLSearchParams(searchParams.toString());
    // 선택이 URL과 같으면 기존 파라미터 순서를 그대로 둔다.
    if (selectedRef.current.join('\u0000') === urlCategoriesKey) return params;
    params.delete('category');
    // categories(정의 순서) 기준으로 정렬해 같은 선택이면 항상 같은 URL이 되게 한다.
    categories
      .filter((category) => selectedRef.current.includes(category))
      .forEach((category) => params.append('category', category));
    return params;
  }

  function replaceWith(params: URLSearchParams) {
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }

  function updateParam(key: 'status' | 'sort', value: string) {
    clearPendingCategories();
    const params = currentParams();
    if (value && !(key === 'sort' && value === 'latest')) params.set(key, value);
    else params.delete(key);
    params.delete('page');
    replaceWith(params);
  }

  function setCategories(next: string[]) {
    selectedRef.current = next;
    setSelectedCategories(next);
  }

  function commitCategories() {
    clearPendingCategories();
    const params = currentParams();
    params.delete('page');
    replaceWith(params);
  }

  function toggleCategory(category: string) {
    setCategories(
      selectedRef.current.includes(category)
        ? selectedRef.current.filter((selected) => selected !== category)
        : [...selectedRef.current, category],
    );
    clearPendingCategories();
    timerRef.current = setTimeout(commitCategories, CATEGORY_DEBOUNCE_MS);
  }

  function clearCategories() {
    setCategories([]);
    commitCategories();
  }

  function goToPage(nextPage: number) {
    clearPendingCategories();
    const params = currentParams();
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    const nextQuery = params.toString();
    router.push(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }

  return (
    <>
      <RequestFilterBar
        categories={categories}
        selectedCategories={selectedCategories}
        openOnly={openOnly}
        sort={sort}
        resultCount={total}
        onCategoryToggle={toggleCategory}
        onCategoryClear={clearCategories}
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
