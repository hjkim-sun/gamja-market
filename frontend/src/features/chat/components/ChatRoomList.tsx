import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChatStatusBadge } from '@/components/ui/StatusBadges';
import { formatRelativeTime } from '@/lib/format';
import type { ChatRoomListItem } from '@/types/chat';

interface ChatRoomListProps {
  items: ChatRoomListItem[];
}

/** 목록 자체는 폴링하지 않는다(설계서 10.7). 상대는 마스킹 이메일만 보여준다. */
export function ChatRoomList({ items }: ChatRoomListProps) {
  if (items.length === 0) {
    return <EmptyState title="아직 참여 중인 채팅이 없어요." description="구매요청에 지원하거나 지원을 받으면 채팅이 열려요." />;
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/chats/${item.id}`}
            className="block rounded-2xl border border-stone-200 bg-white p-5 transition hover:border-potato-300 hover:bg-potato-50/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-potato-500"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge status={item.request.status} />
              <ChatStatusBadge status={item.chatStatus} />
              <span className="text-xs font-semibold text-stone-400">
                {item.viewerRole === 'buyer' ? '구매' : '판매'}
              </span>
            </div>
            <p className="mt-2 truncate font-black text-stone-900">{item.request.title}</p>
            <p className="mt-1 truncate text-sm text-stone-500">{item.counterpart.maskedEmail}</p>
            <div className="mt-3 flex items-center justify-between gap-3 text-sm">
              <p className="min-w-0 flex-1 truncate text-stone-600">
                {item.lastMessage ? item.lastMessage.body : '아직 메시지가 없어요.'}
              </p>
              <time dateTime={item.lastActivityAt} className="shrink-0 text-xs text-stone-400" suppressHydrationWarning>
                {formatRelativeTime(item.lastActivityAt)}
              </time>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
