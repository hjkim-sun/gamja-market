import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatPriceRange, formatRelativeTime } from '@/lib/format';
import type { PurchaseRequest } from '@/types/request';

const categoryEmoji: Record<string, string> = {
  디지털기기: '💻',
  가전: '🧹',
  '가구/인테리어': '🪑',
  의류: '👕',
  도서: '📚',
};

interface RequestCardProps {
  request: PurchaseRequest;
}

export function RequestCard({ request }: RequestCardProps) {
  return (
    <Link
      href={`/requests/${request.id}`}
      className="group block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-potato-500"
      aria-label={`${request.title} 상세 보기`}
    >
      <Card className="h-full overflow-hidden transition duration-200 group-hover:-translate-y-1 group-hover:border-potato-300 group-hover:shadow-lg">
        <div className="grid aspect-[16/9] place-items-center bg-gradient-to-br from-potato-50 to-stone-100">
          {request.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={request.thumbnailUrl}
              alt={`${request.title} 참고 이미지`}
              className="size-full object-cover"
            />
          ) : (
            <span className="text-5xl drop-shadow-sm" aria-hidden="true">
              {categoryEmoji[request.category] ?? '📦'}
            </span>
          )}
        </div>
        <div className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <Badge status={request.status} />
            <span className="text-xs font-medium text-stone-400" suppressHydrationWarning>
              {formatRelativeTime(request.createdAt)}
            </span>
          </div>
          <h2 className="line-clamp-2 min-h-12 text-base font-bold leading-6 text-stone-900 group-hover:text-potato-700">
            {request.title}
          </h2>
          <p className="mt-3 text-sm text-stone-500">희망가</p>
          <p className="mt-0.5 text-lg font-black tracking-tight text-stone-900">
            {formatPriceRange(request.priceMin, request.priceMax)}
          </p>
          <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-4 text-sm text-stone-500">
            <span className="min-w-0 truncate">{request.region}</span>
            <span className="ml-3 shrink-0 font-semibold text-leaf-700">지원 {request.applicantCount}명</span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
