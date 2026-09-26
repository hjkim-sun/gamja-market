import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { RequestDetail } from '@/features/requests/components/RequestDetail';
import { listApplications } from '@/lib/api/applications';
import { getRequest } from '@/lib/api/requests';
import { resolveServerApiBase } from '@/lib/api/serverBase';
import type { Application, ApplicationViewerRole } from '@/types/application';
import { ApiError } from '@/types/api';
import type { PurchaseRequestDetail } from '@/types/request';

export const dynamic = 'force-dynamic';

interface RequestDetailPageProps {
  params: Promise<{ id: string }>;
}

async function loadRequest(id: string, cookie: string | undefined) {
  try {
    return await getRequest(id, { baseUrl: resolveServerApiBase(), cookie });
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'NOT_FOUND') return null;
    throw caught;
  }
}

/**
 * 지원 목록 실패는 페이지 전체를 실패시키지 않는다. 지원 영역만 오류 상태로
 * 두고 나머지 상세 정보는 정상적으로 보여준다(설계서 11.3).
 */
type ApplicationsState =
  | { ok: true; viewerRole: ApplicationViewerRole; applicantCount: number; items: Application[] }
  | { ok: false };

async function loadApplications(id: string, cookie: string | undefined): Promise<ApplicationsState> {
  try {
    const list = await listApplications(id, { baseUrl: resolveServerApiBase(), cookie });
    return { ok: true, viewerRole: list.viewerRole, applicantCount: list.applicantCount, items: list.items };
  } catch {
    return { ok: false };
  }
}

export async function generateMetadata({ params }: RequestDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const cookie = (await headers()).get('cookie') ?? undefined;
  const request = await loadRequest(id, cookie);
  return request ? { title: request.title, description: request.description } : { title: '요청을 찾을 수 없음' };
}

function ApplicationsErrorNotice() {
  return (
    <section className="mt-10 rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-10 text-center" role="alert">
      <p className="font-bold text-stone-700">지원 현황을 불러오지 못했어요.</p>
      <p className="mt-1 text-sm text-stone-500">잠시 후 새로고침해 주세요.</p>
    </section>
  );
}

export default async function RequestDetailPage({ params }: RequestDetailPageProps) {
  const { id } = await params;
  const cookie = (await headers()).get('cookie') ?? undefined;
  const [request, applications] = await Promise.all([loadRequest(id, cookie), loadApplications(id, cookie)]);

  if (!request) notFound();

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-9 sm:px-6 sm:py-12">
      {applications.ok ? (
        <RequestDetail
          request={request satisfies PurchaseRequestDetail}
          applications={applications.items}
          viewerRole={applications.viewerRole}
          applicantCount={applications.applicantCount}
        />
      ) : (
        <>
          <RequestDetail
            request={request}
            applications={[]}
            viewerRole={null}
            applicantCount={request.applicantCount}
          />
          <ApplicationsErrorNotice />
        </>
      )}
    </div>
  );
}
