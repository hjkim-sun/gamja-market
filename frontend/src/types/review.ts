import type { RequestStatus } from '@/types/request';

/** 후기 작성자 역할. 공개 후기는 작성자를 역할로만 표시한다(설계서 10장). */
export type ReviewerRole = 'buyer' | 'seller';

/** GET 응답의 모든 후기. id·사용자·이메일 정보는 없다(설계서 6.2). */
export interface PublicReview {
  reviewerRole: ReviewerRole;
  rating: number;
  body: string;
  createdAt: string;
}

/** POST 응답 전용 — 작성자 본인에게만 후기 id가 내려온다(설계서 6.3). */
export type Review = PublicReview & { id: string };

export interface TransactionReviews {
  requestId: string;
  requestStatus: RequestStatus;
  completedAt: string | null;
  /** 공개 후기 0~2건. 조회자와 무관하게 같다. */
  items: PublicReview[];
  /** 참여자(구매자·확정 판매자)가 아니면 null. */
  viewerRole: ReviewerRole | null;
  canWrite: boolean;
  mine: PublicReview | null;
  received: PublicReview | null;
}

export interface ReviewPayload {
  rating: number;
  body: string;
}

export interface CreateReviewResult {
  review: Review;
  /** 201이면 새 후기, 200이면 같은 내용의 기존 후기(멱등 재전송). */
  created: boolean;
}

export interface CompleteResult {
  request: { id: string; status: 'completed'; completedAt: string };
  acceptedApplicationId: string;
  chatRoomId: string;
}
