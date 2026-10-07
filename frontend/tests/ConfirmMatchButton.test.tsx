import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmMatchButton } from '@/features/matching/components/ConfirmMatchButton';
import { ApiError } from '@/types/api';

const { routerRefresh, confirmMatchMock } = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  confirmMatchMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
}));

vi.mock('@/lib/api/applications', () => ({ confirmMatch: confirmMatchMock }));

const matchResult = {
  request: { id: 'request-1', status: 'matched' as const },
  acceptedApplicationId: 'application-1',
  chatRoomId: 'room-1',
  closedApplicationCount: 2,
};

function apiError(code: ApiError['code'], status: number, message = '서버 메시지') {
  return new ApiError({ code, message, status });
}

function renderButton(pendingOthers?: number) {
  return render(
    <ConfirmMatchButton requestId="request-1" applicationId="application-1" pendingOthers={pendingOthers} />,
  );
}

async function openConfirmPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '이 판매자로 확정' }));
}

describe('ConfirmMatchButton', () => {
  beforeEach(() => {
    routerRefresh.mockReset();
    confirmMatchMock.mockReset();
  });

  it('누르면 요청 없이 확인 패널만 열고, 취소하면 원래 버튼으로 돌아간다', async () => {
    const user = userEvent.setup();
    renderButton(2);

    await openConfirmPanel(user);
    expect(screen.getByText('확정하면 다른 지원 2건은 자동으로 마감되고 되돌릴 수 없어요.')).toBeInTheDocument();
    expect(confirmMatchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByRole('button', { name: '이 판매자로 확정' })).toBeInTheDocument();
    expect(confirmMatchMock).not.toHaveBeenCalled();
  });

  it('pendingOthers를 모르면 일반 문구를 쓴다', async () => {
    const user = userEvent.setup();
    renderButton();
    await openConfirmPanel(user);
    expect(screen.getByText('다른 지원은 자동으로 마감되고 되돌릴 수 없어요.')).toBeInTheDocument();
  });

  it('진행 중에는 버튼이 비활성이라 중복 요청이 나가지 않고, 성공하면 router.refresh를 부른다', async () => {
    let resolveMatch: (value: typeof matchResult) => void = () => {};
    confirmMatchMock.mockImplementation(
      () => new Promise<typeof matchResult>((resolve) => (resolveMatch = resolve)),
    );
    const user = userEvent.setup();
    renderButton(1);

    await openConfirmPanel(user);
    await user.click(screen.getByRole('button', { name: '확정' }));

    const submitting = screen.getByRole('button', { name: '확정 중…' });
    expect(submitting).toBeDisabled();
    expect(screen.getByRole('button', { name: '취소' })).toBeDisabled();
    await user.click(submitting);
    expect(confirmMatchMock).toHaveBeenCalledTimes(1);
    expect(confirmMatchMock.mock.calls[0].slice(0, 2)).toEqual(['request-1', 'application-1']);
    expect(routerRefresh).not.toHaveBeenCalled();

    resolveMatch(matchResult);
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it.each(['REQUEST_ALREADY_MATCHED', 'REQUEST_CLOSED'] as const)(
    '%s는 서버 문구를 보여주고 최신 상태로 새로고침한다',
    async (code) => {
      confirmMatchMock.mockRejectedValue(apiError(code, 409, '이미 처리된 요청입니다.'));
      const user = userEvent.setup();
      renderButton(1);

      await openConfirmPanel(user);
      await user.click(screen.getByRole('button', { name: '확정' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('이미 처리된 요청입니다.');
      expect(routerRefresh).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['NOT_REQUEST_OWNER', 403],
    ['NOT_FOUND', 404],
  ] as const)('%s는 서버 문구를 보여주지만 새로고침하지 않는다', async (code, status) => {
    confirmMatchMock.mockRejectedValue(apiError(code, status, '확정할 수 없습니다.'));
    const user = userEvent.setup();
    renderButton(1);

    await openConfirmPanel(user);
    await user.click(screen.getByRole('button', { name: '확정' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('확정할 수 없습니다.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it.each([
    apiError('SERVICE_UNAVAILABLE', 503, '내부 정보가 담긴 문구'),
    apiError('NETWORK_ERROR', 0),
  ])('503/네트워크 오류는 일반 재시도 안내를 보여주고 다시 확정할 수 있다', async (error) => {
    confirmMatchMock.mockRejectedValueOnce(error).mockResolvedValueOnce(matchResult);
    const user = userEvent.setup();
    renderButton(1);

    await openConfirmPanel(user);
    await user.click(screen.getByRole('button', { name: '확정' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('잠시 후 다시 시도해 주세요.');
    expect(screen.queryByText('내부 정보가 담긴 문구')).not.toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();

    // 확인 패널이 유지되어 같은 지원을 다시 확정할 수 있다(서버가 멱등 처리).
    await user.click(screen.getByRole('button', { name: '확정' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(confirmMatchMock).toHaveBeenCalledTimes(2);
  });
});
