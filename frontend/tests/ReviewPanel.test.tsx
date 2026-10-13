import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewPanel } from '@/features/reviews/components/ReviewPanel';
import { ApiError } from '@/types/api';

const { getReviewsMock, createReviewMock, routerPushMock, routerRefreshMock } = vi.hoisted(() => ({
  getReviewsMock: vi.fn(), createReviewMock: vi.fn(), routerPushMock: vi.fn(), routerRefreshMock: vi.fn(),
}));
vi.mock('@/lib/api/reviews', () => ({ getTransactionReviews: getReviewsMock, createReview: createReviewMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPushMock, replace: vi.fn(), refresh: routerRefreshMock }) }));

const initial = {
  requestId: 'request-1', requestStatus: 'completed', completedAt: '2026-10-12T10:00:00Z',
  items: [], viewerRole: 'buyer', canWrite: true, mine: null, received: null,
};
const review = { id: 'review-1', reviewerRole: 'buyer', rating: 5, body: '좋은 거래였어요.', createdAt: '2026-10-12T10:00:00Z' };
function apiError(code: string, status: number, fields: ApiError['fields'] = {}) {
  return new ApiError({ code: code as ApiError['code'], message: '서버 안내', status, fields });
}
function renderPanel(overrides: { viewerRole?: string | null; canWrite?: boolean; mine?: unknown; received?: unknown; items?: unknown[] } = {}) {
  return render(<ReviewPanel requestId="request-1" roomId="room-1" initial={{ ...initial, ...overrides } as never} />);
}

describe('ReviewPanel', () => {
  beforeEach(() => {
    getReviewsMock.mockReset(); createReviewMock.mockReset(); routerPushMock.mockReset(); routerRefreshMock.mockReset();
  });

  it('shows the public visibility warning before submission and keeps submit disabled until valid', async () => {
    renderPanel();
    expect(screen.getByText('후기는 등록하면 누구나 볼 수 있게 공개되고, 수정하거나 삭제할 수 없어요. 연락처 같은 개인정보는 적지 마세요.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '후기 남기기' });
    expect(submit).toBeDisabled();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: ' 한 ' } });
    expect(screen.getByText('3/500')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('radio', { name: '5점' }));
    fireEvent.change(textarea, { target: { value: ' 좋은 거래 ' } });
    expect(screen.getByRole('button', { name: '후기 남기기' })).toBeEnabled();
  });

  it('submits a review and replaces the form with the participant card and public link', async () => {
    createReviewMock.mockResolvedValue({ review, created: true });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('radio', { name: '5점' }));
    await user.type(screen.getByRole('textbox'), '좋은 거래였어요.');
    await user.click(screen.getByRole('button', { name: '후기 남기기' }));
    await waitFor(() => expect(createReviewMock).toHaveBeenCalledWith('request-1', { rating: 5, body: '좋은 거래였어요.' }));
    expect(await screen.findByText('내가 남긴 후기')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '공개된 후기 보기' })).toHaveAttribute('href', '/requests/request-1#reviews');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('reloads after ALREADY_REVIEWED and shows stored review', async () => {
    getReviewsMock.mockResolvedValue({ ...initial, canWrite: false, mine: review });
    createReviewMock.mockRejectedValue(apiError('ALREADY_REVIEWED', 409));
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('radio', { name: '4점' }));
    await user.type(screen.getByRole('textbox'), '중복 후기 재조회');
    await user.click(screen.getByRole('button', { name: '후기 남기기' }));
    expect(await screen.findByText('이미 작성한 후기가 있어요.')).toBeInTheDocument();
    expect(getReviewsMock).toHaveBeenCalledWith('request-1', expect.anything());
    expect(await screen.findByText('내가 남긴 후기')).toBeInTheDocument();
  });

  it('shows server field errors and redirects unauthenticated users to the chat', async () => {
    createReviewMock.mockRejectedValueOnce(apiError('VALIDATION_ERROR', 422, { rating: '별점을 선택해 주세요.' }));
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('radio', { name: '5점' }));
    await user.type(screen.getByRole('textbox'), '유효한 후기');
    await user.click(screen.getByRole('button', { name: '후기 남기기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('별점을 선택해 주세요.');

    createReviewMock.mockRejectedValueOnce(apiError('UNAUTHENTICATED', 401));
    await user.click(screen.getByRole('button', { name: '후기 남기기' }));
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/login?next=/chats/room-1'));
  });

  it('does not render a participant write panel for a public anonymous view', () => {
    const { container } = renderPanel({ viewerRole: null, canWrite: false });
    expect(container).toBeEmptyDOMElement();
  });
});
