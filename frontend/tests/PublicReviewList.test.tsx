import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicReviewList } from '@/features/reviews/components/PublicReviewList';

const getReviewsMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/reviews', () => ({ getTransactionReviews: getReviewsMock }));

const base = {
  requestId: 'request-1', requestStatus: 'completed', completedAt: '2026-10-12T10:00:00Z',
  viewerRole: null, canWrite: false, mine: null, received: null,
};
const buyerReview = { reviewerRole: 'buyer', rating: 5, body: '빠르고 친절했어요.', createdAt: '2026-10-12T10:00:00Z' };
const sellerReview = { reviewerRole: 'seller', rating: 4, body: '좋은 구매자였습니다.', createdAt: '2026-10-12T11:00:00Z' };

function renderList(items: typeof buyerReview[] | null = [buyerReview, sellerReview]) {
  const initial = items === null ? null : { ...base, items };
  return render(<PublicReviewList requestId="request-1" initial={initial as never} />);
}

describe('PublicReviewList', () => {
  beforeEach(() => getReviewsMock.mockReset());

  it('renders public role, score and body without identity fields', () => {
    renderList();
    expect(screen.getByRole('heading', { name: '거래 후기' })).toBeInTheDocument();
    expect(screen.getByText('구매자가 남긴 후기')).toBeInTheDocument();
    expect(screen.getByText('판매자가 남긴 후기')).toBeInTheDocument();
    expect(screen.getByText('5점 만점에 5점')).toBeInTheDocument();
    expect(screen.getByText('빠르고 친절했어요.')).toBeInTheDocument();
    expect(screen.queryByText(/@|buyer@example|seller@example/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/내가 남긴 후기|상대방이 남긴 후기/)).not.toBeInTheDocument();
  });

  it('renders one review and the empty state for zero reviews', () => {
    const { rerender } = renderList([buyerReview]);
    expect(screen.getByText('구매자가 남긴 후기')).toBeInTheDocument();
    expect(screen.queryByText('판매자가 남긴 후기')).not.toBeInTheDocument();
    rerender(<PublicReviewList requestId="request-1" initial={{ ...base, items: [] } as never} />);
    expect(screen.getByText('아직 등록된 후기가 없어요.')).toBeInTheDocument();
  });

  it('fetches once after SSR failure, offers retry and disables retry while loading', async () => {
    let resolve: (value: unknown) => void = () => {};
    getReviewsMock.mockRejectedValueOnce(new Error('unavailable')).mockImplementationOnce(
      () => new Promise((done) => (resolve = done)),
    );
    renderList(null);
    expect(await screen.findByRole('alert')).toHaveTextContent('후기를 불러오지 못했어요.');
    expect(getReviewsMock).toHaveBeenCalledTimes(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(screen.getByRole('button', { name: '불러오는 중…' })).toBeDisabled();
    resolve({ ...base, items: [buyerReview] });
    await waitFor(() => expect(screen.getByText('구매자가 남긴 후기')).toBeInTheDocument());
    expect(getReviewsMock).toHaveBeenCalledTimes(2);
  });

  it('does not keep the previous request reviews when the request changes and SSR data is missing', async () => {
    getReviewsMock.mockResolvedValueOnce({ ...base, requestId: 'request-2', items: [sellerReview] });
    const { rerender } = renderList([buyerReview]);
    expect(screen.getByText('구매자가 남긴 후기')).toBeInTheDocument();
    rerender(<PublicReviewList requestId="request-2" initial={null} />);
    expect(screen.queryByText('구매자가 남긴 후기')).not.toBeInTheDocument();
    expect(await screen.findByText('판매자가 남긴 후기')).toBeInTheDocument();
    expect(getReviewsMock).toHaveBeenCalledWith('request-2', expect.anything());
  });
});
