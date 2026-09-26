export type RequestStatus = 'open' | 'matched' | 'closed';

export type ProductCondition = 'any' | 'new' | 'like_new' | 'used';

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

export interface PurchaseRequestDetail extends PurchaseRequestSummary {
  description: string;
  updatedAt: string;
  buyer: RequestBuyer;
}

/** 컴포넌트 prop 타입으로 계속 쓰인다. */
export type PurchaseRequest = PurchaseRequestDetail;

export interface RequestListEnvelope {
  items: PurchaseRequestSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateRequestPayload {
  title: string;
  category: string;
  description: string;
  priceMin: number;
  priceMax: number;
  condition: ProductCondition;
  region: string;
}

export interface ListRequestsParams {
  q?: string;
  category?: string;
  status?: string;
  sort?: 'latest' | 'price' | 'applicants';
  page?: number;
  pageSize?: number;
}
