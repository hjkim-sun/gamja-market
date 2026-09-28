import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApplicantList } from '@/features/requests/components/ApplicantList';

const applications = [
  {
    id: 'application-1',
    requestId: 'request-1',
    seller: { id: 'seller-1', maskedEmail: 'se***@example.com' },
    offerPrice: 750_000,
    message: '박스 포함이며 상태가 좋습니다.',
    chatRoomId: 'room-1',
    createdAt: '2026-09-26T10:00:00+00:00',
  },
];

describe('ApplicantList', () => {
  it('구매자는 전체 지원 정보와 독립 채팅방 링크를 본다', () => {
    render(
      <ApplicantList applicantCount={3} viewerRole="owner" applications={applications} />,
    );
    expect(screen.getByRole('heading', { name: '지원한 판매자 3명' })).toBeInTheDocument();
    expect(screen.getByText('se***@example.com')).toBeInTheDocument();
    expect(screen.getByText('750,000원')).toBeInTheDocument();
    expect(screen.getByText(applications[0].message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '채팅방 열기' })).toHaveAttribute(
      'href',
      '/chats/room-1',
    );
    expect(screen.queryByText(/nickname|region/)).not.toBeInTheDocument();
  });

  it.each(['member', 'anonymous'] as const)('%s는 공개 count만 보고 상세를 보지 못한다', (role) => {
    render(
      <ApplicantList applicantCount={3} viewerRole={role} applications={[]} />,
    );
    expect(screen.getByRole('heading', { name: '지원한 판매자 3명' })).toBeInTheDocument();
    expect(
      screen.getByText('지원 내용은 구매자와 해당 판매자만 볼 수 있어요.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('se***@example.com')).not.toBeInTheDocument();
  });

  it('공개 count가 0이면 기존 빈 상태를 유지한다', () => {
    render(
      <ApplicantList applicantCount={0} viewerRole="anonymous" applications={[]} />,
    );
    expect(screen.getByText('아직 지원한 판매자가 없어요')).toBeInTheDocument();
  });
});
