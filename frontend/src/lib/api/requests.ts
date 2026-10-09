import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type {
  CreateRequestPayload,
  ListRequestsParams,
  PurchaseRequestDetail,
  PurchaseRequestSummary,
  RequestListEnvelope,
  RequestPhoto,
} from '@/types/request';

/**
 * 브라우저는 백엔드 주소를 직접 호출하지 않는다. 동일 출처 상대 경로로만 호출하고
 * next.config.ts의 rewrite가 FastAPI로 전달한다.
 */
const REQUESTS_BASE = '/api/requests';

const ALLOWED_FIELD_KEYS = [
  'title',
  'category',
  'description',
  'priceMin',
  'priceMax',
  'condition',
  'region',
  'page',
  'pageSize',
  'q',
  'sort',
  'status',
  'photoIds',
] as const;

/**
 * 사진 프록시의 동일 출처 URL만 허용한다(설계서 08).
 */
export function isSafeImageUrl(url: string): boolean {
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return false;
  if (/^\/api\/request-photos\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(url)) return true;
  return false;
}

function parsePhotos(value: unknown): RequestPhoto[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const photos: RequestPhoto[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.url !== 'string') {
      return null;
    }
    if (isSafeImageUrl(item.url)) photos.push({ id: item.id, url: item.url });
  }
  return photos;
}

/** 백엔드 `page` 상한(`le=500`)과 같은 값이다. 넘으면 422가 되므로 프론트에서 먼저 보정한다. */
export const MAX_LIST_PAGE = 500;

/** URL의 `?page=` 원문을 1..MAX_LIST_PAGE 범위의 정수로 보정한다. */
export function resolveListPage(raw: string | undefined): number {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, MAX_LIST_PAGE);
}

interface RequestOpts {
  signal?: AbortSignal;
  baseUrl?: string;
  cookie?: string;
}

function isRequestStatus(value: unknown): value is PurchaseRequestSummary['status'] {
  return value === 'open' || value === 'matched' || value === 'closed';
}

function isProductCondition(value: unknown): value is PurchaseRequestSummary['condition'] {
  return value === 'any' || value === 'new' || value === 'like_new' || value === 'used';
}

function parseSummary(value: unknown): PurchaseRequestSummary | null {
  if (!isRecord(value)) return null;

  const {
    id,
    title,
    category,
    condition,
    priceMin,
    priceMax,
    region,
    status,
    thumbnailUrl,
    applicantCount,
    createdAt,
    isOwner,
  } = value;

  if (
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    typeof category !== 'string' ||
    !isProductCondition(condition) ||
    typeof priceMin !== 'number' ||
    typeof priceMax !== 'number' ||
    typeof region !== 'string' ||
    !isRequestStatus(status) ||
    (thumbnailUrl !== null && typeof thumbnailUrl !== 'string') ||
    typeof applicantCount !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof isOwner !== 'boolean'
  ) {
    return null;
  }

  return {
    id,
    title,
    category,
    condition,
    priceMin,
    priceMax,
    region,
    status,
    thumbnailUrl: thumbnailUrl !== null && isSafeImageUrl(thumbnailUrl) ? thumbnailUrl : null,
    applicantCount,
    createdAt,
    isOwner,
  };
}

function parseDetail(value: unknown): PurchaseRequestDetail | null {
  const summary = parseSummary(value);
  if (!summary || !isRecord(value)) return null;

  const { description, updatedAt, buyer, photos: photosValue } = value;
  const photos = parsePhotos(photosValue);
  if (
    typeof description !== 'string' ||
    typeof updatedAt !== 'string' ||
    !isRecord(buyer) ||
    typeof buyer.id !== 'string' ||
    typeof buyer.maskedEmail !== 'string' ||
    photos === null
  ) {
    return null;
  }

  return {
    ...summary,
    description,
    updatedAt,
    buyer: { id: buyer.id, maskedEmail: buyer.maskedEmail },
    photos,
  };
}

function parseEnvelope(value: unknown): RequestListEnvelope | null {
  if (!isRecord(value)) return null;

  const { items, total, page, pageSize } = value;
  if (!Array.isArray(items) || typeof total !== 'number' || typeof page !== 'number' || typeof pageSize !== 'number') {
    return null;
  }

  const parsedItems = items.map(parseSummary);
  if (parsedItems.some((item) => item === null)) return null;

  return { items: parsedItems as PurchaseRequestSummary[], total, page, pageSize };
}

function buildQuery(params: ListRequestsParams): string {
  const query = new URLSearchParams();

  const q = params.q?.trim();
  if (q) query.set('q', q);
  if (params.category) query.set('category', params.category);
  if (params.status) query.set('status', params.status);
  if (params.sort && params.sort !== 'latest') query.set('sort', params.sort);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));

  const search = query.toString();
  return search ? `?${search}` : '';
}

export async function listRequests(
  params: ListRequestsParams,
  opts: RequestOpts = {},
): Promise<RequestListEnvelope> {
  const response = await request(
    `${buildQuery(params)}`,
    { method: 'GET', signal: opts.signal, headers: opts.cookie ? { Cookie: opts.cookie } : undefined },
    `${opts.baseUrl ?? ''}${REQUESTS_BASE}`,
  );

  if (!response.ok) throw await toApiError(response, ALLOWED_FIELD_KEYS);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  const envelope = parseEnvelope(body);
  if (!envelope) throw internalError(response.status);
  return envelope;
}

export async function getRequest(id: string, opts: RequestOpts = {}): Promise<PurchaseRequestDetail> {
  const response = await request(
    `/${id}`,
    { method: 'GET', signal: opts.signal, headers: opts.cookie ? { Cookie: opts.cookie } : undefined },
    `${opts.baseUrl ?? ''}${REQUESTS_BASE}`,
  );

  if (!response.ok) throw await toApiError(response, ALLOWED_FIELD_KEYS);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  const detail = parseDetail(body);
  if (!detail) throw internalError(response.status);
  return detail;
}

export async function createRequest(
  payload: CreateRequestPayload,
  signal?: AbortSignal,
): Promise<PurchaseRequestDetail> {
  // 빈 photoIds는 키 자체를 생략해 레거시 요청과 바이트 단위로 같은 JSON을 보낸다(설계서 7.1).
  const { photoIds, ...rest } = payload;
  const requestBody = photoIds && photoIds.length > 0 ? { ...rest, photoIds } : rest;
  const response = await request('', postInit(requestBody, signal), REQUESTS_BASE);

  if (!response.ok) throw await toApiError(response, ALLOWED_FIELD_KEYS);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  const detail = parseDetail(body);
  if (!detail) throw internalError(response.status);
  return detail;
}
