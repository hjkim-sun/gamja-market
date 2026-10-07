import type { ChatStatus, ChatRoomViewerRole, MaskedUser, ApplicationStatus } from '@/types/application';
import type { RequestStatus } from '@/types/request';

export type MessageSenderRole = 'buyer' | 'seller';

export interface ChatMessage {
  id: string;
  seq: number;
  senderRole: MessageSenderRole;
  isMine: boolean;
  body: string;
  clientMessageId: string;
  createdAt: string;
}

export interface MessageRoomState {
  id: string;
  chatStatus: ChatStatus;
  canSend: boolean;
  applicationStatus: ApplicationStatus;
  requestStatus: RequestStatus;
}

export interface MessageList {
  room: MessageRoomState;
  items: ChatMessage[];
  latestSeq: number;
  hasMore: boolean;
  hasOlder: boolean;
}

export interface SendMessagePayload {
  clientMessageId: string;
  body: string;
}

export interface SendMessageResult {
  message: ChatMessage;
  /** 201이면 새 메시지, 200이면 같은 clientMessageId의 기존 메시지(멱등 재전송). */
  created: boolean;
}

export interface ChatRoomListItem {
  id: string;
  viewerRole: ChatRoomViewerRole;
  chatStatus: ChatStatus;
  request: { id: string; title: string; status: RequestStatus };
  counterpart: MaskedUser;
  lastMessage: { body: string; senderRole: MessageSenderRole; createdAt: string } | null;
  lastActivityAt: string;
}

export interface ChatRoomList {
  items: ChatRoomListItem[];
  hasMore: boolean;
}
