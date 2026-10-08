import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatRoomView } from '@/features/chat/components/ChatRoomView';
import type { ChatRoom } from '@/types/application';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const room: ChatRoom = {
  id: 'room-1',
  applicationId: 'application-1',
  applicationStatus: 'pending',
  chatStatus: 'active',
  canSend: true,
  viewerRole: 'seller',
  request: {
    id: 'request-1',
    title: '아이패드 프로를 구합니다',
    status: 'open',
    priceMin: 600_000,
    priceMax: 800_000,
  },
  buyer: { id: 'buyer-1', maskedEmail: 'bu***@example.com' },
  seller: { id: 'seller-1', maskedEmail: 'se***@example.com' },
  offerPrice: 750_000,
  applicationMessage: '박스와 구성품을 모두 보유하고 있습니다.',
  createdAt: '2026-09-26T10:00:00+00:00',
};

describe('ChatRoomView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 폴링이 실제 네트워크를 타지 않도록 막는다. 이 테스트는 첫 폴링 전에 끝난다.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('참여자와 지원 메타데이터를 유지하고 canSend면 메시지 입력 UI를 보여준다', () => {
    render(<ChatRoomView room={room} />);
    expect(screen.getByRole('link', { name: room.request.title })).toHaveAttribute(
      'href',
      '/requests/request-1',
    );
    expect(screen.getByText('bu***@example.com')).toBeInTheDocument();
    expect(screen.getByText('se***@example.com')).toBeInTheDocument();
    expect(screen.getByText('750,000원')).toBeInTheDocument();
    expect(screen.getByText(room.applicationMessage)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(screen.queryByText('메시지 기능을 준비하고 있어요.')).not.toBeInTheDocument();
  });

  it('closed 방은 입력을 비활성화하고 판매자에게 마감 배너를 보여준다', () => {
    render(<ChatRoomView room={{ ...room, applicationStatus: 'closed', chatStatus: 'closed', canSend: false }} />);
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(
      screen.getByText('다른 판매자와 매칭되어 마감된 채팅방이에요. 이전 대화만 볼 수 있어요.'),
    ).toBeInTheDocument();
  });

  it('구매자의 closed 방은 구매자 시점 문구를 보여준다', () => {
    render(
      <ChatRoomView
        room={{ ...room, viewerRole: 'buyer', applicationStatus: 'closed', chatStatus: 'closed', canSend: false }}
      />,
    );
    expect(screen.getByText('이 지원은 마감되었어요.')).toBeInTheDocument();
  });

  it('matched 방은 확정 배너를 보여주고 계속 대화할 수 있다', () => {
    render(<ChatRoomView room={{ ...room, applicationStatus: 'accepted', chatStatus: 'matched' }} />);
    expect(screen.getByText('매칭이 확정된 채팅방이에요. 거래 일정을 이야기해 보세요.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '메시지 입력' })).toBeEnabled();
  });

  it('확정 버튼은 active 방의 구매자에게만 보인다', () => {
    const { rerender } = render(<ChatRoomView room={{ ...room, viewerRole: 'buyer' }} />);
    expect(screen.getByRole('button', { name: '이 판매자로 확정' })).toBeInTheDocument();

    rerender(<ChatRoomView room={room} />);
    expect(screen.queryByRole('button', { name: '이 판매자로 확정' })).not.toBeInTheDocument();

    rerender(<ChatRoomView room={{ ...room, viewerRole: 'buyer', chatStatus: 'matched', applicationStatus: 'accepted' }} />);
    expect(screen.queryByRole('button', { name: '이 판매자로 확정' })).not.toBeInTheDocument();
  });
});
