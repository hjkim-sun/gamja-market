import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type {
  Application,
  ApplicationList,
  ApplicationViewerRole,
  ApplyPayload,
  ApplyResult,
  ChatRoom,
} from '@/types/application';
import type { MaskedUser } from '@/types/application';

/**
 * 브라우저는 백엔드 주소를 직접 호출하지 않는다. 동일 출처 상대 경로로만 호출하고
 * next.config.ts의 rewrite가 FastAPI로 전달한다. 서버 컴포넌트에서는 baseUrl로
 * 절대 URL을 지정한다(설계서 11.2).
 */
const REQUESTS_BASE = '/api/requests';
const CHAT_ROOMS_BASE = '/api/chat-rooms';

const ALLOWED_FIELD_KEYS = ['offerPrice', 'message'] as const;

interface RequestOpts {
  signal?: AbortSignal;
  baseUrl?: string;
  cookie?: string;
}

function isMaskedUser(value: unknown): value is MaskedUser {
  return isRecord(value) && typeof value.id === 'string' && typeof value.maskedEmail === 'string';
}

function parseApplication(value: unknown): Application | null {
  if (!isRecord(value)) return null;

  const { id, requestId, seller, offerPrice, message, chatRoomId, createdAt } = value;
  if (
    typeof id !== 'string' ||
    typeof requestId !== 'string' ||
    !isMaskedUser(seller) ||
    typeof offerPrice !== 'number' ||
    typeof message !== 'string' ||
    typeof chatRoomId !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }

  return { id, requestId, seller, offerPrice, message, chatRoomId, createdAt };
}

function isViewerRole(value: unknown): value is ApplicationViewerRole {
  return value === 'owner' || value === 'applicant' || value === 'member' || value === 'anonymous';
}

function parseApplicationList(value: unknown): ApplicationList | null {
  if (!isRecord(value)) return null;

  const { viewerRole, applicantCount, items } = value;
  if (!isViewerRole(viewerRole) || typeof applicantCount !== 'number' || !Array.isArray(items)) {
    return null;
  }

  const parsedItems = items.map(parseApplication);
  if (parsedItems.some((item) => item === null)) return null;

  return { viewerRole, applicantCount, items: parsedItems as Application[] };
}

function isChatRoomViewerRole(value: unknown): value is ChatRoom['viewerRole'] {
  return value === 'buyer' || value === 'seller';
}

function isRequestStatus(value: unknown): value is ChatRoom['request']['status'] {
  return value === 'open' || value === 'matched' || value === 'closed';
}

function parseChatRoom(value: unknown): ChatRoom | null {
  if (!isRecord(value)) return null;

  const {
    id,
    applicationId,
    viewerRole,
    request: requestSummary,
    buyer,
    seller,
    offerPrice,
    applicationMessage,
    createdAt,
  } = value;

  if (
    typeof id !== 'string' ||
    typeof applicationId !== 'string' ||
    !isChatRoomViewerRole(viewerRole) ||
    !isRecord(requestSummary) ||
    typeof requestSummary.id !== 'string' ||
    typeof requestSummary.title !== 'string' ||
    !isRequestStatus(requestSummary.status) ||
    typeof requestSummary.priceMin !== 'number' ||
    typeof requestSummary.priceMax !== 'number' ||
    !isMaskedUser(buyer) ||
    !isMaskedUser(seller) ||
    typeof offerPrice !== 'number' ||
    typeof applicationMessage !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }

  return {
    id,
    applicationId,
    viewerRole,
    request: {
      id: requestSummary.id,
      title: requestSummary.title,
      status: requestSummary.status,
      priceMin: requestSummary.priceMin,
      priceMax: requestSummary.priceMax,
    },
    buyer,
    seller,
    offerPrice,
    applicationMessage,
    createdAt,
  };
}

export async function applyToRequest(
  requestId: string,
  payload: ApplyPayload,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const response = await request(`/${requestId}/applications`, postInit(payload, signal), REQUESTS_BASE);

  if (!response.ok) {
    const error = await toApiError(response, ALLOWED_FIELD_KEYS);
    // 지원 API는 409를 계약된 code(ALREADY_APPLIED/REQUEST_NOT_OPEN)로만 다룬다.
    // 본문이 깨져 공용 fallbackCode(409)가 EMAIL_ALREADY_EXISTS로 잘못 짐작하면
    // 인증 관련 오류로 오인하지 않도록 INTERNAL_ERROR로 바꾼다(설계서 11.2).
    if (response.status === 409 && error.code === 'EMAIL_ALREADY_EXISTS') {
      throw internalError(response.status);
    }
    throw error;
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  if (!isRecord(body)) throw internalError(response.status);
  const application = parseApplication(body.application);
  const chatRoom = parseChatRoom(body.chatRoom);
  if (!application || !chatRoom) throw internalError(response.status);

  return { application, chatRoom };
}

export async function listApplications(
  requestId: string,
  opts: RequestOpts = {},
): Promise<ApplicationList> {
  const response = await request(
    `/${requestId}/applications`,
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

  const list = parseApplicationList(body);
  if (!list) throw internalError(response.status);
  return list;
}

export async function getChatRoom(roomId: string, opts: RequestOpts = {}): Promise<ChatRoom> {
  const response = await request(
    `/${roomId}`,
    { method: 'GET', signal: opts.signal, headers: opts.cookie ? { Cookie: opts.cookie } : undefined },
    `${opts.baseUrl ?? ''}${CHAT_ROOMS_BASE}`,
  );

  if (!response.ok) throw await toApiError(response, []);

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw internalError(response.status);
  }

  const chatRoom = parseChatRoom(body);
  if (!chatRoom) throw internalError(response.status);
  return chatRoom;
}
