'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { RatingStars } from '@/features/reviews/components/RatingStars';
import { createReview, getTransactionReviews } from '@/lib/api/reviews';
import { formatDateTime } from '@/lib/format';
import { ApiError } from '@/types/api';
import type { PublicReview, TransactionReviews } from '@/types/review';

interface ReviewPanelProps {
  requestId: string;
  roomId: string;
  /** SSR로 받은 후기 조회 결과. null이면 마운트 시 한 번 조회한다. */
  initial: TransactionReviews | null;
}

const RATINGS = [1, 2, 3, 4, 5] as const;
const MIN_BODY_LENGTH = 2;
const MAX_BODY_LENGTH = 500;
const RETRY_MESSAGE = '잠시 후 다시 시도해 주세요.';

function ReviewCard({ title, review }: { title: string; review: PublicReview }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-black text-stone-900">{title}</h3>
        <RatingStars rating={review.rating} />
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-stone-700">{review.body}</p>
      <time dateTime={review.createdAt} className="mt-3 block text-xs text-stone-400" suppressHydrationWarning>
        {formatDateTime(review.createdAt)}
      </time>
    </div>
  );
}

/** 설계서 11.6: 완료된 확정 채팅방의 참여자용 패널(작성·내 후기·받은 후기). 공개 목록은 PublicReviewList가 맡는다. */
export function ReviewPanel({ requestId, roomId, initial }: ReviewPanelProps) {
  const router = useRouter();
  const [data, setData] = useState<TransactionReviews | null>(initial);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(initial === null);
  const [rating, setRating] = useState<number | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const load = useCallback(async (): Promise<TransactionReviews | null> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);

    try {
      const reviews = await getTransactionReviews(requestId, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      setData(reviews);
      setLoadFailed(false);
      return reviews;
    } catch {
      if (!controller.signal.aborted) setLoadFailed(true);
      return null;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [requestId]);

  // 요청이나 SSR 값이 바뀌면(router.refresh 포함) 이전 조회를 취소하고 서버 값을 따른다.
  // SSR 값이 없을 때만 브라우저에서 1회 조회한다.
  useEffect(() => {
    controllerRef.current?.abort();
    setData(initial);
    setLoadFailed(false);
    setLoading(initial === null);
    if (initial === null) void load();
  }, [requestId, initial, load]);

  const trimmed = body.trim();
  const canSubmit = rating !== null && trimmed.length >= MIN_BODY_LENGTH && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || rating === null || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setRatingError(null);
    setBodyError(null);
    setFormError(null);
    setNotice(null);

    try {
      const { review } = await createReview(requestId, { rating, body: trimmed });
      if (!mountedRef.current) return;
      // 공개 후기 형태로만 보관한다(후기 id는 화면에 쓰지 않는다).
      const mine: PublicReview = {
        reviewerRole: review.reviewerRole,
        rating: review.rating,
        body: review.body,
        createdAt: review.createdAt,
      };
      setData((current) => (current ? { ...current, canWrite: false, mine } : current));
    } catch (caught) {
      if (!mountedRef.current) return;
      if (caught instanceof ApiError) {
        if (caught.code === 'ALREADY_REVIEWED') {
          const reloaded = await load();
          if (!mountedRef.current) return;
          if (reloaded) setNotice('이미 작성한 후기가 있어요.');
          else setFormError('이미 작성한 후기가 있어요. 새로고침해 주세요.');
        } else if (caught.code === 'REQUEST_NOT_COMPLETED') {
          setFormError(caught.message);
          router.refresh();
        } else if (caught.code === 'VALIDATION_ERROR') {
          const nextRating = caught.fields.rating ?? null;
          const nextBody = caught.fields.body ?? null;
          setRatingError(nextRating);
          setBodyError(nextBody);
          if (!nextRating && !nextBody) setFormError('평점과 후기 내용을 확인해 주세요.');
        } else if (caught.code === 'UNAUTHENTICATED') {
          router.push(`/login?next=/chats/${roomId}`);
        } else if (caught.code === 'NOT_FOUND') {
          setFormError('후기를 작성할 수 없어요.');
        } else {
          setFormError(RETRY_MESSAGE);
        }
      } else {
        setFormError(RETRY_MESSAGE);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  if (data === null) {
    return (
      <section id="reviews" className="mt-8 scroll-mt-20" aria-label="거래 후기 작성">
        {loadFailed ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-8 text-center">
            <p className="font-bold text-stone-700" role="alert">
              후기를 불러오지 못했어요.
            </p>
            <Button variant="secondary" className="mt-4" onClick={() => void load()} disabled={loading}>
              {loading ? '불러오는 중…' : '다시 시도'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-stone-500" role="status">
            후기를 불러오는 중이에요.
          </p>
        )}
      </section>
    );
  }

  // 참여자가 아니면(정상 흐름에서는 없다) 공개 목록만 요청 상세에 있다.
  if (data.viewerRole === null) return null;

  return (
    <section id="reviews" className="mt-8 scroll-mt-20" aria-labelledby="review-panel-heading">
      <p className="text-sm font-bold text-violet-700">거래 완료</p>
      <h2 id="review-panel-heading" className="mt-1 text-2xl font-black text-stone-900">
        거래 후기
      </h2>

      {notice ? (
        <p className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700" role="status">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        {data.canWrite ? (
          <form onSubmit={(event) => void handleSubmit(event)} noValidate className="rounded-2xl border border-stone-200 bg-white p-5">
            <div>
              <p id="review-rating-label" className="text-sm font-bold text-stone-800">
                평점
              </p>
              <div
                role="radiogroup"
                aria-labelledby="review-rating-label"
                aria-describedby={ratingError ? 'review-rating-error' : undefined}
              >
                <div className="mt-2 flex gap-1">
                  {RATINGS.map((value) => (
                    <label key={value} className="relative cursor-pointer">
                      <input
                        type="radio"
                        name="review-rating"
                        value={value}
                        checked={rating === value}
                        onChange={() => {
                          setRating(value);
                          setRatingError(null);
                        }}
                        disabled={submitting}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={`grid size-11 place-items-center rounded-xl border text-xl transition peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-potato-500 ${
                          rating !== null && value <= rating
                            ? 'border-potato-400 bg-potato-50 text-potato-500'
                            : 'border-stone-300 bg-white text-stone-300'
                        }`}
                      >
                        ★
                      </span>
                      <span className="sr-only">{value}점</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            {ratingError ? (
              <p id="review-rating-error" className="mt-2 text-sm font-semibold text-red-600" role="alert">
                {ratingError}
              </p>
            ) : null}

            <label htmlFor="review-body" className="mt-4 block text-sm font-bold text-stone-800">
              후기 내용
            </label>
            <textarea
              id="review-body"
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                if (bodyError) setBodyError(null);
              }}
              maxLength={MAX_BODY_LENGTH}
              rows={4}
              disabled={submitting}
              placeholder="거래는 어떠셨나요? (2자 이상)"
              aria-invalid={bodyError ? true : undefined}
              aria-describedby={bodyError ? 'review-body-error' : undefined}
              className="mt-2 w-full resize-none rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none placeholder:text-stone-400 focus:border-potato-400 focus:ring-2 focus:ring-potato-200 disabled:bg-stone-100"
            />
            <div className="mt-1 flex items-start justify-between gap-3 text-xs">
              <span>
                {bodyError ? (
                  <span id="review-body-error" className="font-semibold text-red-600" role="alert">
                    {bodyError}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-stone-400">
                {body.length}/{MAX_BODY_LENGTH}
              </span>
            </div>

            <p className="mt-3 rounded-xl bg-potato-50 px-4 py-3 text-sm font-semibold text-potato-700">
              후기는 등록하면 누구나 볼 수 있게 공개되고, 수정하거나 삭제할 수 없어요. 연락처 같은 개인정보는 적지 마세요.
            </p>

            {formError ? (
              <p className="mt-3 text-sm font-semibold text-red-600" role="alert">
                {formError}
              </p>
            ) : null}

            <Button type="submit" className="mt-4 w-full sm:w-auto" disabled={!canSubmit}>
              {submitting ? '등록 중…' : '후기 남기기'}
            </Button>
          </form>
        ) : null}

        {data.mine ? (
          <div>
            <ReviewCard title="내가 남긴 후기" review={data.mine} />
            <Link
              href={`/requests/${requestId}#reviews`}
              className="mt-2 inline-block text-sm font-bold text-leaf-700 underline underline-offset-2 hover:text-leaf-800"
            >
              공개된 후기 보기
            </Link>
          </div>
        ) : null}

        {data.received ? (
          <ReviewCard title="상대방이 남긴 후기" review={data.received} />
        ) : (
          <p className="rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-6 text-center text-sm font-semibold text-stone-500">
            아직 상대방이 후기를 남기지 않았어요.
          </p>
        )}
      </div>
    </section>
  );
}
