import type { RequestBuyer, RequestStatus } from '@/types/request';

/** 구매자·판매자 표시는 마스킹 이메일만 쓴다(설계서 4.1, 11.1). */
export type MaskedUser = RequestBuyer;

export type ApplicationViewerRole = 'owner' | 'applicant' | 'member' | 'anonymous';

export interface Application {
  id: string;
  requestId: string;
  seller: MaskedUser;
  offerPrice: number;
  message: string;
  chatRoomId: string;
  createdAt: string;
}

export interface ApplicationList {
  viewerRole: ApplicationViewerRole;
  applicantCount: number;
  items: Application[];
}

export interface ChatRoomRequestSummary {
  id: string;
  title: string;
  status: RequestStatus;
  priceMin: number;
  priceMax: number;
}

export type ChatRoomViewerRole = 'buyer' | 'seller';

export interface ChatRoom {
  id: string;
  applicationId: string;
  viewerRole: ChatRoomViewerRole;
  request: ChatRoomRequestSummary;
  buyer: MaskedUser;
  seller: MaskedUser;
  offerPrice: number;
  applicationMessage: string;
  createdAt: string;
}

export interface ApplyPayload {
  offerPrice: number;
  message: string;
}

export interface ApplyResult {
  application: Application;
  chatRoom: ChatRoom;
}
