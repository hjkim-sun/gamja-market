import { EmptyState } from '@/components/ui/EmptyState';
import type { PurchaseRequest } from '@/types/request';

import { RequestCard } from './RequestCard';

interface RequestListProps {
  requests: PurchaseRequest[];
}

export function RequestList({ requests }: RequestListProps) {
  if (requests.length === 0) {
    return (
      <EmptyState
        title="조건에 맞는 구매요청이 없어요"
        description="검색어나 필터를 바꾸면 더 많은 요청을 볼 수 있어요."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {requests.map((request) => (
        <RequestCard key={request.id} request={request} />
      ))}
    </div>
  );
}
