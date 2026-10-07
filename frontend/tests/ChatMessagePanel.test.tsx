import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatMessagePanel } from '@/features/chat/components/ChatMessagePanel';
import { ApiError } from '@/types/api';
import type { ChatRoom } from '@/types/application';
import type { ChatMessage, MessageList, MessageRoomState } from '@/types/chat';

const { listMessagesMock, sendMessageMock, routerPush, routerRefresh, router } = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return {
    listMessagesMock: vi.fn(),
    sendMessageMock: vi.fn(),
    routerPush: push,
    routerRefresh: refresh,
    // 실제 Next 라우터처럼 렌더마다 같은 객체를 돌려준다.
    router: { push, replace: vi.fn(), refresh },
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api/chat', () => ({ listMessages: listMessagesMock, sendMessage: sendMessageMock }));

const room: ChatRoom = {
  id: 'room-1',
  applicationId: 'application-1',
  applicationStatus: 'pending',
  chatStatus: 'active',
  canSend: true,
  viewerRole: 'seller',
  request: { id: 'request-1', title: '아이패드 프로를 구합니다', status: 'open', priceMin: 600_000, priceMax: 800_000 },
  buyer: { id: 'buyer-1', maskedEmail: 'bu***@example.com' },
  seller: { id: 'seller-1', maskedEmail: 'se***@example.com' },
  offerPrice: 750_000,
  applicationMessage: '지원 메시지',
  createdAt: '2026-09-26T10:00:00+00:00',
};

const activeState: MessageRoomState = {
  id: 'room-1',
  chatStatus: 'active',
  canSend: true,
  applicationStatus: 'pending',
  requestStatus: 'open',
};
const closedState: MessageRoomState = {
  ...activeState,
  chatStatus: 'closed',
  canSend: false,
  applicationStatus: 'closed',
  requestStatus: 'matched',
};

function msg(seq: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `message-${seq}`,
    seq,
    senderRole: 'buyer',
    isMine: false,
    body: `본문 ${seq}`,
    clientMessageId: `client-${seq}`,
    createdAt: '2026-10-07T10:00:00.000000Z',
    ...over,
  };
}

function list(items: ChatMessage[], over: Partial<MessageList> = {}): MessageList {
  return {
    room: activeState,
    items,
    latestSeq: items.length ? items[items.length - 1].seq : 0,
    hasMore: false,
    hasOlder: false,
    ...over,
  };
}

function apiError(code: ApiError['code'], status: number, fields: ApiError['fields'] = {}) {
  return new ApiError({ code, message: '서버 문구', status, fields });
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPanel(initial: MessageList | null = list([msg(1), msg(2)]), over: Partial<ChatRoom> = {}) {
  return render(<ChatMessagePanel room={{ ...room, ...over }} initialList={initial} />);
}

function afterSeqOf(callIndex: number): number | undefined {
  return listMessagesMock.mock.calls[callIndex][1].afterSeq;
}

describe('ChatMessagePanel 폴링', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listMessagesMock.mockReset();
    sendMessageMock.mockReset();
    routerPush.mockReset();
    routerRefresh.mockReset();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('SSR 메시지를 바로 보여주고 첫 폴링은 3초 뒤 latestSeq 이후부터 조회한다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel(list([msg(1), msg(2, { isMine: true })]));

    expect(screen.getByText('본문 1')).toBeInTheDocument();
    expect(screen.getByText('본문 2')).toBeInTheDocument();
    expect(listMessagesMock).not.toHaveBeenCalled();

    await advance(2_999);
    expect(listMessagesMock).not.toHaveBeenCalled();
    await advance(1);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    expect(listMessagesMock.mock.calls[0][0]).toBe('room-1');
    expect(afterSeqOf(0)).toBe(2);
  });

  it('응답이 끝난 뒤 3초마다 다시 조회한다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();

    await advance(3_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    await advance(2_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
    await advance(3_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(3);
  });

  it('이전 요청이 끝나기 전에는 다음 요청을 겹쳐 보내지 않는다', async () => {
    let resolveFirst: (value: MessageList) => void = () => {};
    listMessagesMock
      .mockImplementationOnce(() => new Promise<MessageList>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue(list([]));
    renderPanel();

    await advance(3_000);
    await advance(20_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst(list([])));
    await advance(2_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
  });

  it('hasMore면 기다리지 않고 바로 다음 조회를 한다', async () => {
    listMessagesMock
      .mockResolvedValueOnce(list([msg(3), msg(4)], { latestSeq: 6, hasMore: true }))
      .mockResolvedValueOnce(list([msg(5), msg(6)], { latestSeq: 6 }))
      .mockResolvedValue(list([]));
    renderPanel();

    await advance(3_000);
    // 응답을 처리한 직후(3초를 기다리지 않고 타이머 최소 틱 1ms 안에) 다음 조회가 나간다.
    await advance(1);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
    expect(afterSeqOf(0)).toBe(2);
    expect(afterSeqOf(1)).toBe(4);
    expect(screen.getByText('본문 6')).toBeInTheDocument();

    await advance(2_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(listMessagesMock).toHaveBeenCalledTimes(3);
    expect(afterSeqOf(2)).toBe(6);
  });

  it('탭이 숨겨지면 폴링을 멈추고 다시 보이면 즉시 한 번 조회한 뒤 주기를 재개한다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();

    await advance(1_000);
    act(() => setVisibility('hidden'));
    await advance(60_000);
    expect(listMessagesMock).not.toHaveBeenCalled();

    act(() => setVisibility('visible'));
    await advance(0);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    await advance(3_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
  });

  it('조회 중 탭이 숨겨지면 요청을 취소하고 그 응답은 무시한다', async () => {
    let signal: AbortSignal | undefined;
    let resolveFirst: (value: MessageList) => void = () => {};
    listMessagesMock.mockImplementationOnce(
      (_roomId: string, opts: { signal: AbortSignal }) =>
        new Promise<MessageList>((resolve) => {
          signal = opts.signal;
          resolveFirst = resolve;
        }),
    );
    renderPanel();

    await advance(3_000);
    expect(signal?.aborted).toBe(false);
    act(() => setVisibility('hidden'));
    expect(signal?.aborted).toBe(true);

    await act(async () => resolveFirst(list([msg(3)])));
    expect(screen.queryByText('본문 3')).not.toBeInTheDocument();
    await advance(60_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('연속 실패는 6s→12s→24s→30s 상한으로 백오프하고 2회째부터 안내하며 성공하면 3초로 돌아온다', async () => {
    listMessagesMock.mockRejectedValue(apiError('SERVICE_UNAVAILABLE', 503));
    renderPanel();

    await advance(3_000); // 실패 1 → 6초 뒤
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('연결이 불안정해요. 자동으로 다시 시도합니다.')).not.toBeInTheDocument();

    await advance(5_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    await advance(1); // 실패 2 → 12초 뒤
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('연결이 불안정해요. 자동으로 다시 시도합니다.');

    await advance(11_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
    await advance(1); // 실패 3 → 24초 뒤
    expect(listMessagesMock).toHaveBeenCalledTimes(3);

    await advance(23_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(3);
    await advance(1); // 실패 4 → 30초(상한) 뒤
    expect(listMessagesMock).toHaveBeenCalledTimes(4);

    await advance(29_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(4);
    await advance(1); // 실패 5 → 여전히 30초
    expect(listMessagesMock).toHaveBeenCalledTimes(5);

    listMessagesMock.mockResolvedValue(list([]));
    await advance(30_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(6);
    expect(screen.queryByText('연결이 불안정해요. 자동으로 다시 시도합니다.')).not.toBeInTheDocument();

    await advance(3_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(7);
  });

  it.each(['NETWORK_ERROR', 'INTERNAL_ERROR'] as const)('%s도 백오프로 재시도한다', async (code) => {
    listMessagesMock.mockRejectedValueOnce(apiError(code, 0)).mockResolvedValue(list([]));
    renderPanel();

    await advance(3_000);
    await advance(5_999);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
  });

  it('401이면 폴링을 멈추고 로그인으로 이동한다', async () => {
    listMessagesMock.mockRejectedValue(apiError('UNAUTHENTICATED', 401));
    renderPanel();

    await advance(3_000);
    expect(routerPush).toHaveBeenCalledWith('/login?next=/chats/room-1');
    await advance(120_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('404면 폴링을 멈추고 안내하며 입력을 비활성화한다', async () => {
    listMessagesMock.mockRejectedValue(apiError('NOT_FOUND', 404));
    renderPanel();

    await advance(3_000);
    expect(screen.getByRole('alert')).toHaveTextContent('채팅방을 볼 수 없어요.');
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeDisabled();
    await advance(120_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('언마운트하면 진행 중 요청을 abort하고 타이머를 정리한다', async () => {
    let signal: AbortSignal | undefined;
    listMessagesMock.mockImplementation((_roomId: string, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<MessageList>(() => {});
    });
    const { unmount } = renderPanel();

    await advance(3_000);
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);

    await advance(120_000);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('언마운트 직전 예약된 폴링도 실행되지 않는다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    const { unmount } = renderPanel();
    await advance(1_000);
    unmount();
    await advance(60_000);
    expect(listMessagesMock).not.toHaveBeenCalled();
  });

  it('SSR 메시지 로드에 실패했다면 첫 폴링을 즉시 afterSeq 없이 보내고 그 결과로 커서를 잡는다', async () => {
    listMessagesMock
      .mockResolvedValueOnce(list([msg(1), msg(2)], { hasOlder: true }))
      .mockResolvedValue(list([]));
    renderPanel(null);

    await advance(0);
    expect(listMessagesMock).toHaveBeenCalledTimes(1);
    expect(afterSeqOf(0)).toBeUndefined();
    expect(screen.getByText('본문 2')).toBeInTheDocument();
    expect(screen.getByText('이전 메시지 일부는 표시되지 않아요.')).toBeInTheDocument();

    await advance(3_000);
    expect(afterSeqOf(1)).toBe(2);
  });

  it('빈 방의 SSR 실패 복구에서도 커서는 0으로 잡힌다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel(null);
    await advance(0);
    await advance(3_000);
    expect(afterSeqOf(0)).toBeUndefined();
    expect(afterSeqOf(1)).toBe(0);
    expect(screen.getByText('아직 메시지가 없어요. 첫 메시지를 보내 보세요.')).toBeInTheDocument();
  });

  it('hasOlder면 목록 위에 안내 문구를 보여준다', () => {
    renderPanel(list([msg(6)], { hasOlder: true }));
    expect(screen.getByText('이전 메시지 일부는 표시되지 않아요.')).toBeInTheDocument();
  });
});

describe('ChatMessagePanel 병합과 전송', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listMessagesMock.mockReset();
    sendMessageMock.mockReset();
    routerPush.mockReset();
    setVisibility('visible');
    // RTL의 asyncWrapper는 jest 전역이 있어야 가짜 타이머를 진행시킨다(vitest 사용 시 shim 필요).
    vi.stubGlobal('jest', { advanceTimersByTime: vi.advanceTimersByTime.bind(vi) });
    let counter = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++counter}` });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function user() {
    // 가짜 타이머 아래에서는 user-event의 내부 대기를 끈다.
    return userEvent.setup({ delay: null });
  }

  function bodies() {
    return within(screen.getByRole('log'))
      .getAllByText(/^본문 |^내 /)
      .map((node) => node.textContent);
  }

  it('폴링 결과를 id로 중복 없이 seq 오름차순으로 병합한다', async () => {
    listMessagesMock
      .mockResolvedValueOnce(list([msg(4), msg(3), msg(2)], { latestSeq: 4 }))
      .mockResolvedValue(list([]));
    renderPanel(list([msg(1), msg(2)]));

    await advance(3_000);
    expect(bodies()).toEqual(['본문 1', '본문 2', '본문 3', '본문 4']);
  });

  it('role=log, aria-live=polite로 내 메시지와 상대 메시지를 구분해 렌더한다', () => {
    renderPanel(list([msg(1), msg(2, { isMine: true, body: '내 메시지' })]));
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('내 메시지').closest('div.flex')).toHaveClass('justify-end');
    expect(screen.getByText('본문 1').closest('div.flex')).toHaveClass('justify-start');
  });

  it('메시지 본문은 HTML로 해석하지 않고 텍스트로만 렌더한다', () => {
    renderPanel(list([msg(1, { body: '<img src=x onerror=alert(1)> <b>굵게</b>' })]));
    expect(screen.getByText('<img src=x onerror=alert(1)> <b>굵게</b>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('전송하면 낙관적 말풍선을 보이고 응답으로 서버 메시지로 교체한다', async () => {
    let resolveSend: (value: unknown) => void = () => {};
    sendMessageMock.mockImplementation(() => new Promise((resolve) => (resolveSend = resolve)));
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel(list([msg(1)]));
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '내일 7시 어때요?');
    await u.click(screen.getByRole('button', { name: '보내기' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0]).toBe('room-1');
    expect(sendMessageMock.mock.calls[0][1]).toEqual({ clientMessageId: 'uuid-1', body: '내일 7시 어때요?' });
    expect(screen.getByText('내일 7시 어때요?')).toBeInTheDocument();
    expect(screen.getByText('전송 중…')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toHaveValue('');

    await act(async () =>
      resolveSend({
        message: msg(2, { isMine: true, senderRole: 'seller', body: '내일 7시 어때요?', clientMessageId: 'uuid-1' }),
        created: true,
      }),
    );
    expect(screen.queryByText('전송 중…')).not.toBeInTheDocument();
    expect(screen.getAllByText('내일 7시 어때요?')).toHaveLength(1);
  });

  it('전송 응답은 afterSeq 커서를 전진시키지 않아 상대의 더 작은 seq를 놓치지 않는다(D13)', async () => {
    sendMessageMock.mockResolvedValue({
      message: msg(7, { isMine: true, senderRole: 'seller', body: '내 7번', clientMessageId: 'uuid-1' }),
      created: true,
    });
    listMessagesMock
      .mockResolvedValueOnce(
        list([msg(6, { body: '상대 6번' }), msg(7, { isMine: true, senderRole: 'seller', body: '내 7번', clientMessageId: 'uuid-1' })], {
          latestSeq: 7,
        }),
      )
      .mockResolvedValue(list([], { latestSeq: 7 }));
    renderPanel(list([msg(5, { body: '상대 5번' })]));
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '내 7번');
    await u.click(screen.getByRole('button', { name: '보내기' }));
    expect(screen.getByText('내 7번')).toBeInTheDocument();

    await advance(3_000);
    // 전송 응답의 seq=7이 아니라 SSR의 latestSeq=5로 조회한다.
    expect(afterSeqOf(0)).toBe(5);
    expect(screen.getByText('상대 6번')).toBeInTheDocument();
    expect(screen.getAllByText('내 7번')).toHaveLength(1);

    await advance(3_000);
    expect(afterSeqOf(1)).toBe(7);
  });

  it('전송 응답보다 폴링이 먼저 같은 메시지를 가져와도 말풍선이 중복되지 않는다', async () => {
    let resolveSend: (value: unknown) => void = () => {};
    sendMessageMock.mockImplementation(() => new Promise((resolve) => (resolveSend = resolve)));
    const mine = msg(2, { isMine: true, senderRole: 'seller', body: '먼저 온 폴링', clientMessageId: 'uuid-1' });
    listMessagesMock.mockResolvedValueOnce(list([mine])).mockResolvedValue(list([]));
    renderPanel(list([msg(1)]));
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '먼저 온 폴링');
    await u.click(screen.getByRole('button', { name: '보내기' }));
    await advance(3_000);
    expect(screen.queryByText('전송 중…')).not.toBeInTheDocument();
    expect(screen.getAllByText('먼저 온 폴링')).toHaveLength(1);

    await act(async () => resolveSend({ message: mine, created: true }));
    expect(screen.getAllByText('먼저 온 폴링')).toHaveLength(1);
  });

  it('전송 실패 시 “전송 실패 · 다시 시도”를 보이고 같은 clientMessageId로 재전송한다', async () => {
    sendMessageMock
      .mockRejectedValueOnce(apiError('NETWORK_ERROR', 0))
      .mockResolvedValueOnce({
        message: msg(2, { isMine: true, senderRole: 'seller', body: '재시도 본문', clientMessageId: 'uuid-1' }),
        created: false,
      });
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel(list([msg(1)]));
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '재시도 본문');
    await u.click(screen.getByRole('button', { name: '보내기' }));

    expect(await screen.findByText(/전송 실패/)).toBeInTheDocument();
    expect(screen.getByText('재시도 본문')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1][1]).toEqual({ clientMessageId: 'uuid-1', body: '재시도 본문' });
    expect(crypto.randomUUID).toBeDefined();
    await advance(0);
    expect(screen.queryByText(/전송 실패/)).not.toBeInTheDocument();
    expect(screen.getAllByText('재시도 본문')).toHaveLength(1);
  });

  it('503도 전송 실패 말풍선으로 남긴다', async () => {
    sendMessageMock.mockRejectedValue(apiError('SERVICE_UNAVAILABLE', 503));
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '실패 본문');
    await u.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('CHAT_ROOM_CLOSED면 말풍선을 제거하고 입력을 비활성화하며 마감 배너를 보인다', async () => {
    sendMessageMock.mockRejectedValue(apiError('CHAT_ROOM_CLOSED', 409));
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '늦은 메시지');
    await u.click(screen.getByRole('button', { name: '보내기' }));

    await advance(0);
    expect(screen.queryByText('늦은 메시지')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(
      screen.getByText('다른 판매자와 매칭되어 마감된 채팅방이에요. 이전 대화만 볼 수 있어요.'),
    ).toBeInTheDocument();
  });

  it('VALIDATION_ERROR면 말풍선을 제거하고 입력 아래에 fields.body 문구를 보여준다', async () => {
    sendMessageMock.mockRejectedValue(
      apiError('VALIDATION_ERROR', 422, { body: '메시지는 1자 이상 1000자 이하로 입력해 주세요.' }),
    );
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '서버가 거부');
    await u.click(screen.getByRole('button', { name: '보내기' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('메시지는 1자 이상 1000자 이하로 입력해 주세요.');
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toHaveValue('서버가 거부');
    expect(screen.queryByText('전송 중…')).not.toBeInTheDocument();
  });

  it('전송 중 401이면 로그인으로 이동한다', async () => {
    sendMessageMock.mockRejectedValue(apiError('UNAUTHENTICATED', 401));
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '로그인 만료');
    await u.click(screen.getByRole('button', { name: '보내기' }));
    await advance(0);
    expect(routerPush).toHaveBeenCalledWith('/login?next=/chats/room-1');
  });

  it('Enter는 전송하고 Shift+Enter는 줄바꿈만 한다', async () => {
    sendMessageMock.mockResolvedValue({ message: msg(2, { isMine: true, clientMessageId: 'uuid-1' }), created: true });
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();
    const textbox = screen.getByRole('textbox', { name: '메시지 입력' });

    await u.type(textbox, '첫 줄{Shift>}{Enter}{/Shift}둘째 줄');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('첫 줄\n둘째 줄');

    await u.type(textbox, '{Enter}');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1].body).toBe('첫 줄\n둘째 줄');
    expect(textbox).toHaveValue('');
  });

  it('IME 조합 중 Enter는 전송하지 않는다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();
    const textbox = screen.getByRole('textbox', { name: '메시지 입력' });

    await u.type(textbox, '안녕');
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textbox, { key: 'Enter', keyCode: 229 });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('안녕');
  });

  it('공백만 있으면 보내기가 비활성이고 Enter로도 전송하지 않는다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();
    const textbox = screen.getByRole('textbox', { name: '메시지 입력' });

    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    await u.type(textbox, '   {Enter}');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();

    await u.type(textbox, '내용');
    expect(screen.getByRole('button', { name: '보내기' })).toBeEnabled();
  });

  it('전송 본문은 trim해서 보낸다', async () => {
    sendMessageMock.mockResolvedValue({ message: msg(2, { isMine: true, clientMessageId: 'uuid-1' }), created: true });
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const u = user();

    await u.type(screen.getByRole('textbox', { name: '메시지 입력' }), '  안녕하세요  ');
    await u.click(screen.getByRole('button', { name: '보내기' }));
    expect(sendMessageMock.mock.calls[0][1].body).toBe('안녕하세요');
  });

  it('maxLength 1000과 n/1000 카운터를 제공한다', async () => {
    listMessagesMock.mockResolvedValue(list([]));
    renderPanel();
    const textbox = screen.getByRole('textbox', { name: '메시지 입력' });
    expect(textbox).toHaveAttribute('maxlength', '1000');
    expect(screen.getByText('0/1000')).toBeInTheDocument();

    await user().type(textbox, '12345');
    expect(screen.getByText('5/1000')).toBeInTheDocument();
  });

  it('canSend=false면 입력과 보내기가 비활성이고 이유를 안내한다', () => {
    renderPanel(list([msg(1)], { room: closedState }), { chatStatus: 'closed', canSend: false });
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(screen.getByText('마감된 채팅방에서는 메시지를 보낼 수 없어요.')).toBeInTheDocument();
    expect(screen.getByText('본문 1')).toBeInTheDocument();
  });

  it('폴링 응답의 방 상태가 active→closed로 바뀌면 배너와 입력 상태가 즉시 바뀐다', async () => {
    listMessagesMock.mockResolvedValue(list([], { room: closedState, latestSeq: 2 }));
    renderPanel();
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeEnabled();

    await advance(3_000);
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeDisabled();
    expect(
      screen.getByText('다른 판매자와 매칭되어 마감된 채팅방이에요. 이전 대화만 볼 수 있어요.'),
    ).toBeInTheDocument();
  });

  it('active→matched로 바뀌면 확정 배너를 보이고 계속 입력할 수 있으며 구매자 확정 버튼은 사라진다', async () => {
    const matchedState: MessageRoomState = {
      ...activeState,
      chatStatus: 'matched',
      applicationStatus: 'accepted',
      requestStatus: 'matched',
    };
    listMessagesMock.mockResolvedValue(list([], { room: matchedState, latestSeq: 2 }));
    renderPanel(list([msg(1), msg(2)]), { viewerRole: 'buyer' });
    expect(screen.getByRole('button', { name: '이 판매자로 확정' })).toBeInTheDocument();

    await advance(3_000);
    expect(screen.getByText('매칭이 확정된 채팅방이에요. 거래 일정을 이야기해 보세요.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '이 판매자로 확정' })).not.toBeInTheDocument();
  });

  it('스크롤을 올려 둔 상태에서 상대 메시지가 오면 “새 메시지 ↓” 버튼을 보이고 누르면 바닥으로 간다', async () => {
    listMessagesMock.mockResolvedValueOnce(list([msg(3)])).mockResolvedValue(list([]));
    renderPanel(list([msg(1), msg(2)]));
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { value: 1_000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 300, configurable: true });
    log.scrollTop = 0;
    fireEvent.scroll(log);

    await advance(3_000);
    const button = screen.getByRole('button', { name: '새 메시지 ↓' });
    await user().click(button);
    expect(log.scrollTop).toBe(1_000);
    expect(screen.queryByRole('button', { name: '새 메시지 ↓' })).not.toBeInTheDocument();
  });

  it('바닥 근처면 새 메시지가 와도 “새 메시지 ↓” 버튼 없이 자동 스크롤한다', async () => {
    listMessagesMock.mockResolvedValueOnce(list([msg(3)])).mockResolvedValue(list([]));
    renderPanel(list([msg(1), msg(2)]));
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { value: 1_000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 300, configurable: true });
    log.scrollTop = 600; // 바닥까지 100px
    fireEvent.scroll(log);

    await advance(3_000);
    expect(screen.queryByRole('button', { name: '새 메시지 ↓' })).not.toBeInTheDocument();
    expect(log.scrollTop).toBe(1_000);
  });
});
