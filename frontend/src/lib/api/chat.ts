import { internalError, isRecord, postInit, request, toApiError } from '@/lib/api/http';
import type { ApplicationStatus, ChatStatus } from '@/types/application';
import type {
  ChatMessage,
  ChatRoomList,
  ChatRoomListItem,
  MessageList,
  MessageRoomState,
  SendMessagePayload,
  SendMessageResult,
} from '@/types/chat';
import type { RequestStatus } from '@/types/request';

/** 브라우저는 동일 출처 상대 경로로만 호출하고, 서버 컴포넌트는 baseUrl로 절대 URL을 지정한다. */
const CHAT_ROOMS_BASE = '/api/chat-rooms';

const MESSAGE_FIELD_KEYS = ['body', 'clientMessageId', 'afterSeq', 'limit'] as const;
const ROOM_LIST_FIELD_KEYS = ['limit'] as const;

interface ReadOpts {
  signal?: AbortSignal;
  baseUrl?: string;
  cookie?: string;
}

export interface ListMessagesOpts extends ReadOpts {
  afterSeq?: number;
  limit?: number;
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return value === 'pending' || value === 'accepted' || value === 'closed';
}

function isChatStatus(value: unknown): value is ChatStatus {
  return value === 'active' || value === 'matched' || value === 'closed';
}

function isRequestStatus(value: unknown): value is RequestStatus {
  return value === 'open' || value === 'matched' || value === 'closed';
}

function isSenderRole(value: unknown): value is ChatMessage['senderRole'] {
  return value === 'buyer' || value === 'seller';
}

function isViewerRole(value: unknown): value is ChatRoomListItem['viewerRole'] {
  return value === 'buyer' || value === 'seller';
}

function parseMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;

  const { id, seq, senderRole, isMine, body, clientMessageId, createdAt } = value;
  if (
    typeof id !== 'string' ||
    typeof seq !== 'number' ||
    !isSenderRole(senderRole) ||
    typeof isMine !== 'boolean' ||
    typeof body !== 'string' ||
    typeof clientMessageId !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }

  return { id, seq, senderRole, isMine, body, clientMessageId, createdAt };
}

function parseRoomState(value: unknown): MessageRoomState | null {
  if (!isRecord(value)) return null;

  const { id, chatStatus, canSend, applicationStatus, requestStatus } = value;
  if (
    typeof id !== 'string' ||
    !isChatStatus(chatStatus) ||
    typeof canSend !== 'boolean' ||
    !isApplicationStatus(applicationStatus) ||
    !isRequestStatus(requestStatus)
  ) {
    return null;
  }

  return { id, chatStatus, canSend, applicationStatus, requestStatus };
}

export function parseMessageList(value: unknown): MessageList | null {
  if (!isRecord(value)) return null;

  const { items, latestSeq, hasMore, hasOlder } = value;
  const room = parseRoomState(value.room);
  if (
    !room ||
    !Array.isArray(items) ||
    typeof latestSeq !== 'number' ||
    typeof hasMore !== 'boolean' ||
    typeof hasOlder !== 'boolean'
  ) {
    return null;
  }

  const parsedItems = items.map(parseMessage);
  if (parsedItems.some((item) => item === null)) return null;

  return { room, items: parsedItems as ChatMessage[], latestSeq, hasMore, hasOlder };
}

function parseRoomListItem(value: unknown): ChatRoomListItem | null {
  if (!isRecord(value)) return null;

  const { id, viewerRole, chatStatus, request: requestSummary, counterpart, lastMessage, lastActivityAt } = value;
  if (
    typeof id !== 'string' ||
    !isViewerRole(viewerRole) ||
    !isChatStatus(chatStatus) ||
    !isRecord(requestSummary) ||
    typeof requestSummary.id !== 'string' ||
    typeof requestSummary.title !== 'string' ||
    !isRequestStatus(requestSummary.status) ||
    !isRecord(counterpart) ||
    typeof counterpart.id !== 'string' ||
    typeof counterpart.maskedEmail !== 'string' ||
    typeof lastActivityAt !== 'string'
  ) {
    return null;
  }

  let parsedLast: ChatRoomListItem['lastMessage'] = null;
  if (lastMessage !== null) {
    if (
      !isRecord(lastMessage) ||
      typeof lastMessage.body !== 'string' ||
      !isSenderRole(lastMessage.senderRole) ||
      typeof lastMessage.createdAt !== 'string'
    ) {
      return null;
    }
    parsedLast = {
      body: lastMessage.body,
      senderRole: lastMessage.senderRole,
      createdAt: lastMessage.createdAt,
    };
  }

  return {
    id,
    viewerRole,
    chatStatus,
    request: { id: requestSummary.id, title: requestSummary.title, status: requestSummary.status },
    counterpart: { id: counterpart.id, maskedEmail: counterpart.maskedEmail },
    lastMessage: parsedLast,
    lastActivityAt,
  };
}

function parseRoomList(value: unknown): ChatRoomList | null {
  if (!isRecord(value)) return null;

  const { items, hasMore } = value;
  if (!Array.isArray(items) || typeof hasMore !== 'boolean') return null;

  const parsedItems = items.map(parseRoomListItem);
  if (parsedItems.some((item) => item === null)) return null;

  return { items: parsedItems as ChatRoomListItem[], hasMore };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw internalError(response.status);
  }
}

function readInit(opts: ReadOpts): RequestInit {
  return { method: 'GET', signal: opts.signal, headers: opts.cookie ? { Cookie: opts.cookie } : undefined };
}

/** afterSeq가 없으면 최근 limit건(첫 로드), 있으면 seq > afterSeq를 오름차순으로 돌려준다. */
export async function listMessages(roomId: string, opts: ListMessagesOpts = {}): Promise<MessageList> {
  const params = new URLSearchParams();
  if (opts.afterSeq !== undefined) params.set('afterSeq', String(opts.afterSeq));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const query = params.toString();

  const response = await request(
    `/${roomId}/messages${query ? `?${query}` : ''}`,
    readInit(opts),
    `${opts.baseUrl ?? ''}${CHAT_ROOMS_BASE}`,
  );

  if (!response.ok) throw await toApiError(response, MESSAGE_FIELD_KEYS);

  const list = parseMessageList(await readJson(response));
  if (!list) throw internalError(response.status);
  return list;
}

export async function sendMessage(
  roomId: string,
  payload: SendMessagePayload,
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  const response = await request(`/${roomId}/messages`, postInit(payload, signal), CHAT_ROOMS_BASE);

  if (!response.ok) {
    const error = await toApiError(response, MESSAGE_FIELD_KEYS);
    // 전송 API의 409는 CHAT_ROOM_CLOSED로만 계약되어 있다. 본문이 깨져 공용 fallbackCode가
    // EMAIL_ALREADY_EXISTS로 짐작한 경우 인증 오류로 오인하지 않도록 INTERNAL_ERROR로 바꾼다.
    if (response.status === 409 && error.code === 'EMAIL_ALREADY_EXISTS') {
      throw internalError(response.status);
    }
    throw error;
  }

  const body = await readJson(response);
  const message = isRecord(body) ? parseMessage(body.message) : null;
  if (!message) throw internalError(response.status);
  return { message, created: response.status === 201 };
}

export async function listChatRooms(opts: ReadOpts = {}): Promise<ChatRoomList> {
  const response = await request('', readInit(opts), `${opts.baseUrl ?? ''}${CHAT_ROOMS_BASE}`);

  if (!response.ok) throw await toApiError(response, ROOM_LIST_FIELD_KEYS);

  const list = parseRoomList(await readJson(response));
  if (!list) throw internalError(response.status);
  return list;
}
