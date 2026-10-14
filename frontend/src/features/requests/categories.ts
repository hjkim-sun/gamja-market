/** 설계서 4.1의 고정 카테고리 목록. 등록 폼과 목록 필터가 항상 이 목록을 공유한다. */
export const requestCategories = ['디지털기기', '가전', '가구/인테리어', '의류', '도서', '기타'];

/**
 * URL의 `?category=` 원문(문자열 또는 반복 파라미터 배열)을 허용된 카테고리 배열로 정규화한다.
 * 빈 값·알 수 없는 값·중복은 버리고, 순서는 `requestCategories` 정의 순서를 따른다.
 */
export function resolveCategories(raw: string | string[] | undefined): string[] {
  const picked = new Set(Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]);
  return requestCategories.filter((category) => picked.has(category));
}
