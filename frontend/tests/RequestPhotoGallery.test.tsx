import type { ComponentProps } from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { RequestDetail } from '@/features/requests/components/RequestDetail';

const baseRequest = {
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
  isOwner: false,
  description: 'M2 모델이며 상태가 깨끗한 제품을 찾고 있습니다.',
  updatedAt: '2026-09-21T08:30:00+00:00',
  buyer: { id: 'buyer', maskedEmail: 'bu***@example.com' },
  photos: [],
};

function renderDetail(photos: Array<{ id: string; url: string }>) {
  const props = {
    request: { ...baseRequest, photos },
    applicants: [],
  } as unknown as ComponentProps<typeof RequestDetail>;
  return render(<RequestDetail {...props} />);
}

describe('RequestPhotoGallery', () => {
  it('사진이 없으면 갤러리를 렌더하지 않는다', () => {
    renderDetail([]);
    expect(screen.queryByRole('img', { name: /사진/ })).not.toBeInTheDocument();
  });

  it('세 장의 썸네일 버튼과 선택 상태를 제공하고 큰 이미지를 교체한다', async () => {
    const user = userEvent.setup();
    const photos = [1, 2, 3].map((number) => ({
      id: `photo-${number}`,
      url: `https://cdn.example.com/${number}.jpg`,
    }));
    renderDetail(photos);

    expect(screen.getByRole('img', { name: `${baseRequest.title} 사진 1/3` })).toHaveAttribute(
      'src', photos[0].url,
    );
    const second = screen.getByRole('button', { name: '사진 2 / 3' });
    expect(second).toHaveAttribute('aria-pressed', 'false');
    await user.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: `${baseRequest.title} 사진 2/3` })).toHaveAttribute(
      'src', photos[1].url,
    );
  });
});
