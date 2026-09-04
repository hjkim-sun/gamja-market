import type { UserSummary } from '@/types/request';

export const mockUsers = {
  minji: { id: 'user-001', nickname: '감자찾는민지', region: '서울 강남구' },
  junho: { id: 'user-002', nickname: '준호네창고', region: '서울 마포구' },
  sora: { id: 'user-003', nickname: '소라빛', region: '경기 성남시' },
  potato: { id: 'user-004', nickname: '포슬포슬', region: '서울 송파구' },
  garden: { id: 'user-005', nickname: '초록정원', region: '서울 성동구' },
  bookworm: { id: 'user-006', nickname: '책벌레감자', region: '서울 관악구' },
  sellerA: { id: 'seller-001', nickname: '테크정리중', region: '서울 서초구' },
  sellerB: { id: 'seller-002', nickname: '사과농장', region: '서울 강동구' },
  sellerC: { id: 'seller-003', nickname: '패드졸업생', region: '경기 하남시' },
} satisfies Record<string, UserSummary>;
