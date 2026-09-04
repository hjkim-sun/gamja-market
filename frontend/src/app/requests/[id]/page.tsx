import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RequestDetail } from '@/features/requests/components/RequestDetail';
import { getApplicantsByRequestId } from '@/lib/mock/applicants';
import { getRequestById, mockRequests } from '@/lib/mock/requests';

interface RequestDetailPageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return mockRequests.map((request) => ({ id: request.id }));
}

export async function generateMetadata({ params }: RequestDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const request = getRequestById(id);
  return request ? { title: request.title, description: request.description } : { title: '요청을 찾을 수 없음' };
}

export default async function RequestDetailPage({ params }: RequestDetailPageProps) {
  const { id } = await params;
  const request = getRequestById(id);

  if (!request) notFound();

  const applicants = getApplicantsByRequestId(request.id);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-9 sm:px-6 sm:py-12">
      <RequestDetail request={request} applicants={applicants} />
    </div>
  );
}
