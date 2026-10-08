import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApplicantList } from '@/features/requests/components/ApplicantList';

const { routerRefresh, confirmMatchMock } = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  confirmMatchMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
}));

vi.mock('@/lib/api/applications', () => ({ confirmMatch: confirmMatchMock }));

const applications = [
  {
    id: 'application-1',
    requestId: 'request-1',
    seller: { id: 'seller-1', maskedEmail: 'se***@example.com' },
    status: 'pending' as const,
    offerPrice: 750_000,
    message: '박스 포함이며 상태가 좋습니다.',
    chatRoomId: 'room-1',
    createdAt: '2026-09-26T10:00:00+00:00',
  },
];

function application(id: string, status: 'pending' | 'accepted' | 'closed', email: string) {
  return { ...applications[0], id, status, chatRoomId: `room-${id}`, seller: { id: `s-${id}`, maskedEmail: email } };
}

describe('ApplicantList', () => {
  beforeEach(() => {
    routerRefresh.mockReset();
    confirmMatchMock.mockReset();
  });

  it('구매자는 전체 지원 정보와 독립 채팅방 링크를 본다', () => {
    render(
      <ApplicantList applicantCount={3} viewerRole="owner" applications={applications} requestStatus="open" />,
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
      <ApplicantList applicantCount={3} viewerRole={role} applications={[]} requestStatus="open" />,
    );
    expect(screen.getByRole('heading', { name: '지원한 판매자 3명' })).toBeInTheDocument();
    expect(
      screen.getByText('지원 내용은 구매자와 해당 판매자만 볼 수 있어요.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('se***@example.com')).not.toBeInTheDocument();
  });

  it('공개 count가 0이면 기존 빈 상태를 유지한다', () => {
    render(
      <ApplicantList applicantCount={0} viewerRole="anonymous" applications={[]} requestStatus="open" />,
    );
    expect(screen.getByText('아직 지원한 판매자가 없어요')).toBeInTheDocument();
  });

  it('지원 상태 배지를 협의 중/확정/마감으로 보여준다', () => {
    render(
      <ApplicantList
        applicantCount={3}
        viewerRole="owner"
        requestStatus="matched"
        applications={[
          application('a', 'closed', 'aa***@example.com'),
          application('b', 'accepted', 'bb***@example.com'),
          application('c', 'pending', 'cc***@example.com'),
        ]}
      />,
    );
    expect(screen.getByText('협의 중')).toBeInTheDocument();
    expect(screen.getByText('확정')).toBeInTheDocument();
    expect(screen.getByText('마감')).toBeInTheDocument();
  });

  it('요청이 matched면 확정 카드를 맨 위로 올리고 확정 버튼을 숨긴다', () => {
    render(
      <ApplicantList
        applicantCount={3}
        viewerRole="owner"
        requestStatus="matched"
        applications={[
          application('a', 'closed', 'aa***@example.com'),
          application('b', 'accepted', 'bb***@example.com'),
          application('c', 'closed', 'cc***@example.com'),
        ]}
      />,
    );
    const emails = screen.getAllByText(/\*\*\*@example\.com/).map((node) => node.textContent);
    expect(emails).toEqual(['bb***@example.com', 'aa***@example.com', 'cc***@example.com']);
    expect(screen.queryByRole('button', { name: '이 판매자로 확정' })).not.toBeInTheDocument();
  });

  it('owner + open 요청의 pending 지원에만 확정 버튼이 있고 다른 pending 수를 안내한다', async () => {
    const user = userEvent.setup();
    render(
      <ApplicantList
        applicantCount={3}
        viewerRole="owner"
        requestStatus="open"
        applications={[
          application('a', 'pending', 'aa***@example.com'),
          application('b', 'pending', 'bb***@example.com'),
          application('c', 'closed', 'cc***@example.com'),
        ]}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: '이 판매자로 확정' });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[0]);
    expect(screen.getByText('확정하면 다른 지원 1건은 자동으로 마감되고 되돌릴 수 없어요.')).toBeInTheDocument();
  });

  it('applicant는 본인 상태 배지만 보고 확정 버튼은 보지 못한다', () => {
    render(
      <ApplicantList
        applicantCount={4}
        viewerRole="applicant"
        requestStatus="open"
        applications={[application('a', 'pending', 'aa***@example.com')]}
      />,
    );
    expect(screen.getByText('협의 중')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '이 판매자로 확정' })).not.toBeInTheDocument();
  });

  it('member/anonymous 화면에는 상태나 확정 UI가 없다', () => {
    render(
      <ApplicantList applicantCount={2} viewerRole="member" requestStatus="matched" applications={[]} />,
    );
    expect(screen.queryByText('확정')).not.toBeInTheDocument();
    expect(screen.queryByText('협의 중')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '이 판매자로 확정' })).not.toBeInTheDocument();
  });
});
