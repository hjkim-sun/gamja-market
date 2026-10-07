import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type {
  Application,
  ApplicationList,
  ApplicationStatus,
  ApplicationViewerRole,
  ApplyPayload,
  ApplyResult,
  ChatRoom,
  ChatStatus,
  MatchResult,
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
const MATCH_FIELD_KEYS = ['applicationId'] as const;

interface RequestOpts {
  signal?: AbortSignal;
  baseUrl?: string;
  cookie?: string;
}

function isMaskedUser(value: unknown): value is MaskedUser {
  return isRecord(value) && typeof value.id === 'string' && typeof value.maskedEmail === 'string';
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return value === 'pending' || value === 'accepted' || value === 'closed';
}

function isChatStatus(value: unknown): value is ChatStatus {
  return value === 'active' || value === 'matched' || value === 'closed';
}

function parseApplication(value: unknown): Application | null {
  if (!isRecord(value)) return null;

  const { id, requestId, seller, status, offerPrice, message, chatRoomId, createdAt } = value;
  if (
    typeof id !== 'string' ||
    typeof requestId !== 'string' ||
    !isMaskedUser(seller) ||
    !isApplicationStatus(status) ||
    typeof offerPrice !== 'number' ||
    typeof message !== 'string' ||
    typeof chatRoomId !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }

  return { id, requestId, seller, status, offerPrice, message, chatRoomId, createdAt };
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
    applicationStatus,
    chatStatus,
    canSend,
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
    !isApplicationStatus(applicationStatus) ||
    !isChatStatus(chatStatus) ||
    typeof canSend !== 'boolean' ||
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
    applicationStatus,
    chatStatus,
    canSend,
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

function parseMatchResult(value: unknown): MatchResult | null {
  if (!isRecord(value)) return null;

  const { request: requestSummary, acceptedApplicationId, chatRoomId, closedApplicationCount } = value;
  if (
    !isRecord(requestSummary) ||
    typeof requestSummary.id !== 'string' ||
    requestSummary.status !== 'matched' ||
    typeof acceptedApplicationId !== 'string' ||
    typeof chatRoomId !== 'string' ||
    typeof closedApplicationCount !== 'number'
  ) {
    return null;
  }

  return {
    request: { id: requestSummary.id, status: 'matched' },
    acceptedApplicationId,
    chatRoomId,
    closedApplicationCount,
  };
}

/** 구매자가 지원 1건을 확정한다. 같은 지원의 재확정도 서버가 200으로 응답한다(멱등). */
export async function confirmMatch(
  requestId: string,
  applicationId: string,
  signal?: AbortSignal,
): Promise<MatchResult> {
  const response = await request(`/${requestId}/match`, postInit({ applicationId }, signal), REQUESTS_BASE);

  if (!response.ok) {
    const error = await toApiError(response, MATCH_FIELD_KEYS);
    // 매칭 API의 409는 REQUEST_ALREADY_MATCHED/REQUEST_CLOSED로만 계약되어 있다.
    // 본문이 깨져 공용 fallbackCode(409)가 EMAIL_ALREADY_EXISTS로 잘못 짐작하면 INTERNAL_ERROR로 바꾼다.
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

  const result = parseMatchResult(body);
  if (!result) throw internalError(response.status);
  return result;
}
