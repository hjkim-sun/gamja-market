import { describe, expect, it } from 'vitest';

import { requestCategories } from '@/features/requests/categories';

describe('구매요청 카테고리', () => {
  it('백엔드가 허용하는 고정 목록과 순서까지 일치한다', () => {
    expect(requestCategories).toEqual([
      '디지털기기',
      '가전',
      '가구/인테리어',
      '의류',
      '도서',
      '기타',
    ]);
  });
});
