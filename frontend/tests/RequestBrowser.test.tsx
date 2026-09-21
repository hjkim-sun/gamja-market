import type { ComponentProps } from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestBrowser } from '@/features/requests/components/RequestBrowser';

const replace = vi.fn();
const push = vi.fn();
let search = '';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace, push }),
  useSearchParams: () => new URLSearchParams(search),
}));

const items = [
  {
    id: 'request-old-expensive',
    title: '서버가 첫 번째로 준 요청',
    category: '가전',
    condition: 'used',
    priceMin: 700_000,
    priceMax: 900_000,
    region: '서울',
    status: 'closed',
    thumbnailUrl: null,
    applicantCount: 8,
    createdAt: '2026-09-01T00:00:00+00:00',
    isOwner: false,
  },
  {
    id: 'request-new-cheap',
    title: '서버가 두 번째로 준 요청',
    category: '디지털기기',
    condition: 'like_new',
    priceMin: 100_000,
    priceMax: 200_000,
    region: '부산',
    status: 'open',
    thumbnailUrl: null,
    applicantCount: 0,
    createdAt: '2026-09-21T00:00:00+00:00',
    isOwner: false,
  },
];

function renderBrowser(overrides: Record<string, unknown> = {}) {
  const props = {
    items,
    total: 37,
    page: 1,
    pageSize: 12,
    categories: ['디지털기기', '가전'],
    ...overrides,
  } as unknown as ComponentProps<typeof RequestBrowser>;
  return render(<RequestBrowser {...props} />);
}

describe('RequestBrowser 서버 제공 결과', () => {
  beforeEach(() => {
    search = '';
    replace.mockClear();
    push.mockClear();
  });

  it('카테고리 변경은 URL에 반영하고 기존 page를 제거한다', async () => {
    search = 'q=ipad&page=4';
    const user = userEvent.setup();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '가전' }));

    expect(replace).toHaveBeenCalledWith('/?q=ipad&category=%EA%B0%80%EC%A0%84', { scroll: false });
  });

  it('정렬을 바꾸며 latest는 sort와 page 파라미터를 제거한다', async () => {
    search = 'sort=price&page=3';
    const user = userEvent.setup();
    renderBrowser();

    await user.selectOptions(screen.getByLabelText('구매요청 정렬'), 'latest');

    expect(replace).toHaveBeenCalledWith('/', { scroll: false });
  });

  it('items를 클라이언트에서 다시 정렬하거나 필터링하지 않고 받은 순서로 표시한다', () => {
    search = 'category=디지털기기&status=open&sort=price&q=두번째';
    renderBrowser();

    const links = screen.getAllByRole('link', { name: /상세 보기/ });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAccessibleName('서버가 첫 번째로 준 요청 상세 보기');
    expect(links[1]).toHaveAccessibleName('서버가 두 번째로 준 요청 상세 보기');
  });

  it('표시 개수는 items.length가 아니라 서버 total을 사용한다', () => {
    renderBrowser({ items: items.slice(0, 1), total: 37 });
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText('37').parentElement).toHaveTextContent('37개의 요청');
  });

  it('한 페이지 이하면 페이지네이션을 숨기고, 초과하면 다음 페이지 URL을 push한다', async () => {
    const { unmount } = renderBrowser({ total: 12, pageSize: 12 });
    expect(screen.queryByRole('button', { name: /다음/ })).not.toBeInTheDocument();
    unmount();

    search = 'category=%EA%B0%80%EC%A0%84&page=1';
    const user = userEvent.setup();
    renderBrowser({ total: 25, page: 1, pageSize: 12 });
    await user.click(screen.getByRole('button', { name: /다음/ }));

    expect(push).toHaveBeenCalled();
    expect(push.mock.calls[0]?.[0]).toBe('/?category=%EA%B0%80%EC%A0%84&page=2');
  });
});
