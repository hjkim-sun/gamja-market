export type RequestStatus = 'open' | 'matched' | 'closed';

export type ProductCondition = 'any' | 'new' | 'like_new' | 'used';

export interface UserSummary {
  id: string;
  nickname: string;
  region: string;
}

export interface PurchaseRequest {
  id: string;
  title: string;
  description: string;
  category: string;
  condition: ProductCondition;
  priceMin: number;
  priceMax: number;
  region: string;
  status: RequestStatus;
  thumbnailUrl: string | null;
  buyer: UserSummary;
  applicantCount: number;
  createdAt: string;
}

export interface Applicant {
  id: string;
  requestId: string;
  seller: UserSummary;
  offerPrice: number;
  message: string;
  createdAt: string;
}
