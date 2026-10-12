# 11. 거래 완료 & 후기 — 프론트엔드 구현 검증

Date: 2026-10-12 · 기준: `docs/specs/11-transaction-completion-reviews.md` §6.5, §11 (H4: 후기는 익명 포함 전체 공개)

## 구현 범위

- `completed` enum: `types/request.ts`, `types/application.ts`, `lib/api/{requests,applications,chat}.ts` 파서 가드, `Badge`(“거래완료”, violet), `ChatStatusBadge`(“거래 완료”). 오류 code 4종(`COMPLETION_FORBIDDEN`, `REQUEST_NOT_MATCHED`, `REQUEST_NOT_COMPLETED`, `ALREADY_REVIEWED`)을 `types/api.ts`·`http.ts`에 추가.
- `types/review.ts`, `lib/api/reviews.ts`(`completeTransaction`, `getTransactionReviews`, `createReview`). GET의 후기(`items`·`mine`·`received`)는 정확히 `reviewerRole/rating/body/createdAt` 4키만 허용하고, 추가 키(id·사용자 정보)·3건 이상·범위 밖 평점·잘못된 `viewerRole`/`canWrite`는 `INTERNAL_ERROR`. POST 응답은 `id` 필수. 완료·후기 POST의 409 추정값(`EMAIL_ALREADY_EXISTS`)은 `INTERNAL_ERROR`로 보정.
- `features/transactions/components/CompleteTransactionButton.tsx`(테스트 합의 경로): 2단계 확인, 진행 중 비활성(“완료 중…”), 성공·`REQUEST_NOT_MATCHED` 시 `router.refresh()`, `COMPLETION_FORBIDDEN`/`NOT_FOUND`는 서버 문구, 401·그 외 고정 문구. 구매자 + `matched` 채팅방(`ChatMessagePanel`)과 owner + `matched` 요청의 accepted 지원 카드(`ApplicantList`)에만 노출.
- `features/reviews/components/`: `ReviewPanel`(참여자 전용: 1~5 라디오 `radiogroup`, 2~500자 trim, 공개·수정불가 안내를 제출 버튼 위 상시 표시, 제출 중 비활성, 201/200 → 카드 교체, 409 `ALREADY_REVIEWED` 재조회, 409 `REQUEST_NOT_COMPLETED` refresh, 422 필드 오류, 401 로그인 이동, 404/503/네트워크 입력 유지, 내 후기 카드 + “공개된 후기 보기” 링크, 받은 후기/없음 문구), `PublicReviewList`(공개 목록, 역할 라벨·별점 텍스트 대체·`whitespace-pre-wrap`, 빈 상태, SSR 실패 시 마운트 1회 재조회와 “다시 시도”), `RatingStars`.
- `ChatMessagePanel`: `completed` 배너·입력 비활성 문구, 전송 409 `CHAT_ROOM_CLOSED`는 직전 `matched`면 `completed`, 폴링이 `completed`를 처음 관측한 순간 `router.refresh()` 1회(커서·폴링 주기·백오프 변경 없음, 처음부터 completed인 방은 호출 없음). `ChatRoomView`는 `completed`일 때 `ReviewPanel`을 렌더하고 `/chats/[roomId]` SSR이 완료 방에서만 후기를 읽는다(실패 시 null).
- `ApplicantList`/`ApplyPanel`: completed + accepted에 “거래 후기”/“후기 남기기” 링크(`/chats/{id}#reviews`). `app/requests/[id]/page.tsx`는 `completed`일 때만 선택 쿠키로 후기를 읽고(실패는 null), `RequestDetail`이 모든 방문자(익명 포함)에게 `PublicReviewList`를 보여 준다.

## 사람/코디네이터 합의 사항

- `completeTransaction(requestId)`, `createReview(requestId, payload)`는 테스트 계약상 `signal` 인자 없이 호출한다(unmount 시에는 mounted ref로 상태 갱신을 막는다).
- 코디네이터 지적(PublicReviewList 수명주기) 반영: `PublicReviewList`·`ReviewPanel`은 `requestId`/`initial` 변화에 한 effect로 반응해 진행 중 조회를 취소하고 data·error·loading을 초기화한다. 회귀 테스트 1건 추가(`PublicReviewList.test.tsx`: 요청 변경 + SSR null 시 이전 요청 후기를 유지하지 않음).

## 테스트 수정 기록 (frontend/tests 소유권 이전 후)

| 파일 | 변경 | 사유 |
| --- | --- | --- |
| `RequestDetail.test.tsx` | completed 익명 케이스에 `applicantCount: 1` 전달 | 기본 fixture `applicantCount: 0`이면 기존 계약(0명 → “아직 지원한 판매자가 없어요”, `ApplicantList.test.tsx` 고정)이 🔒 문구보다 우선해 단언이 성립하지 않는 fixture 결함. 완료된 요청은 확정 지원이 있어 인원 ≥ 1이다. 계약은 약화하지 않았다 |
| `PublicReviewList.test.tsx` | 요청 변경 회귀 테스트 1건 추가 | 위 수명주기 지적 |
| `ChatMessagePanel.test.tsx` | 회귀 테스트 2건 추가, 기존 “completion poll” 테스트의 부모 room을 completed → matched로, 두 번째 describe `beforeEach`에 `routerRefresh.mockReset()` 추가 | 아래 후속 수정 참조. 기존 테스트는 부모 completed + 폴링 completed에서 refresh를 기대해 “처음부터 completed인 방은 refresh하지 않는다”는 계약과 모순이었고, mock 미초기화는 테스트 간 호출 수 누수 |

그 외 RED 테스트는 수정하지 않았다. 타입 추론 fixture로 인한 컴파일 오류는 없었다.

## 후속 수정 — 폴링 completed refresh 기준 (2026-10-12)

`/chats/[roomId]`는 방과 메시지를 동시에 읽으므로 구매자가 완료한 직후 부모 `room.chatStatus`는 `matched`인데 `initialList.room.chatStatus`는 `completed`일 수 있다. 이때 `observedStatusRef`를 `initialList`로 초기화하면 이후 completed 폴링이 전이로 보이지 않아 `ReviewPanel`이 새로고침 없이는 나타나지 않았다. `ChatMessagePanel.tsx`에서 `observedStatusRef`의 초기값을 부모 `room.chatStatus`로 바꿨다(1줄). 부모가 matched면 첫 completed 폴링에서 `router.refresh()` 정확히 1회, 부모가 처음부터 completed면 호출 없음, 커서·폴링 주기는 변경 없다.
RED 증명: 초기값을 `initialList` 기준으로 되돌리면 새 회귀 테스트(부모 matched + initialList completed)가 실패하고(`ChatMessagePanel.test.tsx` 1 failed / 40 passed), 수정 후 41/41 통과한다.

## 후속 수정 — 375px 요청 상세 가로 넘침 (2026-10-12)

UI 검증에서 기존(이번 변경 이전부터 있던) 문제가 확인됐다: 375px에서 긴 마스킹 이메일이 `RequestDetail`의 암묵적 auto 그리드 열 min-content를 키워 카드보다 넓어지고 설명이 잘리며 `innerWidth`가 460까지 늘었다. `RequestDetail.tsx`의 클래스만 수정했다(재설계 없음, 데스크톱 `lg` 2열 유지): 그리드 `grid-cols-1`(= `minmax(0,1fr)`) 명시, `lg:grid-cols-[minmax(0,1fr)_280px]`, 왼쪽 열·구매자 `aside`에 `min-w-0`, 설명 `break-words`(이메일은 기존 `truncate` + `min-w-0` 컨테이너). 클래스만 바뀌어 `npm build`는 재실행하지 않았다(UI 개발 서버 동작 중). lint·`tsc --noEmit`·`RequestDetail.test.tsx` 통과.

## 검증 결과 (`frontend/`)

- `npm test`: 34 files, **319 tests passed**
- `npm run lint`: 경고 0
- `npx tsc --noEmit`: 오류 0
- `npm run build`: 성공 (`/chats/[roomId]`, `/requests/[id]` 동적 라우트 포함)
- DB·백엔드는 건드리지 않았고 mock 데이터도 추가하지 않았다. 브라우저/모바일(375px) 실사용 검증은 ui tester 단계에서 수행한다.
