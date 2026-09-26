import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { formatExactWon, formatRelativeTime } from '@/lib/format';
import type { Application, ApplicationViewerRole } from '@/types/application';

interface ApplicantListProps {
  applicantCount: number;
  viewerRole: ApplicationViewerRole;
  applications: Application[];
}

export function ApplicantList({ applicantCount, viewerRole, applications }: ApplicantListProps) {
  const canSeeDetail = viewerRole === 'owner' || viewerRole === 'applicant';

  return (
    <section className="mt-10" aria-labelledby="applicant-heading">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <p className="text-sm font-bold text-leaf-700">판매 제안</p>
          <h2 id="applicant-heading" className="mt-1 text-2xl font-black text-stone-900">
            지원한 판매자 {applicantCount}명
          </h2>
        </div>
      </div>

      {applicantCount === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-12 text-center">
          <span className="text-3xl" aria-hidden="true">📭</span>
          <p className="mt-3 font-bold text-stone-700">아직 지원한 판매자가 없어요</p>
          <p className="mt-1 text-sm text-stone-500">좋은 판매자가 곧 찾아올 거예요.</p>
        </div>
      ) : !canSeeDetail ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-12 text-center">
          <span className="text-3xl" aria-hidden="true">🔒</span>
          <p className="mt-3 font-bold text-stone-700">지원 내용은 구매자와 해당 판매자만 볼 수 있어요.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {applications.map((application) => (
            <Card key={application.id} className="p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-11 shrink-0 place-items-center rounded-full bg-potato-100 text-xl" aria-hidden="true">
                    🥔
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-bold text-stone-900">{application.seller.maskedEmail}</p>
                  </div>
                </div>
                <div className="sm:text-right">
                  <p className="text-xs font-semibold text-stone-400">제시가</p>
                  <p className="text-xl font-black text-leaf-700">{formatExactWon(application.offerPrice)}</p>
                </div>
              </div>
              <p className="mt-4 whitespace-pre-wrap rounded-xl bg-stone-50 p-4 text-sm leading-6 text-stone-700">
                {application.message}
              </p>
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-stone-400" suppressHydrationWarning>
                  {formatRelativeTime(application.createdAt)} 지원
                </p>
                <Link
                  href={`/chats/${application.chatRoomId}`}
                  className="text-sm font-bold text-leaf-700 underline underline-offset-2 hover:text-leaf-800"
                >
                  채팅방 열기
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
