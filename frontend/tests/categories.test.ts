import { describe, expect, it } from 'vitest';

import { requestCategories, resolveCategories } from '@/features/requests/categories';

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

  it('URL 원문을 허용 카테고리 배열로 정규화한다(빈 값·미허용 값·중복 제거, 정의 순서)', () => {
    expect(resolveCategories(undefined)).toEqual([]);
    expect(resolveCategories('가전')).toEqual(['가전']);
    expect(resolveCategories(['의류', '', '가전', '의류', '없는카테고리'])).toEqual(['가전', '의류']);
  });
});
