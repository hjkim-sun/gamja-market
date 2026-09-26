import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApplyPanel } from '@/features/applications/components/ApplyPanel';

const requestId = '00000000-0000-4000-8000-000000000001';
const application = {
  id: 'application-1',
  requestId,
  seller: { id: 'seller-1', maskedEmail: 'se***@example.com' },
  offerPrice: 750_000,
  message: '구성품을 모두 보유하고 있습니다.',
  chatRoomId: 'room-1',
  createdAt: '2026-09-26T10:00:00+00:00',
};

function renderPanel(
  viewerRole: 'owner' | 'applicant' | 'member' | 'anonymous',
  status: 'open' | 'matched' | 'closed' = 'open',
) {
  return render(
    <ApplyPanel
      requestId={requestId}
      requestStatus={status}
      viewerRole={viewerRole}
      application={viewerRole === 'applicant' ? application : null}
      priceMin={600_000}
      priceMax={800_000}
    />,
  );
}

describe('ApplyPanel', () => {
  it('익명 사용자에게 현재 상세로 돌아오는 로그인 링크만 보여준다', () => {
    renderPanel('anonymous');
    expect(screen.getByRole('link', { name: '로그인하고 지원하기' })).toHaveAttribute(
      'href',
      `/login?next=/requests/${requestId}`,
    );
    expect(screen.queryByRole('button', { name: '지원하기' })).not.toBeInTheDocument();
  });

  it('구매자에게 본인 요청 안내를 하고 지원 버튼을 숨긴다', () => {
    renderPanel('owner');
    expect(screen.getByText(/내 구매요청/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지원하기' })).not.toBeInTheDocument();
  });

  it('지원자는 기존 채팅방 링크를 본다', () => {
    renderPanel('applicant');
    expect(screen.getByText(/지원 완료/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /채팅방/ })).toHaveAttribute('href', '/chats/room-1');
  });

  it('비참여 회원은 열린 요청에 지원할 수 있고 마감 요청에는 비활성 안내를 본다', () => {
    const { rerender } = renderPanel('member');
    expect(screen.getByRole('button', { name: '지원하기' })).toBeEnabled();

    rerender(
      <ApplyPanel
        requestId={requestId}
        requestStatus="closed"
        viewerRole="member"
        application={null}
        priceMin={600_000}
        priceMax={800_000}
      />,
    );
    expect(screen.getByText('모집이 마감된 요청입니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지원하기' })).not.toBeInTheDocument();
  });
});
