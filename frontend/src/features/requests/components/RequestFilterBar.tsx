'use client';

export type RequestSort = 'latest' | 'price' | 'applicants';

interface RequestFilterBarProps {
  categories: string[];
  selectedCategory: string;
  openOnly: boolean;
  sort: RequestSort;
  resultCount: number;
  onCategoryChange: (category: string) => void;
  onOpenOnlyChange: (openOnly: boolean) => void;
  onSortChange: (sort: RequestSort) => void;
}

export function RequestFilterBar({
  categories,
  selectedCategory,
  openOnly,
  sort,
  resultCount,
  onCategoryChange,
  onOpenOnlyChange,
  onSortChange,
}: RequestFilterBarProps) {
  return (
    <section className="mb-7 rounded-2xl border border-stone-200 bg-white p-4 shadow-card sm:p-5" aria-label="구매요청 필터">
      <div className="flex flex-col gap-5">
        <div>
          <p className="mb-2.5 text-xs font-bold uppercase tracking-wider text-stone-500">카테고리</p>
          <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="카테고리 선택">
            {['', ...categories].map((category) => {
              const selected = selectedCategory === category;
              return (
                <button
                  key={category || 'all'}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onCategoryChange(category)}
                  className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500 ${
                    selected
                      ? 'bg-stone-900 text-white'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                  }`}
                >
                  {category || '전체'}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-stone-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-stone-700">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(event) => onOpenOnlyChange(event.target.checked)}
              className="size-4 rounded border-stone-300 text-leaf-600 accent-leaf-600 focus:ring-leaf-500"
            />
            구해요만 보기
          </label>

          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <span className="text-sm text-stone-500">
              <strong className="text-stone-800">{resultCount}</strong>개의 요청
            </span>
            <label htmlFor="request-sort" className="sr-only">
              구매요청 정렬
            </label>
            <select
              id="request-sort"
              value={sort}
              onChange={(event) => onSortChange(event.target.value as RequestSort)}
              className="min-h-10 rounded-lg border border-stone-300 bg-white px-3 text-sm font-semibold text-stone-700 outline-none focus:border-potato-400 focus:ring-2 focus:ring-potato-200"
            >
              <option value="latest">최신순</option>
              <option value="price">희망가 높은순</option>
              <option value="applicants">지원자 많은순</option>
            </select>
          </div>
        </div>
      </div>
    </section>
  );
}
