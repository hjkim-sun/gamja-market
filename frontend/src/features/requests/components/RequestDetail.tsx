import { ApplicantList } from '@/features/requests/components/ApplicantList';
import { ApplyPanel } from '@/features/applications/components/ApplyPanel';
import { RequestPhotoGallery } from '@/features/requests/components/RequestPhotoGallery';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDateTime, formatPriceRange } from '@/lib/format';
import type { Application, ApplicationViewerRole } from '@/types/application';
import type { ProductCondition, PurchaseRequestDetail } from '@/types/request';

const conditionLabels: Record<ProductCondition, string> = {
  any: '상관없음',
  new: '새상품',
  like_new: '거의 새것',
  used: '사용감 있음',
};

interface RequestDetailProps {
  request: PurchaseRequestDetail;
  applications: Application[];
  /** null은 지원 현황 조회 자체가 실패한 상태다. 지원 UI를 아예 감춘다(설계서 11.3). */
  viewerRole: ApplicationViewerRole | null;
  applicantCount: number;
}

export function RequestDetail({ request, applications, viewerRole, applicantCount }: RequestDetailProps) {
  // applicant 역할은 목록에 본인 지원 1건만 내려온다(설계서 6.2).
  const ownApplication = viewerRole === 'applicant' ? (applications[0] ?? null) : null;
  return (
    <>
      <article>
        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-stone-500">
          <Badge status={request.status} />
          <span>{request.category}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={request.createdAt}>{formatDateTime(request.createdAt)}</time>
        </div>
        <h1 className="max-w-4xl break-keep text-3xl font-black leading-tight tracking-tight text-stone-950 sm:text-4xl">
          {request.title}
        </h1>

        <RequestPhotoGallery photos={request.photos} title={request.title} />

        <Card className="mt-8 overflow-hidden">
          <div className="border-b border-potato-200 bg-potato-50 p-6 sm:p-8">
            <p className="text-sm font-bold text-potato-700">구매자가 생각하는 희망가</p>
            <p className="mt-2 break-words text-3xl font-black tracking-tight text-stone-950 sm:text-4xl">
              {formatPriceRange(request.priceMin, request.priceMax)}
            </p>
          </div>
          <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_280px]">
            <div>
              <h2 className="text-lg font-black text-stone-900">원하는 물건과 스펙</h2>
              <p className="mt-4 whitespace-pre-wrap text-base leading-8 text-stone-700">{request.description}</p>

              <dl className="mt-8 grid gap-4 border-t border-stone-100 pt-6 sm:grid-cols-2">
                <div>
                  <dt className="text-sm font-semibold text-stone-400">희망 상태</dt>
                  <dd className="mt-1 font-bold text-stone-800">{conditionLabels[request.condition]}</dd>
                </div>
                <div>
                  <dt className="text-sm font-semibold text-stone-400">거래 희망 지역</dt>
                  <dd className="mt-1 font-bold text-stone-800">{request.region}</dd>
                </div>
              </dl>
            </div>

            <aside className="rounded-2xl bg-stone-50 p-5" aria-label="구매자 정보">
              <p className="text-xs font-bold uppercase tracking-wider text-stone-400">구매자</p>
              <div className="mt-4 flex items-center gap-3">
                <div className="grid size-12 place-items-center rounded-full bg-potato-200 text-2xl" aria-hidden="true">
                  🥔
                </div>
                <div className="min-w-0">
                  <p className="truncate font-black text-stone-900">{request.buyer.maskedEmail}</p>
                </div>
              </div>
            </aside>
          </div>
        </Card>
      </article>

      <ApplicantList
        applicantCount={applicantCount}
        viewerRole={viewerRole ?? 'anonymous'}
        applications={applications}
      />

      {viewerRole ? (
        <ApplyPanel
          requestId={request.id}
          requestStatus={request.status}
          viewerRole={viewerRole}
          application={ownApplication}
          priceMin={request.priceMin}
          priceMax={request.priceMax}
        />
      ) : null}
    </>
  );
}
