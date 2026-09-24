import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type {
  CreateRequestPayload,
  ListRequestsParams,
  PurchaseRequestDetail,
  PurchaseRequestSummary,
  RequestListEnvelope,
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
] as const;

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
    thumbnailUrl,
    applicantCount,
    createdAt,
    isOwner,
  };
}

function parseDetail(value: unknown): PurchaseRequestDetail | null {
  const summary = parseSummary(value);
  if (!summary || !isRecord(value)) return null;

  const { description, updatedAt, buyer } = value;
  if (
    typeof description !== 'string' ||
    typeof updatedAt !== 'string' ||
    !isRecord(buyer) ||
    typeof buyer.id !== 'string' ||
    typeof buyer.maskedEmail !== 'string'
  ) {
    return null;
  }

  return {
    ...summary,
    description,
    updatedAt,
    buyer: { id: buyer.id, maskedEmail: buyer.maskedEmail },
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
  const response = await request('', postInit(payload, signal), REQUESTS_BASE);

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
