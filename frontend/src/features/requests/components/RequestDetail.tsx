import { ApplicantList } from '@/features/requests/components/ApplicantList';
import { RequestPhotoGallery } from '@/features/requests/components/RequestPhotoGallery';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDateTime, formatPriceRange } from '@/lib/format';
import type { Applicant, ProductCondition, PurchaseRequestDetail } from '@/types/request';

const conditionLabels: Record<ProductCondition, string> = {
  any: '상관없음',
  new: '새상품',
  like_new: '거의 새것',
  used: '사용감 있음',
};

interface RequestDetailProps {
  request: PurchaseRequestDetail;
  applicants: Applicant[];
}

export function RequestDetail({ request, applicants }: RequestDetailProps) {
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

      <ApplicantList applicants={applicants} />

      <div className="sticky bottom-0 z-30 -mx-4 mt-10 border-t border-stone-200 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4">
          <p className="hidden text-sm text-stone-500 sm:block">판매자 지원 기능은 4단계에서 열립니다.</p>
          <Button disabled title="4단계에서 구현 예정" className="w-full sm:ml-auto sm:w-auto sm:min-w-48">
            지원하기 · 준비 중
          </Button>
        </div>
      </div>
    </>
  );
}
