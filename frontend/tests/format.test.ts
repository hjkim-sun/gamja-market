import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatPrice, formatPriceRange, formatRelativeTime } from '@/lib/format';

describe('formatPrice', () => {
  it('만원 단위로 나누어떨어지는 가격을 간결하게 표시한다', () => {
    expect(formatPrice(450_000)).toBe('45만원');
  });

  it('만원 단위로 나누어떨어지지 않는 가격은 원 단위로 표시한다', () => {
    expect(formatPrice(450_500)).toBe('450,500원');
    expect(formatPrice(0)).toBe('0원');
  });
});

describe('formatPriceRange', () => {
  it('가격 범위를 표시한다', () => {
    expect(formatPriceRange(300_000, 450_000)).toBe('30만원 ~ 45만원');
  });

  it('최소가와 최대가가 같으면 한 번만 표시한다', () => {
    expect(formatPriceRange(450_000, 450_000)).toBe('45만원');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:00+09:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['2026-08-30T11:59:30+09:00', '방금 전'],
    ['2026-08-30T11:42:00+09:00', '18분 전'],
    ['2026-08-30T09:00:00+09:00', '3시간 전'],
    ['2026-08-28T12:00:00+09:00', '2일 전'],
    ['2026-08-20T12:00:00+09:00', '2026.08.20'],
  ])('%s를 %s로 표시한다', (iso, expected) => {
    expect(formatRelativeTime(iso)).toBe(expected);
  });
});
