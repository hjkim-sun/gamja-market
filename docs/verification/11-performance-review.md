# 11 거래 완료·후기 — 성능/동시성 리뷰

- 리뷰어: perf_reviewer (`term_3e29bf62-5ab1-4e71-8b53-7e49c2a88a15`, task `task_e8949db3ae71`)
- 일자: 2026-10-12
- 대상: 작업 트리 diff + 신규 파일 (완료 `services/transactions.py`, 후기 `api|services|repositories|schemas/reviews.py`, `migrations/versions/0007_completion_reviews.py`, 전송 경로 변경, 프론트 후기 조회·렌더·폴링 전이)
- 기준: 승인된 `docs/specs/11-transaction-completion-reviews.md`
- 방법: 코드 정독 + 로컬 DB(`gamja_market`, 0007 적용 상태) **읽기 전용** `EXPLAIN`. 소스·테스트·DB 수정 없음, 테스트 스위트 재실행 없음.

## 결론

**머지 차단(blocker) 없음.** 신규 쿼리는 모두 인덱스 단건 조회이고 결과 행 수가 고정이며, 완료↔전송 직렬화·잠금 순서·`clock_timestamp()` 처리는 spec §5와 일치한다.
운영 배포 전에 처리하길 권하는 항목 1건(P-1), 선택 최적화 3건(P-2~P-4)이 있다.

| ID | 심각도 | 구분 | 한 줄 요약 |
| --- | --- | --- | --- |
| P-1 | Medium | 배포 전 권장 (머지 차단 아님) | 0007이 `lock_timeout` 없이 `purchase_requests` ACCESS EXCLUSIVE를 요청한다 |
| P-2 | Low | 선택 | 구매자 탭에서 완료 직후 `router.refresh()` 가 2번 나갈 수 있다 |
| P-3 | Low | 선택 | `/complete` 가 소유자 확인 전에 요청 행을 잠근다 |
| P-4 | Low | 선택 | `lock_for_send` 의 `purchase_requests` 조인이 이제 쓰이지 않는다 |

## 발견 사항

### P-1 (Medium, 배포 전 권장) 마이그레이션 0007에 `lock_timeout` 이 없다

- 위치: `backend/migrations/versions/0007_completion_reviews.py:16-67`, `backend/migrations/env.py:37` (마이그레이션 전체가 한 트랜잭션)
- 시나리오: 첫 문장(`ADD COLUMN`, 17행)이 `purchase_requests` 에 ACCESS EXCLUSIVE를 요청하고, 이 잠금은 CHECK 교체(21행)·CHECK 추가(35행)·`reviews` 생성(42행, FK 때문에 `purchase_requests`·`users` 에 SHARE ROW EXCLUSIVE)·인덱스 2개(66-67행)가 끝나 커밋될 때까지 유지된다. 그 시점에 `purchase_requests` 를 잡은 장기 트랜잭션(또는 idle in transaction 세션)이 하나라도 있으면 ALTER가 **무기한 대기**하고, 그 뒤에 오는 목록·상세·지원·전송(조인) 쿼리가 전부 ALTER 뒤에 줄을 선다. 관측 증상은 차단 세션이 끝날 때까지 사이트 전반의 응답 정지다.
- 스캔 비용 자체는 문제 아니다: CHECK 2개가 전체 스캔 2회지만 로컬 기준 4,228행 / 2.6MB 라 ms 단위다(spec §9 판단과 같다).
- 최소 수정: `upgrade()` 첫 줄에 `op.execute(sa.text("SET LOCAL lock_timeout = '5s'"))` 1줄. 마이그레이션이 이미 멱등(`IF NOT EXISTS`, `DO` 가드)이라 타임아웃으로 실패해도 그대로 재실행하면 된다.
- 차단 여부: 코드 결함이 아니라 배포 시점 위험이다. 한산한 시간에 적용한다면 수정 없이도 넘어갈 수 있다.

### P-2 (Low, 선택) 구매자 탭에서 완료 직후 `router.refresh()` 중복

- 위치: `frontend/src/features/transactions/components/CompleteTransactionButton.tsx:38-40,60`, `frontend/src/features/chat/components/ChatMessagePanel.tsx:135-140`
- 시나리오: 구매자가 채팅방에서 완료 → POST 성공 → `router.refresh()`(40행). 이 갱신이 도착해 `observedStatusRef` 가 맞춰지기(89행) 전에 3초 폴링이 `completed` 를 보면 `becameCompleted` 가 참이 되어 refresh가 한 번 더 나간다(140행). 갱신 1회는 백엔드 요청 4건(`generateMetadata` 의 `getChatRoom` + 페이지의 `getChatRoom`·`listMessages(limit=100)`·후기 GET)이다. 발생 확률은 대략 (refresh 소요 시간 / 3초), 완료 1건당 최대 1회라 누적 비용은 작다.
- 같은 창에서 `finally` 가 `submitting` 을 풀어(60행) "완료" 버튼이 잠깐 다시 눌린다. 다시 누르면 멱등 200 재응답(요청 행 `FOR NO KEY UPDATE` + 확정 지원 행 `FOR UPDATE`)과 refresh가 한 번 더 나간다.
- 최소 수정: 성공 시 `submitting` 을 풀지 않는다(버튼은 refresh로 사라진다). 폴링 쪽 중복까지 없애려면 버튼에 `onCompleted` 콜백을 받아 `ChatMessagePanel` 이 `observedStatusRef.current = 'completed'` 로 먼저 맞추게 한다.

### P-3 (Low, 선택) `/complete` 가 소유자 확인 전에 요청 행을 잠근다

- 위치: `backend/app/services/transactions.py:30-36`
- 시나리오: 로그인한 임의 사용자가 남의 요청 id로 `POST /api/requests/{id}/complete` 를 반복 호출하면, 403이 나기 전에 매번 요청 행 `FOR NO KEY UPDATE` 를 잡는다. 이 잠금은 지원 경로의 `FOR SHARE`(`repositories/applications.py:24`)와 충돌하므로, 동시 다발 호출 시 해당 요청 하나의 지원·매칭이 지연된다(대기 상한 `lock_timeout` 5초 → 503). 보유 시간은 왕복 1회 수준이고 영향은 요청 1건에 한정된다. 기존 `/match`(`services/matching.py:49-55`)와 같은 패턴이라 이번에 새로 생긴 종류의 위험은 아니다.
- 최소 수정: 잠금 전에 이미 있는 `application_repository.request_exists_and_buyer`(`repositories/applications.py:128`)로 무잠금 확인 후 404/403을 먼저 반환한다. 정상 경로에 PK 조회 1회가 늘어난다.

### P-4 (Low, 선택) `lock_for_send` 의 `purchase_requests` 조인이 쓰이지 않는다

- 위치: `backend/app/repositories/chat_rooms.py:50,53`, `backend/app/services/chat.py:114`
- 시나리오: 전송은 이제 잠금 뒤 `get_status` 로 요청 status를 다시 읽으므로(114행) `lock_for_send` 가 반환하는 `p.status AS request_status` 는 어디서도 읽지 않는다. 메시지 1건마다 PK 조회 1회(버퍼 3)가 남는다.
- 최소 수정: SELECT 목록의 `p.status` 와 `JOIN app_private.purchase_requests p` 를 제거한다. 잠금 절은 그대로 둔다. 다만 spec §5.2가 "SELECT 목록에 `a.request_id` 추가"만 명시하므로 spec 한 줄 갱신이 따라야 한다. 이득이 작아 후속으로 미뤄도 된다.

## 확인했고 문제 없는 항목

- **쿼리 한정성·인덱스** (로컬 `EXPLAIN`)
  - `get_transaction`: `purchase_requests` PK 계열 인덱스 + `uq_seller_applications_one_accepted`, 버퍼 6, 0.3ms. 부분 유니크 인덱스라 `one_or_none()` 이 안전하다.
  - `list_for_request`: `uq_reviews_request_role`, `LIMIT 2`. `get_by_reviewer`: `uq_reviews_request_reviewer`.
  - `lock_accepted_application`: `uq_seller_applications_one_accepted` → `uq_chat_rooms_application`.
  - `ix_reviews_reviewee_id`·`ix_reviews_reviewer_id` 는 현재 스캔 0회지만 `users` 삭제 cascade용(spec §4)이라 유지가 맞다.
- **완료↔전송 직렬화** (`transactions.py:30-73`, `chat.py:103-118`): 완료가 확정 지원 행 `FOR UPDATE`, 전송이 `FOR SHARE` 로 만난다. 전송은 잠금 뒤 별도 문장으로 status를 읽으므로 READ COMMITTED(로컬 기본값 확인)에서 새 스냅샷을 본다. 잠금 대기 뒤 같은 문장의 조인 값이 낡는 문제를 피했다.
- **잠금 순서**: 완료·매칭은 요청 → 지원, 전송은 방 → 지원이고 요청 행은 잠그지 않는다. 후기 INSERT의 FK 검사(`FOR KEY SHARE`)는 완료의 `FOR NO KEY UPDATE` 와 호환된다. 역순 경로가 없다.
- **타임아웃**: 완료·후기·전송 모두 트랜잭션 로컬 `lock_timeout`(기본 5000ms)을 건다. 잠금 획득마다 따로 적용되므로 완료의 최악 대기는 약 10초(요청 5초 + 지원 5초)이고 503으로 끝난다. 같은 방의 전송이 연속되면 완료의 `FOR UPDATE` 가 `FOR SHARE` 에 밀릴 수 있으나, 방 잠금으로 전송이 직렬화되어 동시에 한 건뿐이고 같은 상한에 걸린다.
- **트랜잭션 시작 시각 함정**: `completed_at`·`updated_at` 은 두 잠금을 얻은 뒤 `clock_timestamp()` 를 한 번 읽어 같은 값으로 바인드한다(`transactions.py:57-61`). 참고로 `reviews.created_at` 은 `DEFAULT now()`(트랜잭션 시작 = 인증 조회 시각)라, 완료 커밋과 수 ms 안에 겹친 후기 POST에서는 `created_at < completed_at` 이 될 수 있다. 이 순서에 의존하는 제약·화면이 없어 조치는 필요 없다.
- **SSR 요청 수**: 후기 GET은 렌더당 1회다. 요청 상세는 `completed` 일 때만 호출하고(`requests/[id]/page.tsx:83`), 채팅 페이지는 메시지 조회와 병렬이다(`chats/[roomId]/page.tsx`). 요청 상세에서 후기 조회가 요청 조회 뒤에 직렬인 것은 status를 알아야 해서이며, 무조건 병렬로 바꾸면 87%인 open 요청에 불필요한 호출이 생기므로 현재가 맞다.
- **클라이언트 effect·재시도**: `ReviewPanel`·`PublicReviewList` 는 SSR 값이 null일 때만 1회 조회하고, 실패 시 자동 재시도 없이 수동 버튼(진행 중 비활성)만 둔다. 재조회 시 이전 요청을 abort한다. `router.refresh()` 로 `initial` 이 새 객체가 되면 서버 값으로 덮어쓸 뿐 추가 조회는 없고, null → null 이면 effect가 다시 돌지 않아 루프가 없다. 후기 영역 폴링은 없다(spec X6).
- **폴링 전이**: 폴링 effect 의존성은 `[roomId, loginHref, unavailable]` 라 refresh로 재시작하지 않는다. 상대 탭의 `matched → completed` refresh는 `observedStatusRef` 로 1회로 제한되고, 완료 상태로 연 방에서는 나가지 않는다.
- **공개 GET 비용**: 익명 호출 1건은 DB 연결 1개 + 인덱스 쿼리 1~2개, 응답은 최대 2행 × 500자다. 레이트리밋이 없는 것은 기존 공개 읽기와 같고 spec X13에 기록된 수용 사항이다.

## 알려진 수용 사항 (finding 아님)

- 완료된 방도 열려 있으면 3초 폴링이 계속된다(spec X8). 폴링 1회는 세션 조회 + 방 상태 조회 + `list_after` 다.
- 새 후기는 새로고침해야 보인다(spec X6).

## 한계

- 운영(Supabase) 데이터 규모와 풀러 설정은 보지 않았다. 스캔·플랜 수치는 로컬 DB 기준이다.
- 동시성 테스트(`test_completion_concurrency.py`)는 다시 실행하지 않았고, 직렬화 판단은 코드와 spec 대조에 근거한다.
- P-2의 중복 refresh는 코드 경로로 확인한 것이며 브라우저에서 재현해 보지는 않았다.
