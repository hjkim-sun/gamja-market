import type { ComponentProps } from 'react';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RequestDetail } from '@/features/requests/components/RequestDetail';

const request = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '아이패드 프로를 구합니다',
  category: '디지털기기',
  condition: 'like_new',
  priceMin: 600_000,
  priceMax: 800_000,
  region: '서울 강남구',
  status: 'open',
  thumbnailUrl: null,
  applicantCount: 0,
  createdAt: '2026-09-21T08:30:00+00:00',
  isOwner: true,
  description: 'M2 모델이며 상태가 깨끗한 제품을 찾고 있습니다.',
  updatedAt: '2026-09-21T08:30:00+00:00',
  buyer: {
    id: '00000000-0000-4000-8000-000000000010',
    maskedEmail: 'bu***@example.com',
  },
  photos: [],
};

function renderDetail() {
  const props = {
    request,
    applications: [],
    viewerRole: 'owner',
    applicantCount: 0,
  } as unknown as ComponentProps<typeof RequestDetail>;
  return render(<RequestDetail {...props} />);
}

describe('RequestDetail', () => {
  it('구매자 마스킹 이메일만 표시하고 원본 이메일은 노출하지 않는다', () => {
    renderDetail();
    const buyer = screen.getByRole('complementary', { name: '구매자 정보' });
    expect(buyer).toHaveTextContent('bu***@example.com');
    expect(buyer).not.toHaveTextContent('buyer@example.com');
  });

  it('isOwner가 true여도 범위 밖인 수정·삭제 액션을 렌더하지 않는다', () => {
    renderDetail();
    expect(screen.queryByRole('button', { name: /수정/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /삭제/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /수정/ })).not.toBeInTheDocument();
  });

  it('지원자 0건을 정직하게 표시하고 가짜 판매자를 만들지 않는다', () => {
    renderDetail();
    expect(screen.getByRole('heading', { name: '지원한 판매자 0명' })).toBeInTheDocument();
    expect(screen.getByText('아직 지원한 판매자가 없어요')).toBeInTheDocument();
    expect(screen.queryByText(/sellerA|판매자A|minji/)).not.toBeInTheDocument();
    expect(screen.queryByText('판매자 지원 기능은 4단계에서 열립니다.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지원하기 · 준비 중' })).not.toBeInTheDocument();
  });
});
