import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RequestCard } from '@/features/requests/components/RequestCard';

const request = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '아이패드 프로를 구합니다',
  category: '디지털기기',
  condition: 'like_new' as const,
  priceMin: 600_000,
  priceMax: 800_000,
  region: '서울 강남구',
  status: 'open' as const,
  thumbnailUrl: 'https://cdn.example.com/photo.jpg',
  applicantCount: 0,
  createdAt: '2026-09-21T08:30:00+00:00',
  isOwner: false,
};

describe('RequestCard 사진', () => {
  it('대표 사진을 지연 디코딩하고 접근 가능한 대체 텍스트를 제공한다', () => {
    render(<RequestCard request={request} />);
    const image = screen.getByRole('img', { name: `${request.title} 참고 이미지` });
    expect(image).toHaveAttribute('src', request.thumbnailUrl);
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('대표 사진이 없으면 카테고리 자리표시자를 유지한다', () => {
    const { container } = render(<RequestCard request={{ ...request, thumbnailUrl: null }} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('💻');
  });
});
