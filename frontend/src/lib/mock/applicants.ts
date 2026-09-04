import type { Applicant } from '@/types/request';

import { mockUsers } from './users';

const featuredApplicants: Applicant[] = [
  {
    id: 'applicant-001',
    requestId: 'request-001',
    seller: mockUsers.sellerA,
    offerPrice: 790_000,
    message: 'M2 128GB 스페이스 그레이입니다. 케이스를 사용해서 외관이 깨끗하고 배터리 성능은 94%예요.',
    createdAt: '2026-08-30T09:10:00+09:00',
  },
  {
    id: 'applicant-002',
    requestId: 'request-001',
    seller: mockUsers.sellerB,
    offerPrice: 820_000,
    message: '256GB 실버 모델이고 박스와 충전기까지 모두 있습니다. 강남역에서 거래 가능해요.',
    createdAt: '2026-08-30T09:45:00+09:00',
  },
  {
    id: 'applicant-003',
    requestId: 'request-001',
    seller: mockUsers.sellerC,
    offerPrice: 750_000,
    message: '128GB 와이파이 모델입니다. 모서리에 작은 사용감이 있어 사진 확인 후 결정하셔도 됩니다.',
    createdAt: '2026-08-30T10:20:00+09:00',
  },
  {
    id: 'applicant-004',
    requestId: 'request-002',
    seller: mockUsers.sellerA,
    offerPrice: 560_000,
    message: '작년 구매 후 거의 사용하지 않은 제품입니다. 구성품 모두 있어요.',
    createdAt: '2026-08-30T07:35:00+09:00',
  },
];

const sellerPool = [mockUsers.sellerA, mockUsers.sellerB, mockUsers.sellerC];

const additionalApplicantSets: Array<{
  requestId: string;
  count: number;
  basePrice: number;
  createdAt: string;
}> = [
  { requestId: 'request-004', count: 5, basePrice: 1_420_000, createdAt: '2026-08-29T16:00:00+09:00' },
  { requestId: 'request-005', count: 2, basePrice: 350_000, createdAt: '2026-08-28T13:00:00+09:00' },
  { requestId: 'request-006', count: 4, basePrice: 70_000, createdAt: '2026-08-27T11:00:00+09:00' },
  { requestId: 'request-007', count: 2, basePrice: 420_000, createdAt: '2026-08-25T19:00:00+09:00' },
  { requestId: 'request-008', count: 1, basePrice: 270_000, createdAt: '2026-08-23T15:00:00+09:00' },
  { requestId: 'request-010', count: 6, basePrice: 580_000, createdAt: '2026-08-17T12:00:00+09:00' },
  { requestId: 'request-011', count: 2, basePrice: 120_000, createdAt: '2026-08-12T18:00:00+09:00' },
  { requestId: 'request-012', count: 1, basePrice: 80_000, createdAt: '2026-08-05T14:00:00+09:00' },
];

const additionalApplicants: Applicant[] = additionalApplicantSets.flatMap((set) =>
  Array.from({ length: set.count }, (_, index) => ({
    id: `${set.requestId}-applicant-${index + 1}`,
    requestId: set.requestId,
    seller: sellerPool[index % sellerPool.length],
    offerPrice: set.basePrice + index * 10_000,
    message: '요청하신 조건에 가까운 제품을 가지고 있어요. 제품 상태와 구성품은 거래 전에 자세히 안내드릴게요.',
    createdAt: new Date(new Date(set.createdAt).getTime() + index * 30 * 60_000).toISOString(),
  })),
);

export const mockApplicants: Applicant[] = [...featuredApplicants, ...additionalApplicants];

export function getApplicantsByRequestId(requestId: string): Applicant[] {
  return mockApplicants
    .filter((applicant) => applicant.requestId === requestId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
