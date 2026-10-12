# 11. 거래 완료·후기 보안 검토

Date: 2026-10-12
Scope: issue 19 step 8 변경 소스, 신규 파일, 테스트, 승인 계약 `docs/specs/11-transaction-completion-reviews.md`.

## 결과

**차단할 보안 문제 없음.** 승인된 공개 범위에 따라 후기의 역할·평점·본문·작성일이 익명 사용자에게 보이는 동작은 정상이다. 검토 중 소스 또는 DB 데이터는 수정하지 않았다.

## 확인 근거

| 영역 | 확인 내용 |
| --- | --- |
| 완료 권한 | `backend/app/services/transactions.py:30-55`는 요청 행을 잠근 뒤 `buyer_id`를 인증된 사용자와 비교하고, `matched` 및 확정 지원이 있을 때만 완료한다. 재요청도 구매자 확인을 거친다. |
| 후기 작성 권한 | `backend/app/services/reviews.py:87-108`은 구매자 또는 `accepted` 지원의 판매자만 허용하며 역할과 대상 ID를 서버에서 도출한다. `backend/app/schemas/reviews.py:14-25`는 입력을 평점·본문으로 제한하고 추가 필드를 거부한다. 비참여자와 없는 요청은 같은 404로 귀결된다. |
| 중복·경합 | `backend/app/repositories/reviews.py:40-59`의 `ON CONFLICT DO NOTHING`과 마이그레이션의 `(request_id, reviewer_id)`·`(request_id, reviewer_role)` 유니크 제약이 한 사람·한 역할당 한 건을 강제한다. `backend/app/services/chat.py:114-118`은 전송 잠금 이후 요청 상태를 재조회하며, 완료 경로는 요청→확정 지원 순으로 잠근다. |
| 공개 DTO·캐시 | `backend/app/services/reviews.py:29-65`는 공개 항목을 `reviewerRole`, `rating`, `body`, `createdAt`으로 한정한다. 인증된 참여자에게만 `mine`·`received`를 채우며 여기도 같은 공개 DTO를 쓴다. `backend/app/main.py:55-65`는 새 `/api/requests` 응답에 `Cache-Control: no-store`를 적용한다. |
| CSRF·오류·로그 | 새 POST 라우트는 `require_auth_post_request`를 사용한다(`backend/app/api/reviews.py:36-40,78-82`); 이 의존성은 허용 Origin, `X-Requested-With`, JSON을 검사한다(`backend/app/api/deps.py:65-71`). 422 응답은 고정 필드 문구만 내보내고(`backend/app/main.py:99,112,123-139`), DB 실패 로거는 쿼리·후기 본문을 기록하지 않는다(`backend/app/core/db_logging.py`). |
| SSR·XSS | 요청 상세는 동적 렌더링이며 쿠키별 후기 조회를 `no-store` fetch로 수행한다(`frontend/src/app/requests/[id]/page.tsx:15,51-55,75-93`, `frontend/src/lib/api/http.ts:112-126`). 공개 후기와 채팅방 후기 본문은 React 텍스트 노드로 렌더한다(`frontend/src/features/reviews/components/PublicReviewList.tsx:87-101`, `ReviewPanel.tsx:26-37`); HTML 삽입 경로가 없다. |
| 마이그레이션 | `backend/migrations/versions/0007_completion_reviews.py:16-71`은 컬럼·체크·테이블·인덱스만 추가하며 기존 행 `UPDATE`/`DELETE`가 없다. `downgrade`는 DDL 전 즉시 중단한다. 기존 공유 DB에서 적용 후 백엔드 272개 테스트가 통과했다는 기록은 `docs/verification/11-backend.md`에 있다. |

기존 검증 증거: 백엔드 전체 272 passed 및 완료/후기/경합/마이그레이션 집중 30 passed(`docs/verification/11-backend.md`), 프론트엔드 317 passed와 lint/type/build 통과(`docs/verification/11-frontend.md`). 이 검토에서는 전체 테스트를 다시 실행하지 않았고 DB에 쓰지 않았다.

## 범위 내 잔여 사항

수정 요청 없음. 자유 서술 후기에 개인정보를 사용자가 직접 기입할 가능성과 신고·숨김 기능 부재는 승인 계약 §14 X4·X12에 명시된 제품 정책의 한계이며, 이번 구현에서 새로 발견한 권한 우회나 의도치 않은 데이터 노출은 아니다.
