import type { ComponentProps } from 'react';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RequestList } from '@/features/requests/components/RequestList';

function renderEmpty(hasActiveFilters: boolean) {
  const props = { requests: [], hasActiveFilters } as unknown as ComponentProps<typeof RequestList>;
  return render(<RequestList {...props} />);
}

describe('RequestList 빈 상태', () => {
  it('검색어나 필터가 있으면 조건 결과 없음과 초기화 링크를 표시한다', () => {
    renderEmpty(true);
    expect(screen.getByText('조건에 맞는 구매요청이 없어요')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '필터 초기화' })).toHaveAttribute('href', '/');
  });

  it('필터 없는 빈 DB면 첫 구매요청 안내와 등록 링크를 표시한다', () => {
    renderEmpty(false);
    expect(screen.getByText('아직 등록된 구매요청이 없어요')).toBeInTheDocument();
    expect(screen.getByText('첫 번째 구매요청을 등록해 보세요.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /구매요청 등록/ })).toHaveAttribute(
      'href',
      '/requests/new',
    );
  });
});
