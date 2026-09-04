import { describe, expect, it } from 'vitest';

import { mockApplicants } from '@/lib/mock/applicants';
import { mockRequests } from '@/lib/mock/requests';

describe('구매요청 목업 데이터', () => {
  it('설계 문서의 데이터 다양성 조건을 만족한다', () => {
    expect(mockRequests.length).toBeGreaterThanOrEqual(12);
    expect(new Set(mockRequests.map((request) => request.status))).toEqual(
      new Set(['open', 'matched', 'closed']),
    );
    expect(new Set(mockRequests.map((request) => request.category)).size).toBeGreaterThanOrEqual(4);
    expect(mockRequests.some((request) => request.applicantCount === 0)).toBe(true);
    expect(mockRequests.some((request) => request.title.length >= 50)).toBe(true);
    expect(mockRequests.every((request) => request.title.length <= 60)).toBe(true);
    expect(mockRequests.every((request) => request.priceMin <= request.priceMax)).toBe(true);
    expect(new Set(mockRequests.map((request) => request.createdAt)).size).toBe(mockRequests.length);
  });

  it('카드의 지원자 수와 상세 목업 지원자 수가 일치한다', () => {
    for (const request of mockRequests) {
      const actualApplicantCount = mockApplicants.filter(
        (applicant) => applicant.requestId === request.id,
      ).length;
      expect(actualApplicantCount, request.id).toBe(request.applicantCount);
    }
  });

  it('한 요청에 지원자 3명 이상이 연결되어 있다', () => {
    const counts = new Map<string, number>();
    for (const applicant of mockApplicants) {
      counts.set(applicant.requestId, (counts.get(applicant.requestId) ?? 0) + 1);
    }
    expect([...counts.values()].some((count) => count >= 3)).toBe(true);
  });
});
