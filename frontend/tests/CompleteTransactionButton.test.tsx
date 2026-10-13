import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompleteTransactionButton } from '@/features/transactions/components/CompleteTransactionButton';
import { ApiError } from '@/types/api';

const { refreshMock, completeMock } = vi.hoisted(() => ({ refreshMock: vi.fn(), completeMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: refreshMock }) }));
vi.mock('@/lib/api/reviews', () => ({ completeTransaction: completeMock }));

const result = {
  request: { id: 'request-1', status: 'completed', completedAt: '2026-10-12T10:00:00Z' },
  acceptedApplicationId: 'application-1',
  chatRoomId: 'room-1',
};

function apiError(code: string, status: number) {
  return new ApiError({ code: code as ApiError['code'], message: '서버 안내', status, fields: {} });
}

describe('CompleteTransactionButton', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    completeMock.mockReset();
  });

  it('requires confirmation and lets the buyer cancel without a request', async () => {
    const user = userEvent.setup();
    render(<CompleteTransactionButton requestId="request-1" />);
    await user.click(screen.getByRole('button', { name: '거래 완료' }));
    expect(screen.getByText('물건을 받으셨나요? 거래를 완료하면 채팅이 종료되고 되돌릴 수 없어요.')).toBeInTheDocument();
    expect(completeMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByRole('button', { name: '거래 완료' })).toBeInTheDocument();
  });

  it('disables confirmation while pending and refreshes after success', async () => {
    let resolve: (value: typeof result) => void = () => {};
    completeMock.mockImplementation(() => new Promise<typeof result>((done) => (resolve = done)));
    const user = userEvent.setup();
    render(<CompleteTransactionButton requestId="request-1" />);
    await user.click(screen.getByRole('button', { name: '거래 완료' }));
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(screen.getByRole('button', { name: '완료 중…' })).toBeDisabled();
    expect(completeMock).toHaveBeenCalledWith('request-1');
    resolve(result);
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['REQUEST_NOT_MATCHED', 409, true],
    ['COMPLETION_FORBIDDEN', 403, false],
    ['UNAUTHENTICATED', 401, false],
    ['SERVICE_UNAVAILABLE', 503, false],
  ] as const)('%s presents a safe result for status %i', async (code, status, refresh) => {
    completeMock.mockRejectedValue(apiError(code, status));
    const user = userEvent.setup();
    render(<CompleteTransactionButton requestId="request-1" />);
    await user.click(screen.getByRole('button', { name: '거래 완료' }));
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalledTimes(refresh ? 1 : 0);
  });
});
