import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatRoomList } from '@/features/chat/components/ChatRoomList';
import type { ChatRoomListItem } from '@/types/chat';

const items: ChatRoomListItem[] = [
  {
    id: 'room-1',
    viewerRole: 'buyer',
    chatStatus: 'active',
    request: { id: 'request-1', title: '아이패드 프로를 구합니다', status: 'open' },
    counterpart: { id: 'user-2', maskedEmail: 'se***@example.com' },
    lastMessage: { body: '직거래 가능하신가요?', senderRole: 'seller', createdAt: '2026-10-07T10:00:00Z' },
    lastActivityAt: '2026-10-07T10:00:00Z',
  },
  {
    id: 'room-2',
    viewerRole: 'seller',
    chatStatus: 'closed',
    request: { id: 'request-2', title: '맥북을 구합니다', status: 'matched' },
    counterpart: { id: 'user-3', maskedEmail: 'bu***@example.com' },
    lastMessage: null,
    lastActivityAt: '2026-10-06T10:00:00Z',
  },
];

describe('ChatRoomList', () => {
  it('빈 목록이면 빈 상태 문구를 보여준다', () => {
    render(<ChatRoomList items={[]} />);
    expect(screen.getByText('아직 참여 중인 채팅이 없어요.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('각 방을 채팅방 링크로 렌더하고 역할·상태·미리보기를 보여준다', () => {
    render(<ChatRoomList items={items} />);
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/chats/room-1', '/chats/room-2']);

    expect(screen.getByText('아이패드 프로를 구합니다')).toBeInTheDocument();
    expect(screen.getByText('구해요')).toBeInTheDocument();
    expect(screen.getByText('협의 중')).toBeInTheDocument();
    expect(screen.getByText('구매')).toBeInTheDocument();
    expect(screen.getByText('직거래 가능하신가요?')).toBeInTheDocument();

    expect(screen.getByText('매칭됨')).toBeInTheDocument();
    expect(screen.getByText('마감')).toBeInTheDocument();
    expect(screen.getByText('판매')).toBeInTheDocument();
    expect(screen.getByText('아직 메시지가 없어요.')).toBeInTheDocument();
  });

  it('상대는 마스킹 이메일만 표시한다', () => {
    const { container } = render(<ChatRoomList items={items} />);
    expect(screen.getByText('se***@example.com')).toBeInTheDocument();
    expect(screen.getByText('bu***@example.com')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/user-2|user-3/);
  });
});
