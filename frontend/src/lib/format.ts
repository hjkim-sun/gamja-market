export function formatPrice(price: number): string {
  if (price !== 0 && price % 10_000 === 0) {
    return `${price / 10_000}만원`;
  }

  return `${price.toLocaleString('ko-KR')}원`;
}

/**
 * 지원 제시가는 흥정 금액이라 만원 단위 축약(formatPrice) 없이 정확한 금액을 보여준다
 * (설계서 6.1의 offerPrice, F11/F14).
 */
export function formatExactWon(price: number): string {
  return `${price.toLocaleString('ko-KR')}원`;
}

export function formatPriceRange(min: number, max: number): string {
  if (min === max) {
    return formatPrice(min);
  }

  return `${formatPrice(min)} ~ ${formatPrice(max)}`;
}

export function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime();
  const difference = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (difference < minute) return '방금 전';
  if (difference < hour) return `${Math.floor(difference / minute)}분 전`;
  if (difference < day) return `${Math.floor(difference / hour)}시간 전`;
  if (difference < 7 * day) return `${Math.floor(difference / day)}일 전`;

  const date = new Date(timestamp);
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replaceAll(' ', '')
    .replace(/\.$/, '');
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
