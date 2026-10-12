'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { RatingStars } from '@/features/reviews/components/RatingStars';
import { getTransactionReviews } from '@/lib/api/reviews';
import { formatDateTime } from '@/lib/format';
import type { ReviewerRole, TransactionReviews } from '@/types/review';

interface PublicReviewListProps {
  requestId: string;
  /** SSR로 받은 후기. 실패했으면 null이며 마운트 시 브라우저에서 한 번 다시 조회한다. */
  initial: TransactionReviews | null;
  id?: string;
}

const roleLabels: Record<ReviewerRole, string> = {
  buyer: '구매자가 남긴 후기',
  seller: '판매자가 남긴 후기',
};

/** 설계서 11.9: 완료된 요청의 공개 후기. 익명을 포함한 모두에게 같은 목록을 보여 주며 작성자는 역할로만 표시한다. */
export function PublicReviewList({ requestId, initial, id = 'reviews' }: PublicReviewListProps) {
  const [data, setData] = useState<TransactionReviews | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [failed, setFailed] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);

    try {
      const reviews = await getTransactionReviews(requestId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setData(reviews);
      setFailed(false);
    } catch {
      if (controller.signal.aborted) return;
      setFailed(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [requestId]);

  // 요청이나 SSR 값이 바뀌면(router.refresh 포함) 이전 조회를 취소하고 상태를 처음부터 맞춘다.
  // SSR 값이 없을 때만 브라우저에서 1회 조회한다.
  useEffect(() => {
    controllerRef.current?.abort();
    setData(initial);
    setFailed(false);
    setLoading(initial === null);
    if (initial === null) void load();
    return () => controllerRef.current?.abort();
  }, [requestId, initial, load]);

  return (
    <section id={id} className="mt-10 scroll-mt-20" aria-labelledby={`${id}-heading`}>
      <p className="text-sm font-bold text-violet-700">거래 완료</p>
      <h2 id={`${id}-heading`} className="mt-1 text-2xl font-black text-stone-900">
        거래 후기
      </h2>

      {data === null ? (
        failed ? (
          <div className="mt-4 rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-8 text-center">
            <p className="font-bold text-stone-700" role="alert">
              후기를 불러오지 못했어요.
            </p>
            <Button variant="secondary" className="mt-4" onClick={() => void load()} disabled={loading}>
              {loading ? '불러오는 중…' : '다시 시도'}
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-sm text-stone-500" role="status">
            후기를 불러오는 중이에요.
          </p>
        )
      ) : data.items.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-8 text-center text-sm font-semibold text-stone-500">
          아직 등록된 후기가 없어요.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {data.items.map((review) => (
            <li key={review.reviewerRole} className="rounded-2xl border border-stone-200 bg-white p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-stone-900">{roleLabels[review.reviewerRole]}</p>
                <RatingStars rating={review.rating} />
              </div>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-stone-700">{review.body}</p>
              <time
                dateTime={review.createdAt}
                className="mt-3 block text-xs text-stone-400"
                suppressHydrationWarning
              >
                {formatDateTime(review.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
