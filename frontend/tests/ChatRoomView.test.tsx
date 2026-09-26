import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatRoomView } from '@/features/chat/components/ChatRoomView';

const room = {
  id: 'room-1',
  applicationId: 'application-1',
  viewerRole: 'seller' as const,
  request: {
    id: 'request-1',
    title: '아이패드 프로를 구합니다',
    status: 'open' as const,
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
  it('참여자와 지원 메타데이터만 표시하고 메시지 입력 UI는 만들지 않는다', () => {
    render(<ChatRoomView room={room} />);
    expect(screen.getByRole('link', { name: room.request.title })).toHaveAttribute(
      'href',
      '/requests/request-1',
    );
    expect(screen.getByText('bu***@example.com')).toBeInTheDocument();
    expect(screen.getByText('se***@example.com')).toBeInTheDocument();
    expect(screen.getByText('750,000원')).toBeInTheDocument();
    expect(screen.getByText(room.applicationMessage)).toBeInTheDocument();
    expect(screen.getByText(/메시지/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '보내기' })).not.toBeInTheDocument();
  });
});
