'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';

import { HeaderAuth } from '@/features/auth/components/HeaderAuth';

export function Header() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const [search, setSearch] = useState(query);

  useEffect(() => {
    setSearch(query);
  }, [query]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const normalizedSearch = search.trim();

    if (normalizedSearch) params.set('q', normalizedSearch);
    else params.delete('q');

    const nextQuery = params.toString();
    router.push(nextQuery ? `/?${nextQuery}` : '/');
  }

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-[#fbfaf7]/95 backdrop-blur">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:px-6 lg:grid-cols-[auto_minmax(280px,560px)_auto] lg:gap-8">
        <Link
          href="/"
          className="flex items-center gap-2 text-xl font-black tracking-tight text-stone-900 focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-potato-500"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-potato-200" aria-hidden="true">
            🥔
          </span>
          감자마켓
        </Link>

        <form
          className="order-3 col-span-2 flex h-11 min-w-0 items-center rounded-xl border border-stone-300 bg-white px-3 focus-within:border-potato-400 focus-within:ring-2 focus-within:ring-potato-200 lg:order-none lg:col-span-1"
          role="search"
          onSubmit={handleSearch}
        >
          <span className="mr-2 text-stone-400" aria-hidden="true">
            ⌕
          </span>
          <label htmlFor="site-search" className="sr-only">
            구매요청 제목 검색
          </label>
          <input
            id="site-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="어떤 물건을 찾고 있나요?"
            className="min-w-0 flex-1 bg-transparent text-sm text-stone-800 outline-none placeholder:text-stone-400"
          />
          <button className="ml-2 text-sm font-bold text-stone-600" type="submit">
            검색
          </button>
        </form>

        <div className="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
          <HeaderAuth />
          <Link
            href="/requests/new"
            className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl bg-potato-400 px-3 py-2.5 text-sm font-bold text-stone-900 transition hover:bg-potato-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500 sm:px-4"
          >
            <span className="sm:hidden">등록</span>
            <span className="hidden sm:inline">구매요청 등록</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
