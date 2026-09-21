import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RequestDetail } from '@/features/requests/components/RequestDetail';
import { getRequest } from '@/lib/api/requests';
import { resolveServerApiBase } from '@/lib/api/serverBase';
import { ApiError } from '@/types/api';
import type { Applicant } from '@/types/request';

export const dynamic = 'force-dynamic';

interface RequestDetailPageProps {
  params: Promise<{ id: string }>;
}

async function loadRequest(id: string) {
  try {
    return await getRequest(id, { baseUrl: resolveServerApiBase() });
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'NOT_FOUND') return null;
    throw caught;
  }
}

export async function generateMetadata({ params }: RequestDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const request = await loadRequest(id);
  return request ? { title: request.title, description: request.description } : { title: '요청을 찾을 수 없음' };
}

export default async function RequestDetailPage({ params }: RequestDetailPageProps) {
  const { id } = await params;
  const request = await loadRequest(id);

  if (!request) notFound();

  // 판매자 지원 기능은 4단계다. 그때까지 정직한 0건 상태를 보여준다(설계서 5.5).
  const applicants: Applicant[] = [];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-9 sm:px-6 sm:py-12">
      <RequestDetail request={request} applicants={applicants} />
    </div>
  );
}
