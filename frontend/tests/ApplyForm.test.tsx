import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApplyForm } from '@/features/applications/components/ApplyForm';
import { applyToRequest } from '@/lib/api/applications';
import { ApiError } from '@/types/api';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('@/lib/api/applications', () => ({ applyToRequest: vi.fn() }));

const requestId = '00000000-0000-4000-8000-000000000001';
const mockedApply = vi.mocked(applyToRequest);

function renderForm() {
  return render(
    <ApplyForm requestId={requestId} priceMin={600_000} priceMax={800_000} />,
  );
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('제시가'), '750000');
  await user.type(screen.getByLabelText('지원 메시지'), '구성품을 모두 보유하고 있습니다.');
}

describe('ApplyForm', () => {
  afterEach(() => {
    mockedApply.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  it.each([
    ['', '구성품을 모두 보유하고 있습니다.', '제시가'],
    ['-1', '구성품을 모두 보유하고 있습니다.', '제시가'],
    ['1.5', '구성품을 모두 보유하고 있습니다.', '제시가'],
    ['1000000001', '구성품을 모두 보유하고 있습니다.', '제시가'],
    ['750000', '한', '지원 메시지'],
    ['750000', '가'.repeat(501), '지원 메시지'],
  ])('잘못된 입력을 API로 보내지 않는다', async (price, message, invalidLabel) => {
    const user = userEvent.setup();
    renderForm();
    if (price) await user.type(screen.getByLabelText('제시가'), price);
    await user.type(screen.getByLabelText('지원 메시지'), message);
    await user.click(screen.getByRole('button', { name: '지원 제출' }));

    expect(mockedApply).not.toHaveBeenCalled();
    const invalidInput = screen.getByLabelText(invalidLabel);
    expect(invalidInput).toHaveAttribute('aria-invalid', 'true');
    expect(invalidInput).toHaveAttribute('aria-describedby');
  });

  it('성공하면 한 번만 제출하고 채팅방으로 이동한다', async () => {
    type ApplyResult = Awaited<ReturnType<typeof applyToRequest>>;
    let resolveRequest!: (value: ApplyResult) => void;
    mockedApply.mockImplementation(
      () => new Promise<ApplyResult>((resolve) => { resolveRequest = resolve; }),
    );
    const user = userEvent.setup();
    renderForm();
    await fillValid(user);
    const submit = screen.getByRole('button', { name: '지원 제출' });
    await user.dblClick(submit);
    expect(mockedApply).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    resolveRequest(
      { chatRoom: { id: 'room-1' }, application: {} } as unknown as ApplyResult,
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/chats/room-1'));
  });

  it.each([
    [409, 'ALREADY_APPLIED', true],
    [409, 'REQUEST_NOT_OPEN', true],
    [403, 'SELF_APPLICATION_FORBIDDEN', false],
  ])('서버 오류 %s/%s를 안내하고 필요한 경우 refresh한다', async (status, code, shouldRefresh) => {
    mockedApply.mockRejectedValue(
      new ApiError({ code: code as never, message: '서버 안내', status, fields: {} }),
    );
    const user = userEvent.setup();
    renderForm();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: '지원 제출' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('서버 안내');
    expect(refresh).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
  });

  it('401은 입력을 보존하고 재로그인 링크를 보여준다', async () => {
    mockedApply.mockRejectedValue(
      new ApiError({ code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.', status: 401 }),
    );
    const user = userEvent.setup();
    renderForm();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: '지원 제출' }));
    expect(await screen.findByRole('link', { name: /로그인/ })).toHaveAttribute(
      'href',
      `/login?next=/requests/${requestId}`,
    );
    expect(screen.getByLabelText('제시가')).toHaveValue(750000);
    expect(screen.getByLabelText('지원 메시지')).toHaveValue('구성품을 모두 보유하고 있습니다.');
  });

  it('희망가 밖 제시가는 비차단 안내만 보여주고 제출할 수 있다', async () => {
    mockedApply.mockResolvedValue({
      application: {} as never,
      chatRoom: { id: 'room-2' } as never,
    });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('제시가'), '500000');
    await user.type(screen.getByLabelText('지원 메시지'), '유효한 지원 메시지입니다.');
    expect(screen.getByText(/희망가 범위 밖/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '지원 제출' }));
    await waitFor(() => expect(mockedApply).toHaveBeenCalledTimes(1));
  });

  it('메시지 길이를 UTF-16 단위가 아닌 Unicode codepoint 단위로 검증한다', async () => {
    mockedApply.mockResolvedValue({
      application: {} as never,
      chatRoom: { id: 'room-emoji' } as never,
    });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('제시가'), '750000');
    const message = screen.getByLabelText('지원 메시지');

    await user.type(message, '😀');
    await user.click(screen.getByRole('button', { name: '지원 제출' }));
    expect(mockedApply).not.toHaveBeenCalled();
    expect(message).toHaveAttribute('aria-invalid', 'true');

    await user.clear(message);
    await user.type(message, '😀😀');
    expect(screen.getByText('2/500')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '지원 제출' }));

    await waitFor(() =>
      expect(mockedApply).toHaveBeenCalledWith(requestId, {
        offerPrice: 750000,
        message: '😀😀',
      }),
    );
    expect(push).toHaveBeenCalledWith('/chats/room-emoji');
  });
});
