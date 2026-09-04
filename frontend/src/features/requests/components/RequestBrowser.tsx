'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

import type { PurchaseRequest } from '@/types/request';

import { RequestFilterBar, type RequestSort } from './RequestFilterBar';
import { RequestList } from './RequestList';

interface RequestBrowserProps {
  requests: PurchaseRequest[];
  categories: string[];
}

const validSorts: RequestSort[] = ['latest', 'price', 'applicants'];

export function RequestBrowser({ requests, categories }: RequestBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedCategory = searchParams.get('category') ?? '';
  const openOnly = searchParams.get('status') === 'open';
  const sortParam = searchParams.get('sort') as RequestSort | null;
  const sort = sortParam && validSorts.includes(sortParam) ? sortParam : 'latest';
  const query = (searchParams.get('q') ?? '').trim().toLocaleLowerCase('ko-KR');

  const filteredRequests = useMemo(() => {
    const nextRequests = requests.filter((request) => {
      const matchesCategory = !selectedCategory || request.category === selectedCategory;
      const matchesStatus = !openOnly || request.status === 'open';
      const matchesQuery = !query || request.title.toLocaleLowerCase('ko-KR').includes(query);
      return matchesCategory && matchesStatus && matchesQuery;
    });

    return [...nextRequests].sort((a, b) => {
      if (sort === 'price') return b.priceMax - a.priceMax;
      if (sort === 'applicants') return b.applicantCount - a.applicantCount;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [openOnly, query, requests, selectedCategory, sort]);

  function updateParam(key: 'category' | 'status' | 'sort', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && !(key === 'sort' && value === 'latest')) params.set(key, value);
    else params.delete(key);
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }

  return (
    <>
      <RequestFilterBar
        categories={categories}
        selectedCategory={selectedCategory}
        openOnly={openOnly}
        sort={sort}
        resultCount={filteredRequests.length}
        onCategoryChange={(category) => updateParam('category', category)}
        onOpenOnlyChange={(checked) => updateParam('status', checked ? 'open' : '')}
        onSortChange={(nextSort) => updateParam('sort', nextSort)}
      />
      <RequestList requests={filteredRequests} />
    </>
  );
}
