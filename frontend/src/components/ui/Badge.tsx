import type { RequestStatus } from '@/types/request';

const statusStyles: Record<RequestStatus, string> = {
  open: 'bg-leaf-50 text-leaf-700 ring-leaf-500/20',
  matched: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  closed: 'bg-stone-100 text-stone-600 ring-stone-500/20',
};

const statusLabels: Record<RequestStatus, string> = {
  open: '구해요',
  matched: '매칭됨',
  closed: '마감',
};

interface BadgeProps {
  status: RequestStatus;
}

export function Badge({ status }: BadgeProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${statusStyles[status]}`}
    >
      {statusLabels[status]}
    </span>
  );
}
