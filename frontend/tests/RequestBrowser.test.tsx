import type { ComponentProps } from 'react';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestBrowser } from '@/features/requests/components/RequestBrowser';
import { MAX_LIST_PAGE } from '@/lib/api/requests';

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

const CATEGORY_DEBOUNCE_MS = 300;

function flushCategoryDebounce() {
  act(() => {
    vi.advanceTimersByTime(CATEGORY_DEBOUNCE_MS);
  });
}

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

function renderBrowser(overrides: Record<string, unknown> = {}) {
  const props = {
    items,
    total: 37,
    page: 1,
    pageSize: 12,
    categories: ['디지털기기', '가전', '의류'],
    ...overrides,
  } as unknown as ComponentProps<typeof RequestBrowser>;
  return render(<RequestBrowser {...props} />);
}

describe('RequestBrowser 서버 제공 결과', () => {
  beforeEach(() => {
    search = '';
    replace.mockClear();
    push.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('카테고리 변경은 URL에 반영하고 기존 page를 제거한다', async () => {
    search = 'q=ipad&page=4';
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '가전' }));
    flushCategoryDebounce();

    expect(replace).toHaveBeenCalledWith('/?q=ipad&category=%EA%B0%80%EC%A0%84', { scroll: false });
  });

  it('이미 선택된 카테고리에 다른 카테고리를 더하면 category가 2개이며 정의 순서로 정렬된다', async () => {
    search = 'category=가전&status=open&page=3';
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '디지털기기' }));
    flushCategoryDebounce();

    const [target, options] = replace.mock.calls[0] as [string, unknown];
    const params = new URL(target, 'http://localhost').searchParams;
    expect(params.getAll('category')).toEqual(['디지털기기', '가전']);
    expect(params.get('status')).toBe('open');
    expect(params.has('page')).toBe(false);
    expect(options).toEqual({ scroll: false });
  });

  it('선택된 카테고리를 다시 클릭하면 해제하고 마지막 선택이면 category를 모두 제거한다', async () => {
    search = 'category=가전&category=의류';
    const user = setupUser();
    const { unmount } = renderBrowser();

    await user.click(screen.getByRole('button', { name: '가전' }));
    flushCategoryDebounce();
    expect(new URL(replace.mock.calls[0]?.[0] as string, 'http://localhost').searchParams.getAll('category')).toEqual(['의류']);
    unmount();

    search = 'category=의류';
    renderBrowser();
    await user.click(screen.getByRole('button', { name: '의류' }));
    flushCategoryDebounce();
    expect(replace).toHaveBeenLastCalledWith('/', { scroll: false });
  });

  it('searchParams가 갱신되기 전에 두 카테고리를 빠르게 연속 클릭해도 최종 URL에 둘 다 담고 replace는 1회만 호출한다', async () => {
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '의류' }));
    await user.click(screen.getByRole('button', { name: '가전' }));

    // debounce 전에는 URL을 건드리지 않지만 버튼은 즉시 눌림 상태가 된다.
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '의류' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '가전' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-pressed', 'false');

    flushCategoryDebounce();

    expect(replace).toHaveBeenCalledTimes(1);
    const params = new URL(replace.mock.calls[0]?.[0] as string, 'http://localhost').searchParams;
    expect(params.getAll('category')).toEqual(['가전', '의류']);
  });

  it('같은 카테고리를 빠르게 두 번 누르면 원래 상태로 돌아가 URL이 변하지 않는 replace를 보낸다', async () => {
    search = 'category=가전';
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '의류' }));
    await user.click(screen.getByRole('button', { name: '의류' }));
    flushCategoryDebounce();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/?category=%EA%B0%80%EC%A0%84', { scroll: false });
  });

  it('전체는 debounce 없이 즉시 반영하고 대기 중인 카테고리 변경을 취소한다', async () => {
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '가전' }));
    await user.click(screen.getByRole('button', { name: '전체' }));

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/', { scroll: false });
    expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-pressed', 'true');
    flushCategoryDebounce();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('대기 중에 다른 필터를 바꾸면 선택한 카테고리를 함께 반영하고 타이머는 한 번만 쓴다', async () => {
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '가전' }));
    await user.selectOptions(screen.getByLabelText('구매요청 정렬'), 'price');

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/?category=%EA%B0%80%EC%A0%84&sort=price', { scroll: false });
    flushCategoryDebounce();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('뒤로가기 등으로 searchParams가 외부에서 바뀌면 선택 상태를 동기화한다', () => {
    search = 'category=가전';
    const { rerender } = renderBrowser();
    expect(screen.getByRole('button', { name: '가전' })).toHaveAttribute('aria-pressed', 'true');

    search = 'category=의류';
    rerender(<RequestBrowser {...({ items, total: 37, page: 1, pageSize: 12, categories: ['디지털기기', '가전', '의류'] } as ComponentProps<typeof RequestBrowser>)} />);

    expect(screen.getByRole('button', { name: '가전' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '의류' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('언마운트하면 대기 중인 URL 갱신 타이머를 정리한다', async () => {
    const user = setupUser();
    const { unmount } = renderBrowser();

    await user.click(screen.getByRole('button', { name: '가전' }));
    unmount();
    flushCategoryDebounce();

    expect(replace).not.toHaveBeenCalled();
  });

  it('전체를 누르면 모든 카테고리를 해제하고 다른 필터는 유지한다', async () => {
    search = 'category=가전&category=의류&q=ipad&page=2';
    const user = setupUser();
    renderBrowser();

    await user.click(screen.getByRole('button', { name: '전체' }));

    expect(replace).toHaveBeenCalledWith('/?q=ipad', { scroll: false });
  });

  it('선택된 카테고리는 aria-pressed=true이고 선택이 없을 때만 전체가 활성이다', () => {
    search = 'category=가전&category=의류';
    const { unmount } = renderBrowser();

    expect(screen.getByRole('button', { name: '가전' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '의류' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '디지털기기' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-pressed', 'false');
    unmount();

    search = '';
    renderBrowser();
    expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '가전' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('정렬을 바꾸며 latest는 sort와 page 파라미터를 제거한다', async () => {
    search = 'sort=price&page=3';
    const user = setupUser();
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
    const user = setupUser();
    renderBrowser({ total: 25, page: 1, pageSize: 12 });
    await user.click(screen.getByRole('button', { name: /다음/ }));

    expect(push).toHaveBeenCalled();
    expect(push.mock.calls[0]?.[0]).toBe('/?category=%EA%B0%80%EC%A0%84&page=2');
  });

  it('총 페이지가 상한을 넘어도 MAX_LIST_PAGE까지만 표시하고 마지막 페이지에서 다음을 비활성화한다', async () => {
    search = `page=${MAX_LIST_PAGE}`;
    const user = setupUser();
    renderBrowser({ total: 12 * (MAX_LIST_PAGE + 50), page: MAX_LIST_PAGE, pageSize: 12 });

    expect(screen.getByText(`${MAX_LIST_PAGE} / ${MAX_LIST_PAGE}`)).toBeInTheDocument();
    const next = screen.getByRole('button', { name: /다음/ });
    expect(next).toBeDisabled();
    await user.click(next);
    expect(push).not.toHaveBeenCalled();
  });

  it('상한 직전 페이지에서는 MAX_LIST_PAGE로 이동하고 그 너머 URL은 만들지 않는다', async () => {
    search = `page=${MAX_LIST_PAGE - 1}`;
    const user = setupUser();
    renderBrowser({ total: 12 * (MAX_LIST_PAGE + 50), page: MAX_LIST_PAGE - 1, pageSize: 12 });

    await user.click(screen.getByRole('button', { name: /다음/ }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(`/?page=${MAX_LIST_PAGE}`);
  });
});
