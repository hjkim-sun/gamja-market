import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDateTime, formatExactWon, formatPriceRange } from '@/lib/format';
import type { ChatRoom } from '@/types/application';

interface ChatRoomViewProps {
  room: ChatRoom;
}

export function ChatRoomView({ room }: ChatRoomViewProps) {
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-stone-500">
        <Badge status={room.request.status} />
        <Link
          href={`/requests/${room.request.id}`}
          className="font-bold text-stone-900 underline underline-offset-2 hover:text-leaf-700"
        >
          {room.request.title}
        </Link>
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-potato-200 bg-potato-50 p-6 sm:p-8">
          <p className="text-sm font-bold text-potato-700">구매자가 생각하는 희망가</p>
          <p className="mt-2 text-2xl font-black tracking-tight text-stone-950">
            {formatPriceRange(room.request.priceMin, room.request.priceMax)}
          </p>
        </div>

        <div className="grid gap-6 p-6 sm:grid-cols-2 sm:p-8">
          <div className="rounded-2xl bg-stone-50 p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-stone-400">
              구매자{room.viewerRole === 'buyer' ? ' · 나' : ''}
            </p>
            <p className="mt-2 truncate font-black text-stone-900">{room.buyer.maskedEmail}</p>
          </div>
          <div className="rounded-2xl bg-stone-50 p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-stone-400">
              판매자{room.viewerRole === 'seller' ? ' · 나' : ''}
            </p>
            <p className="mt-2 truncate font-black text-stone-900">{room.seller.maskedEmail}</p>
          </div>
        </div>

        <div className="border-t border-stone-100 p-6 sm:p-8">
          <p className="text-xs font-semibold text-stone-400">제시가</p>
          <p className="mt-1 text-xl font-black text-leaf-700">{formatExactWon(room.offerPrice)}</p>
          <p className="mt-4 whitespace-pre-wrap rounded-xl bg-stone-50 p-4 text-sm leading-6 text-stone-700">
            {room.applicationMessage}
          </p>
          <p className="mt-3 text-xs text-stone-400" suppressHydrationWarning>
            {formatDateTime(room.createdAt)} 지원
          </p>
        </div>
      </Card>

      <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-10 text-center">
        <span className="text-3xl" aria-hidden="true">💬</span>
        <p className="mt-3 font-bold text-stone-700">메시지 기능을 준비하고 있어요.</p>
      </div>
    </div>
  );
}
