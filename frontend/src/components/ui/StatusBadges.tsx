import type { ApplicationStatus, ChatStatus } from '@/types/application';

const pillClassName = 'inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset';

const applicationStyles: Record<ApplicationStatus, string> = {
  pending: 'bg-leaf-50 text-leaf-700 ring-leaf-500/20',
  accepted: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  closed: 'bg-stone-100 text-stone-600 ring-stone-500/20',
};

const applicationLabels: Record<ApplicationStatus, string> = {
  pending: '협의 중',
  accepted: '확정',
  closed: '마감',
};

const chatStyles: Record<ChatStatus, string> = {
  active: applicationStyles.pending,
  matched: applicationStyles.accepted,
  closed: applicationStyles.closed,
  completed: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};

const chatLabels: Record<ChatStatus, string> = {
  active: '협의 중',
  matched: '매칭 확정',
  closed: '마감',
  completed: '거래 완료',
};

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return <span className={`${pillClassName} ${applicationStyles[status]}`}>{applicationLabels[status]}</span>;
}

export function ChatStatusBadge({ status }: { status: ChatStatus }) {
  return <span className={`${pillClassName} ${chatStyles[status]}`}>{chatLabels[status]}</span>;
}
