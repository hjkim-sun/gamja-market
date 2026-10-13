import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type { RequestStatus } from '@/types/request';
import type {
  CompleteResult,
  CreateReviewResult,
  PublicReview,
  Review,
  ReviewPayload,
  ReviewerRole,
  TransactionReviews,
} from '@/types/review';

/** 브라우저는 동일 출처 상대 경로로만 호출하고, 서버 컴포넌트는 baseUrl로 절대 URL을 지정한다. */
const REQUESTS_BASE = '/api/requests';

const REVIEW_FIELD_KEYS = ['rating', 'body'] as const;
const PUBLIC_REVIEW_KEYS = ['reviewerRole', 'rating', 'body', 'createdAt'] as const;
const MAX_PUBLIC_ITEMS = 2;

interface ReadOpts {
  signal?: AbortSignal;
  baseUrl?: string;
  cookie?: string;
}

function isReviewerRole(value: unknown): value is ReviewerRole {
  return value === 'buyer' || value === 'seller';
}

function isRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

function isRequestStatus(value: unknown): value is RequestStatus {
  return value === 'open' || value === 'matched' || value === 'closed' || value === 'completed';
}

function pickReview(value: Record<string, unknown>): PublicReview | null {
  const { reviewerRole, rating, body, createdAt } = value;
  if (!isReviewerRole(reviewerRole) || !isRating(rating) || typeof body !== 'string' || typeof createdAt !== 'string') {
    return null;
  }
  return { reviewerRole, rating, body, createdAt };
}

/**
 * GET의 후기는 4개 키만 허용한다. id·사용자 정보 같은 추가 키가 섞여 오면 공개 계약이 깨진
 * 응답이므로 일부만 걸러 쓰지 않고 파서 실패로 다룬다.
 */
function parsePublicReview(value: unknown): PublicReview | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== PUBLIC_REVIEW_KEYS.length || !PUBLIC_REVIEW_KEYS.every((key) => keys.includes(key))) {
    return null;
  }
  return pickReview(value);
}

function parseReview(value: unknown): Review | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const review = pickReview(value);
  return review ? { id: value.id, ...review } : null;
}

function parseOptionalPublicReview(value: unknown): PublicReview | null | undefined {
  if (value === null) return null;
  return parsePublicReview(value) ?? undefined;
}

function parseTransactionReviews(value: unknown): TransactionReviews | null {
  if (!isRecord(value)) return null;

  const { requestId, requestStatus, completedAt, items, viewerRole, canWrite } = value;
  if (
    typeof requestId !== 'string' ||
    !isRequestStatus(requestStatus) ||
    (completedAt !== null && typeof completedAt !== 'string') ||
    !Array.isArray(items) ||
    items.length > MAX_PUBLIC_ITEMS ||
    (viewerRole !== null && !isReviewerRole(viewerRole)) ||
    typeof canWrite !== 'boolean'
  ) {
    return null;
  }

  const parsedItems = items.map(parsePublicReview);
  if (parsedItems.some((item) => item === null)) return null;

  const mine = parseOptionalPublicReview(value.mine);
  const received = parseOptionalPublicReview(value.received);
  if (mine === undefined || received === undefined) return null;

  return {
    requestId,
    requestStatus,
    completedAt,
    items: parsedItems as PublicReview[],
    viewerRole,
    canWrite,
    mine,
    received,
  };
}

function parseCompleteResult(value: unknown): CompleteResult | null {
  if (!isRecord(value)) return null;

  const { request: requestSummary, acceptedApplicationId, chatRoomId } = value;
  if (
    !isRecord(requestSummary) ||
    typeof requestSummary.id !== 'string' ||
    requestSummary.status !== 'completed' ||
    typeof requestSummary.completedAt !== 'string' ||
    typeof acceptedApplicationId !== 'string' ||
    typeof chatRoomId !== 'string'
  ) {
    return null;
  }

  return {
    request: { id: requestSummary.id, status: 'completed', completedAt: requestSummary.completedAt },
    acceptedApplicationId,
    chatRoomId,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw internalError(response.status);
  }
}

/** 이 API의 409는 계약된 code로만 내려온다. 본문이 깨져 공용 추정값(EMAIL_ALREADY_EXISTS)이 나오면 INTERNAL_ERROR로 바꾼다. */
async function toWriteError(response: Response, fieldKeys: readonly string[]) {
  const error = await toApiError(response, fieldKeys);
  if (response.status === 409 && error.code === 'EMAIL_ALREADY_EXISTS') return internalError(response.status);
  return error;
}

/** 구매자가 매칭된 요청을 완료 처리한다. 같은 요청의 재호출도 서버가 200으로 응답한다(멱등). */
export async function completeTransaction(requestId: string, signal?: AbortSignal): Promise<CompleteResult> {
  const response = await request(`/${requestId}/complete`, postInit({}, signal), REQUESTS_BASE);
  if (!response.ok) throw await toWriteError(response, []);

  const result = parseCompleteResult(await readJson(response));
  if (!result) throw internalError(response.status);
  return result;
}

/** 공개 조회다. 로그인 없이 성공하며, 쿠키가 있으면 참여자 전용 필드가 채워진다. */
export async function getTransactionReviews(
  requestId: string,
  opts: ReadOpts = {},
): Promise<TransactionReviews> {
  const response = await request(
    `/${requestId}/reviews`,
    { method: 'GET', signal: opts.signal, headers: opts.cookie ? { Cookie: opts.cookie } : undefined },
    `${opts.baseUrl ?? ''}${REQUESTS_BASE}`,
  );
  if (!response.ok) throw await toApiError(response, []);

  const reviews = parseTransactionReviews(await readJson(response));
  if (!reviews) throw internalError(response.status);
  return reviews;
}

export async function createReview(
  requestId: string,
  payload: ReviewPayload,
  signal?: AbortSignal,
): Promise<CreateReviewResult> {
  const response = await request(`/${requestId}/reviews`, postInit(payload, signal), REQUESTS_BASE);
  if (!response.ok) throw await toWriteError(response, REVIEW_FIELD_KEYS);

  const body = await readJson(response);
  const review = isRecord(body) ? parseReview(body.review) : null;
  if (!review) throw internalError(response.status);
  return { review, created: response.status === 201 };
}
