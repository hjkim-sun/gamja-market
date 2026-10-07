'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { ApplyForm } from '@/features/applications/components/ApplyForm';
import type { Application, ApplicationStatus, ApplicationViewerRole } from '@/types/application';
import type { RequestStatus } from '@/types/request';

/** 지원 상태별 안내 문구와 링크 이름(설계서 10.6). */
const applicantCopy: Record<ApplicationStatus, { message: string; link: string }> = {
  pending: { message: '지원 완료 · 채팅방에서 거래 조건을 협의해 보세요.', link: '채팅방 열기' },
  accepted: { message: '구매자가 회원님을 판매자로 확정했어요!', link: '채팅방 열기' },
  closed: { message: '다른 판매자와 매칭되어 지원이 마감되었어요.', link: '대화 기록 보기' },
};

interface ApplyPanelProps {
  requestId: string;
  requestStatus: RequestStatus;
  viewerRole: ApplicationViewerRole;
  application: Application | null;
  priceMin: number;
  priceMax: number;
}

export function ApplyPanel({
  requestId,
  requestStatus,
  viewerRole,
  application,
  priceMin,
  priceMax,
}: ApplyPanelProps) {
  const [formOpen, setFormOpen] = useState(false);
  const loginHref = `/login?next=/requests/${requestId}`;

  if (viewerRole === 'anonymous') {
    return (
      <div className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4">
          <p className="hidden text-sm text-stone-500 sm:block">로그인하면 이 요청에 지원할 수 있어요.</p>
          <Link
            href={loginHref}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-potato-400 px-4 py-2.5 text-sm font-bold text-stone-900 transition hover:bg-potato-300 sm:ml-auto sm:w-auto sm:min-w-48"
          >
            로그인하고 지원하기
          </Link>
        </div>
      </div>
    );
  }

  if (viewerRole === 'owner') {
    return (
      <div className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto max-w-[1200px]">
          <p className="text-sm text-stone-500">내 구매요청에는 직접 지원할 수 없어요. 지원자 목록에서 판매자를 확인해 주세요.</p>
        </div>
      </div>
    );
  }

  if (viewerRole === 'applicant' && application) {
    const copy = applicantCopy[application.status];
    return (
      <div className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4">
          <p className={`text-sm font-bold ${application.status === 'closed' ? 'text-stone-600' : 'text-leaf-700'}`}>
            {copy.message}
          </p>
          <Link
            href={`/chats/${application.chatRoomId}`}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 transition hover:bg-stone-50 sm:ml-auto sm:w-auto sm:min-w-48"
          >
            {copy.link}
          </Link>
        </div>
      </div>
    );
  }

  // member
  if (requestStatus !== 'open') {
    return (
      <div className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4">
          <p className="hidden text-sm text-stone-500 sm:block">모집이 마감된 요청에는 지원할 수 없어요.</p>
          <Button disabled title="모집이 마감된 요청입니다" className="w-full sm:ml-auto sm:w-auto sm:min-w-48">
            모집이 마감된 요청입니다
          </Button>
        </div>
      </div>
    );
  }

  if (formOpen) {
    return (
      <div className="mt-10 border-t border-stone-200 pt-6">
        <ApplyForm requestId={requestId} priceMin={priceMin} priceMax={priceMax} />
      </div>
    );
  }

  return (
    <div className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4">
        <p className="hidden text-sm text-stone-500 sm:block">이 요청에 판매자로 지원해 보세요.</p>
        <Button onClick={() => setFormOpen(true)} className="w-full sm:ml-auto sm:w-auto sm:min-w-48">
          지원하기
        </Button>
      </div>
    </div>
  );
}
