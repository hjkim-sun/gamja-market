export type RequestStatus = 'open' | 'matched' | 'closed';

export type ProductCondition = 'any' | 'new' | 'like_new' | 'used';

/** 4단계 지원 API를 위해 타입만 남긴다. 이 단계는 이 타입의 데이터를 만들지 않는다. */
export interface UserSummary {
  id: string;
  nickname: string;
  region: string;
}

/** 구매자 표시는 이메일 로컬파트 마스킹만 쓴다(설계서 3.2). */
export interface RequestBuyer {
  id: string;
  maskedEmail: string;
}

export interface PurchaseRequestSummary {
  id: string;
  title: string;
  category: string;
  condition: ProductCondition;
  priceMin: number;
  priceMax: number;
  region: string;
  status: RequestStatus;
  thumbnailUrl: string | null;
  applicantCount: number;
  createdAt: string;
  isOwner: boolean;
}

/** 설계서 7.1 — 상세 응답의 사진 갤러리 항목. */
export interface RequestPhoto {
  id: string;
  url: string;
}

export interface PurchaseRequestDetail extends PurchaseRequestSummary {
  description: string;
  updatedAt: string;
  buyer: RequestBuyer;
  photos: RequestPhoto[];
}

/** `POST /api/request-photos` 성공 응답(설계서 5.2). URL·저장 경로는 포함하지 않는다. */
export interface UploadedRequestPhoto {
  id: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  expiresAt: string;
}

/** 컴포넌트 prop 타입으로 계속 쓰인다. */
export type PurchaseRequest = PurchaseRequestDetail;

export interface RequestListEnvelope {
  items: PurchaseRequestSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** 4단계 지원 API를 위해 타입만 남긴다. 이 단계는 이 타입의 데이터를 만들지 않는다. */
export interface Applicant {
  id: string;
  requestId: string;
  seller: UserSummary;
  offerPrice: number;
  message: string;
  createdAt: string;
}

export interface CreateRequestPayload {
  title: string;
  category: string;
  description: string;
  priceMin: number;
  priceMax: number;
  condition: ProductCondition;
  region: string;
  /** 등록에 연결할 업로드된 사진 ID. 비어 있으면 요청 JSON에서 키 자체를 생략한다. */
  photoIds?: string[];
}

export interface ListRequestsParams {
  q?: string;
  category?: string;
  status?: string;
  sort?: 'latest' | 'price' | 'applicants';
  page?: number;
  pageSize?: number;
}
