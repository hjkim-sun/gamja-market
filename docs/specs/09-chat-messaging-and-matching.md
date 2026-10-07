# 09. 구매자-판매자 폴링 채팅 &amp; 구매자 확정 매칭 — 구현 계약

> **사람 검토 승인 (2026-10-07)**: 사용자가 §15의 권장 기본값과 전체 설계를 승인했다. tester RED → backend/frontend → UI 검증 순서로 진행한다.
>
> 기준: `curriculum.md` **6단계**(“폴링 기반(3~~5초) 채팅으로 구매자와 판매자가 메시지를 주고받으며 거래 조건 협의”)와 **7단계**(“구매자가 여러 채팅 중 1명 확정 → 나머지 자동 마감 처리”), 설계 원칙 “지원(4) → 채팅(6) → 매칭(7) 순서: 채팅의 결과가 매칭을 결정”.
> 조사 대상: worktree `feature-buyer-seller-chat-matching`(branch `feature/buyer-seller-chat-matching`, HEAD `2d4e57b`, 2026-10-07). 문서 번호는 `01`~~`08` 다음인 `09`이며 커리큘럼 단계 번호와 다르다.
> 선행 계약: [06 지원·채팅방](06-seller-applications-chat-rooms.md), [07 사진](07-purchase-request-photos.md), [08 private 버킷](08-private-request-photo-bucket.md). 이 문서는 그 계약을 **바꾸지 않고 확장**한다(12장).
> 설계자는 이 문서 외에 어떤 파일도 수정하지 않았고, DB에는 접근하지 않았다(조사 시점 docker 데몬 정지 — 2.4).

---

## 0. 한눈에 보기


| #    | 항목        | 결정                                                                                                                                                        |
| ---- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | 새 테이블     | `app_private.chat_messages` (방별 단조 증가 `seq`)                                                                                                              |
| 0.2  | 기존 테이블 변경 | `seller_applications`에 **컬럼 2개 추가**(`status` 기본값 `'pending'`, `decided_at` NULL 허용)와 CHECK 2개, 부분 unique 인덱스 1개. 기존 컬럼·제약의 변경·삭제 없음                       |
| 0.3  | 마이그레이션    | revision `0005_chat_matching`(18자), `down_revision = "0004_request_photos"`. 멱등 additive DDL. stamp/downgrade/reset 금지                                    |
| 0.4  | 채팅 방식     | 짧은 폴링. `GET /api/chat-rooms/{roomId}/messages?afterSeq=N` 을 **3초** 간격(탭 숨김 시 중지, 오류 시 지수 백오프 최대 30초)                                                      |
| 0.5  | 메시지 순서 보장 | 방 행 잠금(`FOR NO KEY UPDATE`) 안에서 `seq = max+1` 을 배정하고 같은 트랜잭션에서 커밋 → 커밋 순서 = `seq` 순서. `afterSeq` 커서가 메시지를 건너뛸 수 없다                                        |
| 0.6  | 중복 전송 방지  | 클라이언트가 만든 `clientMessageId`(UUID) + `UNIQUE(room_id, sender_id, client_message_id)` → 재시도는 기존 메시지 200                                                     |
| 0.7  | 매칭        | `POST /api/requests/{requestId}/match` `{applicationId}`. 한 트랜잭션에서 선택 지원 `accepted`, 나머지 `pending` 지원 전부 `closed`, 요청 `open → matched`. 같은 지원 재확정은 멱등 200 |
| 0.8  | 동시성       | 매칭은 요청 행 `FOR NO KEY UPDATE` → 06의 지원 `FOR SHARE` 와 직렬화. 메시지 전송은 지원 행 `FOR SHARE` → 매칭의 지원 UPDATE와 직렬화. 마감 이후 커밋되는 메시지·지원은 존재할 수 없다                       |
| 0.9  | 권한        | 방·메시지는 해당 지원의 구매자·판매자만. 비참여자와 없는 방은 **동일한 404**. 매칭은 요청 작성자만(403 `NOT_REQUEST_OWNER`, 지원 id 조회 전에 판정). 누가 매칭됐는지는 참여자 외에 노출하지 않는다                          |
| 0.10 | 새 API     | `POST /api/requests/{id}/match`, `GET /api/chat-rooms`(내 채팅 목록), `GET`/`POST /api/chat-rooms/{roomId}/messages`                                           |
| 0.11 | 기존 API 변경 | **필드 추가만**: `ApplicationView.status`, `ChatRoomView.applicationStatus/chatStatus/canSend`                                                                 |
| 0.12 | 새 화면      | `/chats/[roomId]` 메시지 패널(폴링·입력), 구매자 확정 버튼, `/chats` 채팅 목록, 상세의 지원 상태 배지·확정 버튼, 헤더 “채팅” 링크                                                                |
| 0.13 | 테스트 DB    | 로컬 공유 DB 그대로. DELETE/TRUNCATE/DROP/downgrade/stamp 금지, `test_ns` 범위 단정, 매칭된 테스트 데이터도 보존(13장)                                                              |


---

## 1. 목표와 범위

### 1.1 이 단계에서 하는 것

1. 지원 1건당 만들어진 기존 채팅방(06)에서 구매자와 판매자가 **텍스트 메시지**를 주고받는다.
2. 새 메시지는 3초 주기 폴링으로 받는다(WebSocket/SSE 없음).
3. 구매자는 자기 요청의 지원 중 **정확히 1건을 확정**한다. 확정과 동시에 같은 요청의 나머지 지원은 자동 `closed`, 요청은 `matched` 가 된다.
4. 마감된(`closed`) 지원의 채팅방은 **읽기 전용**이 된다. 확정된(`accepted`) 방은 계속 대화할 수 있다(8단계 거래 완료 전까지).
5. 로그인 사용자는 `/chats` 에서 자기 채팅방 목록을 본다(06 1.2가 6단계로 미룬 inbox).

### 1.2 하지 않는 것


| 기능                               | 처리                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------- |
| 읽음 표시·안 읽은 개수·알림                 | 하지 않음(15장 H6). 목록은 마지막 메시지 미리보기까지만                                               |
| 이미지·파일 메시지                       | 하지 않음. 사진 계약(07/08)은 손대지 않는다                                                     |
| 매칭 취소·변경, 요청 수동 마감(`closed`) API | 하지 않음. 매칭은 이 단계에서 **되돌릴 수 없다**. `closed` 상태는 기존 CHECK에 이미 있으나 이 단계 API로는 만들지 않는다 |
| 지원 수정·철회                         | 하지 않음                                                                            |
| 이전 메시지 무한 스크롤(`beforeSeq`)       | 하지 않음. 첫 로드는 최근 100건(14장 한계)                                                     |
| WebSocket/SSE/Realtime           | 하지 않음(커리큘럼이 폴링을 지정)                                                              |
| 메시지 수정·삭제, 신고, 전송 속도 제한          | 하지 않음(14장 한계)                                                                    |
| 거래 완료·후기                         | 8단계                                                                              |
|                                  |                                                                                  |


---

## 2. 현재 코드 근거

### 2.1 백엔드


| #    | 위치                                                                         | 관찰                                                                                                                          | 이 설계의 결정                                                             |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| B-1  | `backend/app/db/models.py:119-150`                                         | `SellerApplication` 에 상태 컬럼이 없다(06 1.2가 “7단계 이후 추가 컬럼으로 도입”이라고 예고)                                                          | `status`, `decided_at` 컬럼을 **추가**한다(4.1)                             |
| B-2  | `backend/app/db/models.py:152-165`                                         | `ChatRoom(id, application_id UNIQUE, created_at)`. 참여자 컬럼 없음(06 D7)                                                         | 변경하지 않는다. 메시지 순서 잠금 대상으로만 쓴다                                         |
| B-3  | `backend/app/db/models.py:64`                                              | `purchase_requests.status IN ('open','matched','closed')` CHECK가 이미 있다                                                      | 스키마 변경 없이 `matched` 전이를 사용한다                                         |
| B-4  | `backend/app/repositories/applications.py:13-25`                           | 지원 시 요청 행 `FOR SHARE`(06 D4: “7단계 상태 UPDATE와 직렬화”)                                                                          | 매칭은 요청 행을 `FOR NO KEY UPDATE` 로 잠가 이 약속을 지킨다(5.1)                    |
| B-5  | `backend/app/services/applications.py:89-176`                              | `SET LOCAL lock_timeout`(`set_config(..., true)`), 결과 행 유무 분기, 제약 이름 기반 `IntegrityError` 분류, 단일 commit, SQLAlchemy 오류 → 503 | 매칭·메시지 서비스가 같은 패턴을 그대로 따른다                                           |
| B-6  | `backend/app/services/applications.py:111`                                 | `status != 'open'` → `REQUEST_NOT_OPEN`                                                                                     | 매칭 후 신규 지원은 이 규칙으로 409가 된다. 변경 없음                                    |
| B-7  | `backend/app/repositories/chat_rooms.py:19-32`                             | 참여자 판정을 단일 조인 + `viewer IN (buyer_id, seller_id)` 로 한다                                                                      | 메시지 조회·전송도 같은 조인으로 판정하고, 결과 없음은 404                                  |
| B-8  | `backend/app/repositories/applications.py:65-84`                           | 목록은 owner 전체 / applicant 본인 / 나머지 `[]`                                                                                      | 범위 규칙 유지, 항목에 `status` 만 추가                                          |
| B-9  | `backend/app/main.py:77-79`                                                | 422 필드 맵을 경로로 고른다. `/api/requests` 가 아니면 **auth 맵**으로 떨어진다                                                                  | `/api/chat-rooms/*/messages` 와 `/api/requests/*/match` 분기를 추가한다(6.7) |
| B-10 | `backend/app/main.py:27,39`                                                | `/api/requests`, `/api/chat-rooms` prefix 응답에 `no-store`                                                                    | 새 경로가 모두 이 prefix 안이므로 미들웨어 변경 없음. 라우터는 `_no_store` 호출을 유지           |
| B-11 | `backend/app/api/errors.py:7-25`                                           | 모르는 code는 `KeyError`                                                                                                        | 새 code 4개 추가(6.6)                                                    |
| B-12 | `backend/app/core/config.py:24`                                            | `application_lock_timeout_ms`(기본 5000)                                                                                      | 매칭·메시지 전송도 이 값을 재사용한다(새 설정 없음)                                       |
| B-13 | `backend/app/db/session.py`                                                | `NullPool` — 요청 1건 = PG 커넥션 1개                                                                                              | 폴링 1회도 커넥션 1개. 3초 간격 비용은 14장에 기록                                     |
| B-14 | `backend/app/repositories/requests.py:74-76`                               | 목록 상태 필터는 `open` 만 노출, 그 외는 전체                                                                                              | 변경 없음. `matched` 요청은 공개 목록에 “매칭됨” 배지로 계속 보인다                         |
| B-15 | `backend/migrations/versions/0004_create_purchase_request_photos.py:10-11` | 현재 head `0004_request_photos`(down `0003_seller_applications`), `IF NOT EXISTS` 멱등 DDL                                      | `0005` 는 `0004` 위에 단일 head로 올리고 같은 멱등 스타일을 쓴다                        |
| B-16 | `backend/tests/conftest.py:65-73`                                          | `_explicit_migration_target` 이 알려진 최신 revision을 **명시**해 upgrade(`head` 금지)                                                  | `0005_chat_matching` 을 최우선 후보로 추가한다(13.2)                            |
| B-17 | `backend/tests/conftest.py:34-51`                                          | 로컬 host 가드, `MIGRATION_DATABASE_URL` 을 런타임 URL로 강제                                                                          | 그대로 재사용. 테스트가 운영 Supabase에 DDL을 적용할 수 없다                             |


### 2.2 프론트엔드


| #    | 위치                                                                   | 관찰                                                                | 결정                                                                                 |
| ---- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| F-1  | `frontend/src/features/chat/components/ChatRoomView.tsx:60-63`       | “메시지 기능을 준비하고 있어요.” 자리 표시                                         | `ChatMessagePanel`(클라이언트 컴포넌트)로 교체(10.3)                                           |
| F-2  | `frontend/tests/ChatRoomView.test.tsx:36-37`                         | textbox·“보내기” 버튼이 **없음**을 단정                                      | 이 단계의 의도된 계약 변경이므로 단정을 반대로 바꾼다(10.8)                                               |
| F-3  | `frontend/src/app/chats/[roomId]/page.tsx:27-42`                     | SSR로 `getChatRoom`, 401 → `/login?next=…`, 404/422 → `notFound()` | 유지. 초기 메시지도 같은 SSR에서 받아 넘긴다                                                        |
| F-4  | `frontend/src/lib/api/applications.ts:28-128`                        | 응답 파서가 필드를 골라 복사한다(추가 필드는 무시)                                     | 새 필드(`status`, `chatStatus` 등)를 파서에 추가해야 화면에 전달된다                                  |
| F-5  | `frontend/src/lib/api/http.ts:43-47`                                 | 본문 파싱 실패 시 409 → `EMAIL_ALREADY_EXISTS` 로 추정                      | 새 클라이언트도 `applyToRequest`(`applications.ts:142`)처럼 409 추정값을 `INTERNAL_ERROR` 로 바꾼다 |
| F-6  | `frontend/src/features/requests/components/ApplicantList.tsx:14-72`  | owner/applicant만 상세를 보고 “채팅방 열기” 링크                               | 상태 배지와 owner 확정 버튼을 추가(10.5)                                                       |
| F-7  | `frontend/src/features/applications/components/ApplyPanel.tsx:57-71` | applicant는 “지원 완료 · 채팅방 열기”                                       | 지원 `status` 에 따라 문구 분기(10.6)                                                       |
| F-8  | `frontend/src/components/ui/Badge.tsx:9-13`                          | 요청 상태 라벨 `open 구해요 / matched 매칭됨 / closed 마감`                     | 그대로 재사용. 지원 상태용 배지는 별도 컴포넌트                                                        |
| F-9  | `frontend/src/features/requests/components/RequestDetail.tsx:27`     | `ownApplication = applications[0]` (applicant일 때)                 | 유지                                                                                 |
| F-10 | `frontend/next.config.ts`                                            | `/api/:path*` rewrite                                             | 새 경로 자동 프록시. 변경 없음                                                                 |


### 2.3 커리큘럼 대응


| 단계  | 요구                        | 이 문서의 대응                                            |
| --- | ------------------------- | --------------------------------------------------- |
| 6   | 폴링(3\~5초) 채팅으로 거래 조건 협의   | 3초 폴링(4\~5초 아님: 대화 체감 지연 최소화, 백오프로 부하 상한) — 0.4, 8장 |
| 7   | 여러 채팅 중 1명 확정 → 나머지 자동 마감 | 채팅방 화면과 지원자 목록 양쪽에서 확정, 단일 트랜잭션 자동 마감 — 5장          |
| 원칙  | 채팅의 결과가 매칭을 결정            | 확정 버튼의 1차 위치는 **채팅방 화면**(구매자). 지원자 목록 버튼은 보조        |


### 2.4 실행 환경 확인

- 조사 시점(2026-10-07) docker 데몬이 꺼져 있어 로컬 DB의 `alembic_version` 을 읽지 못했다. 저장소 기준 기대값은 `0004_request_photos` 이다. **구현 착수 전 tester가 읽기 전용으로 확인한다**(13.1). 다르면 코디네이터에게 escalation한다.
- DB 기동은 `docker compose up -d`(기존 볼륨 유지)만 허용한다. `down -v`, 볼륨 삭제, 새 DB 생성은 금지다.

---

## 3. 핵심 설계 결정


| #   | 결정                                                                             | 이유                                                                                                       |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| D1  | 지원 상태를 `seller_applications.status`(`pending`/`accepted`/`closed`) **컬럼**으로 둔다 | “나머지 자동 마감”이 데이터로 남아 화면·쿼리가 단순하다. 별도 `matches` 테이블은 상태를 매번 파생해야 하고 복합 FK용 제약이 하나 더 필요하다                  |
| D2  | “요청당 accepted 최대 1건”을 **부분 unique 인덱스**로 DB가 강제한다                              | 서비스 버그나 경쟁이 있어도 이중 확정이 저장될 수 없다                                                                          |
| D3  | 매칭은 **요청 행 `FOR NO KEY UPDATE` → 지원 UPDATE 2문장 → 요청 UPDATE → 단일 commit**       | 06의 지원 트랜잭션(`FOR SHARE`)과 상호 배제되어, 매칭 이후 `pending` 지원이 새로 생기거나 남을 수 없다                                   |
| D4  | 같은 지원 재확정은 **멱등 200**, 다른 지원 확정은 409 `REQUEST_ALREADY_MATCHED`                 | 더블클릭·재시도·두 탭에서 안전. 결과가 이미 원하는 상태면 성공으로 본다                                                                |
| D5  | 비작성자의 매칭 시도는 **지원 id를 보기 전에** 403 `NOT_REQUEST_OWNER`                          | 요청은 공개라 존재 은닉이 무의미하지만, 지원 id의 존재 여부는 비공개다. 판정 순서로 누출을 막는다                                                |
| D6  | 메시지 `seq` 는 **방 행 잠금 안에서 `max(seq)+1`** 로 배정                                   | 전역 identity/시퀀스는 커밋 순서와 값 순서가 달라 `afterSeq` 폴링이 늦게 커밋된 작은 번호를 영구히 놓친다. 방 단위 직렬화는 비용이 작다(한 방의 동시 작성자는 2명) |
| D7  | 메시지 전송은 **지원 행 `FOR SHARE`** 를 함께 잡는다                                          | 매칭의 지원 UPDATE와 직렬화되어 “마감 판정 후 커밋되는 메시지”가 생기지 않는다                                                         |
| D8  | 방 쓰기 가능 여부(`canSend`)는 **지원 상태**를 기준으로 판정                                      | 잠근 지원 행이 최신값이다(READ COMMITTED 재평가). 요청 상태는 보조 조건으로만 쓴다(4.4)                                              |
| D9  | `clientMessageId` 로 **멱등 전송**                                                  | 네트워크 재시도 시 중복 메시지가 생기지 않는다. 응답을 못 받은 클라이언트가 같은 id로 다시 보내면 200으로 기존 메시지를 돌려준다                             |
| D10 | 마감 방은 **읽기 허용, 쓰기 409**                                                        | 협의 이력을 양쪽이 계속 볼 수 있어야 분쟁 소지가 적다                                                                          |
| D11 | 비참여자·없는 방은 메시지 API에서도 **동일 404**(06 D9 유지)                                     | 방 id 존재 여부를 숨긴다                                                                                          |
| D12 | 폴링은 `setTimeout` 연쇄(겹침 없음), 탭 숨김 시 중지, 오류 백오프                                  | 요청이 쌓이지 않고, 백그라운드 탭이 DB 커넥션을 쓰지 않는다                                                                      |
| D13 | 클라이언트 커서(`lastSeq`)는 **폴링 결과로만 전진**, 전송 응답으로는 전진하지 않음                          | 내 메시지 `seq=7` 응답을 받았을 때 상대의 `seq=6` 을 아직 못 받았을 수 있다. 전송 응답으로 커서를 올리면 6을 영구히 놓친다                          |
| D14 | 매칭은 되돌릴 수 없다(이 단계)                                                             | 상태 머신과 테스트 면적을 줄인다. 취소 기능은 별도 단계에서 추가 컬럼·전이로 확장 가능                                                       |


---

## 4. DB 스키마 (revision `0005_chat_matching`)

### 4.1 `app_private.seller_applications` 추가 컬럼·제약


| 컬럼           | 타입            | 제약                           |
| ------------ | ------------- | ---------------------------- |
| `status`     | `varchar(10)` | `NOT NULL DEFAULT 'pending'` |
| `decided_at` | `timestamptz` | NULL 허용                      |



| 이름                                    | 정의                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ck_seller_applications_status`       | `CHECK (status IN ('pending', 'accepted', 'closed'))`                                             |
| `ck_seller_applications_decided_at`   | `CHECK ((status = 'pending') = (decided_at IS NULL))`                                             |
| `uq_seller_applications_one_accepted` | `CREATE UNIQUE INDEX … ON app_private.seller_applications (request_id) WHERE status = 'accepted'` |


- 기존 행은 `DEFAULT` 로 `pending`, `decided_at NULL` 이 되어 두 CHECK를 만족한다. **backfill 없음.**
- PostgreSQL 11+ 에서 상수 기본값 `ADD COLUMN` 은 테이블 재작성 없이 메타데이터만 바뀐다(로컬 PG16, Supabase 모두 해당).

### 4.2 `app_private.chat_messages` (신규)


| 컬럼                  | 타입            | 제약                                                |
| ------------------- | ------------- | ------------------------------------------------- |
| `id`                | `uuid`        | PK, 앱에서 `uuid4`                                   |
| `room_id`           | `uuid`        | NOT NULL, FK `chat_rooms(id)` `ON DELETE CASCADE` |
| `sender_id`         | `uuid`        | NOT NULL, FK `users(id)` `ON DELETE CASCADE`      |
| `seq`               | `integer`     | NOT NULL                                          |
| `client_message_id` | `uuid`        | NOT NULL                                          |
| `body`              | `text`        | NOT NULL                                          |
| `created_at`        | `timestamptz` | NOT NULL, `DEFAULT now()`                         |



| 이름                              | 정의                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `fk_chat_messages_room`         | `FOREIGN KEY (room_id) REFERENCES app_private.chat_rooms (id) ON DELETE CASCADE` |
| `fk_chat_messages_sender`       | `FOREIGN KEY (sender_id) REFERENCES app_private.users (id) ON DELETE CASCADE`    |
| `uq_chat_messages_room_seq`     | `UNIQUE (room_id, seq)` — 폴링 커서 인덱스 겸용                                           |
| `uq_chat_messages_client_id`    | `UNIQUE (room_id, sender_id, client_message_id)` — 멱등 전송                         |
| `ck_chat_messages_seq_positive` | `CHECK (seq >= 1)`                                                               |
| `ck_chat_messages_body_len`     | `CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000)`                            |
| `ix_chat_messages_sender_id`    | `(sender_id)` — 회원 삭제 cascade                                                    |


- 발신자가 방 참여자인지는 DB가 아니라 서비스가 보장한다(트리거 없음). 테스트로 고정한다(I6).

### 4.3 SQLAlchemy 모델

`SellerApplication` 끝에 컬럼 2개를 추가하고 `__table_args__` 의 `{"schema": …}` **바로 앞**에 제약 3개를 추가한다.

```python
status: Mapped[str] = mapped_column(String(10), nullable=False, server_default=text("'pending'"))
decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
# __table_args__:
CheckConstraint("status IN ('pending', 'accepted', 'closed')", name="ck_seller_applications_status"),
CheckConstraint("(status = 'pending') = (decided_at IS NULL)", name="ck_seller_applications_decided_at"),
Index("uq_seller_applications_one_accepted", "request_id", unique=True,
      postgresql_where=text("status = 'accepted'")),
```

파일 끝에 `ChatMessage` 를 4.2대로 추가한다(`UniqueConstraint`·`CheckConstraint`·`Index` 이름은 4.2와 동일).

### 4.4 상태 정의와 불변식

**지원 상태 × 요청 상태 → 방 상태(`chatStatus`)**


| 지원 `status` | 요청 `status`                                    | `chatStatus` | `canSend`   |
| ----------- | ---------------------------------------------- | ------------ | ----------- |
| `pending`   | `open`                                         | `active`     | true        |
| `accepted`  | `matched`                                      | `matched`    | true        |
| `closed`    | `matched`                                      | `closed`     | false       |
| `pending`   | `matched`/`closed` (06 테스트가 원시 SQL로 만든 과거 데이터) | `closed`     | false       |
| 그 외 조합      | —                                              | `closed`     | false (방어적) |


판정 함수는 순수 함수 `derive_chat_status(application_status, request_status) -> Literal["active","matched","closed"]` 로 서비스에 둔다(단위 테스트 U1).

**불변식** (테스트는 테스트 소유 요청 id 범위에서만 검사):

- I1 요청당 `accepted` 지원은 최대 1건(DB 부분 unique).
- I2 API로 만든 데이터에서 요청이 `matched` ⇔ 그 요청에 `accepted` 지원이 정확히 1건.
- I3 `matched` 요청에는 `pending` 지원이 없다.
- I4 `status = 'pending'` ⇔ `decided_at IS NULL` (DB CHECK).
- I5 각 방의 `seq` 는 1부터 **빈틈없이 연속**한다(잠금 안에서 `max+1`, 롤백된 시도는 번호를 소모하지 않음).
- I6 모든 메시지의 `sender_id` 는 그 방 지원의 `buyer_id` 또는 `seller_id` 다.
- I7 `closed` 지원의 방에는 마감 커밋 이후 커밋된 메시지가 없다(5.3 직렬화로 보장, C-테스트로 결정적 검증).
- I8 06 불변식 4.4(지원 1건 = 방 1개 등)는 그대로 유지된다.

### 4.5 상태 전이

```
purchase_requests.status : open ──(POST /match 성공)──▶ matched     (이 단계의 유일한 전이, 역전이 없음)
seller_applications.status:
    pending ──(선택됨)──────────▶ accepted   decided_at = now()
    pending ──(다른 지원 선택됨)──▶ closed     decided_at = now()
    accepted / closed : 종료 상태(이 단계)
```

---

## 5. 매칭 트랜잭션과 동시성

### 5.1 `confirm_match` (서비스 `app/services/matching.py`)

```
BEGIN (READ COMMITTED; get_current_user 조회로 이미 시작됨)
  SELECT set_config('lock_timeout', '<application_lock_timeout_ms>ms', true)
  SELECT id, buyer_id, status FROM app_private.purchase_requests
   WHERE id = :request_id FOR NO KEY UPDATE                          -- (1)
   └ 없음                         → ROLLBACK, 404 NOT_FOUND
   └ buyer_id <> :viewer          → ROLLBACK, 403 NOT_REQUEST_OWNER   (지원 id는 아직 보지 않음)
  SELECT id, status, decided_at FROM app_private.seller_applications
   WHERE id = :application_id AND request_id = :request_id FOR UPDATE   -- (2)
   └ 없음                         → ROLLBACK, 404 NOT_FOUND
  분기
   └ 요청 matched AND 이 지원 accepted → (변경 없음) 200 멱등 결과, ROLLBACK(읽기만 했으므로)
   └ 요청 matched                     → ROLLBACK, 409 REQUEST_ALREADY_MATCHED
   └ 요청 closed                      → ROLLBACK, 409 REQUEST_CLOSED
   └ 요청 open AND 지원 ≠ pending     → ROLLBACK, log_database_failure("confirm_match_invariant"), 503
  UPDATE seller_applications SET status='accepted', decided_at=now()
   WHERE id = :application_id AND status = 'pending'                  -- (3) rowcount 1 기대
  UPDATE seller_applications SET status='closed', decided_at=now()
   WHERE request_id = :request_id AND id <> :application_id AND status = 'pending'
   RETURNING id                                                       -- (4) closedCount
  UPDATE purchase_requests SET status='matched', updated_at=now()
   WHERE id = :request_id AND status = 'open'                         -- (5) rowcount 1 기대
  응답 DTO 검증 → COMMIT (단 한 번)                                    -- (6)
```

- (3)·(5)의 rowcount가 1이 아니면 rollback 후 503(불변식 위반, 로그만 남기고 본문에 내부 정보 없음).
- `IntegrityError` 의 제약 이름이 `uq_seller_applications_one_accepted` 면 409 `REQUEST_ALREADY_MATCHED`(방어용), 그 외 503. `OperationalError`(`55P03` 포함)·기타 `SQLAlchemyError` → rollback, `log_database_failure("confirm_match", …)`, 503. 비 DB 예외는 rollback 후 재발생(500) — `apply_to_request` 와 같은 구조.
- 멱등 결과의 `closedApplicationCount` 는 그 요청의 `closed` 지원 수를 다시 센 값이다(첫 응답과 같다).

### 5.2 잠금 호환성


| A 보유                       | B 요청                                            | 결과                                                                 |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| 지원: 요청 `FOR SHARE`         | 매칭: 요청 `FOR NO KEY UPDATE`                      | **매칭 대기.** 지원 커밋 후 매칭이 진행되고, 방금 생긴 `pending` 지원도 (4)에서 `closed` 된다 |
| 매칭: 요청 `FOR NO KEY UPDATE` | 지원: 요청 `FOR SHARE`                              | **지원 대기.** 매칭 커밋 후 최신 행 `matched` → 409 `REQUEST_NOT_OPEN`, 0행     |
| 매칭 A                       | 매칭 B(같은 요청)                                     | B 대기 → A 커밋 후 `matched` 확인 → 같은 지원이면 200 멱등, 다르면 409               |
| 메시지 전송: 지원 행 `FOR SHARE`   | 매칭: (3)/(4) 지원 UPDATE                           | **매칭 대기.** 메시지가 `pending` 상태에서 먼저 커밋된 뒤 마감                         |
| 매칭: 지원 행 UPDATE(미커밋)       | 메시지 전송: 지원 행 `FOR SHARE`                        | **전송 대기.** 재평가된 행이 `closed` → 409 `CHAT_ROOM_CLOSED`, 0행           |
| 요청 `FOR NO KEY UPDATE`     | 메시지 INSERT의 FK 검사(`chat_rooms` `FOR KEY SHARE`) | 무관(다른 테이블)                                                         |


**잠금 순서**: 매칭 = `purchase_requests` → `seller_applications`. 메시지 전송 = `chat_rooms` → `seller_applications`. 지원 = `purchase_requests`(SHARE) → INSERT. 어떤 경로도 역순으로 잡지 않으므로 교착이 없다. 매칭은 `chat_rooms` 를 잠그지 않는다.

### 5.3 메시지 전송 트랜잭션 (`app/services/chat.py` `send_message`)

```
BEGIN
  SELECT set_config('lock_timeout', …, true)
  SELECT r.id, a.id, a.buyer_id, a.seller_id, a.status, p.status
    FROM app_private.chat_rooms r
    JOIN app_private.seller_applications a ON a.id = r.application_id
    JOIN app_private.purchase_requests p   ON p.id = a.request_id
   WHERE r.id = :room_id AND :viewer IN (a.buyer_id, a.seller_id)
   FOR NO KEY UPDATE OF r  FOR SHARE OF a                              -- (1)
   └ 없음 → ROLLBACK, 404 NOT_FOUND
  SELECT … FROM chat_messages WHERE room_id=:room AND sender_id=:viewer
   AND client_message_id = :cid                                        -- (2)
   └ 있음 → ROLLBACK, 200 { message: 기존 }   (마감 이후의 재시도라도 기존 메시지를 돌려줌)
  derive_chat_status(a.status, p.status) ≠ active/matched → ROLLBACK, 409 CHAT_ROOM_CLOSED   -- (3)
  SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE room_id = :room   -- (4) uq_chat_messages_room_seq 인덱스
  INSERT INTO chat_messages (id, room_id, sender_id, seq, client_message_id, body)
  VALUES (…) RETURNING created_at                                      -- (5)
COMMIT                                                                  -- (6)
```

- `IntegrityError` 분류: `uq_chat_messages_client_id`(방어용 — (1) 잠금으로 같은 방 동시 전송은 직렬화되므로 정상 경로에서는 (2)가 처리) → rollback 후 기존 메시지를 다시 읽어 200. `uq_chat_messages_room_seq` → 503(불변식 위반). 그 외 503.
- 메시지 본문은 **어떤 로그에도 남기지 않는다**. `log_database_failure` 는 작업명·SQLSTATE만 기록한다(기존 동작).

### 5.4 시나리오와 기대 결과


| #   | 시나리오                                                 | 기대                                                                                                     |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| S1  | 지원 3건 중 B 확정                                         | 200, B `accepted`, A·C `closed`(`decided_at` 동일 트랜잭션 시각), 요청 `matched`, `closedApplicationCount=2`     |
| S2  | 같은 B를 두 번(순차·동시) 확정                                  | 두 번 모두 200, 같은 본문. DB 변경은 1회                                                                           |
| S3  | A와 B를 동시에 확정                                         | 정확히 하나만 200, 다른 하나 409 `REQUEST_ALREADY_MATCHED`. accepted 1건                                          |
| S4  | 매칭과 N명의 신규 지원이 동시에                                   | 모든 지원 응답은 201 또는 409 `REQUEST_NOT_OPEN`. 끝난 뒤 그 요청에 `pending` 0건, 201 받은 지원은 모두 `closed` 또는 `accepted` |
| S5  | 마감 대상 방에 메시지 전송과 매칭이 경합                              | 전송이 먼저 잠그면 201 후 마감, 매칭이 먼저면 409 `CHAT_ROOM_CLOSED` 0행. 그 외 결과 없음                                      |
| S6  | 같은 방에서 구매자·판매자가 동시에 K건씩 전송                           | 2K×201, `seq` 1..2K 연속·유일                                                                              |
| S7  | 전송이 진행되는 동안 폴링 반복                                    | 폴링 결과를 이어 붙이면 모든 메시지가 정확히 한 번, `seq` 오름차순                                                              |
| S8  | 마감 후 판매자가 같은 `clientMessageId` 로 재전송(최초 전송은 마감 전 성공) | 200 기존 메시지                                                                                             |


---

## 6. API 계약

공통: JSON camelCase(`RequestSchema`, 입력 `extra="forbid"`), 모든 응답 `Cache-Control: no-store`, 오류 본문 `{"error": {"code","message","fields"}}`. 변경 요청은 `require_auth_post_request`(Origin 허용 목록 + `X-Requested-With: gamja-market` + `application/json`), 인증은 `get_current_user`.

### 6.1 `POST /api/requests/{requestId}/match` — 판매자 확정

요청 본문:

```json
{ "applicationId": "uuid" }
```


| 필드              | 규칙                   |
| --------------- | -------------------- |
| `applicationId` | UUID 필수. 그 외 필드는 422 |


성공 **200** (최초·멱등 동일):

```json
{
  "request": { "id": "uuid", "status": "matched" },
  "acceptedApplicationId": "uuid",
  "chatRoomId": "uuid",
  "closedApplicationCount": 2
}
```

오류 판정 순서: 403 `INVALID_ORIGIN` / 415 → 401 `UNAUTHENTICATED` → 422 `VALIDATION_ERROR`(경로 UUID·본문) → 404 `NOT_FOUND`(요청 없음) → 403 `NOT_REQUEST_OWNER` → 404 `NOT_FOUND`(그 요청의 지원이 아님) → 200 멱등 / 409 `REQUEST_ALREADY_MATCHED` / 409 `REQUEST_CLOSED` → 503 `SERVICE_UNAVAILABLE`.

### 6.2 `GET /api/chat-rooms/{roomId}/messages` — 폴링

쿼리:


| 이름         | 규칙                                                                       |
| ---------- | ------------------------------------------------------------------------ |
| `afterSeq` | 선택. 정수 0 ≤ x ≤ 2,147,483,647. 있으면 `seq > afterSeq` 를 오름차순으로 최대 `limit` 건 |
| `limit`    | 선택. 1\~100. 생략 시 `afterSeq` 없음(첫 로드)은 100, `afterSeq` 있음(폴링)은 50 |


`afterSeq` 가 없으면(첫 로드) **최근** `limit` 건을 오름차순으로 돌려준다.

성공 **200**:

```json
{
  "room": {
    "id": "uuid",
    "chatStatus": "active",
    "canSend": true,
    "applicationStatus": "pending",
    "requestStatus": "open"
  },
  "items": [
    {
      "id": "uuid",
      "seq": 12,
      "senderRole": "seller",
      "isMine": false,
      "body": "직거래 가능하신가요?",
      "clientMessageId": "uuid",
      "createdAt": "2026-10-07T10:00:00.000000Z"
    }
  ],
  "latestSeq": 12,
  "hasMore": false,
  "hasOlder": false
}
```

- `latestSeq`: 방 전체의 최대 `seq`(메시지 없으면 0).
- `hasMore`: `afterSeq` 모드에서 `limit` 를 넘는 새 메시지가 더 있음 → 클라이언트는 기다리지 않고 즉시 다시 조회.
- `hasOlder`: 첫 로드 모드에서 반환 범위보다 오래된 메시지가 있음(이 단계 UI는 안내 문구만, 14장).
- `senderRole` 은 `buyer`/`seller`. 발신자 이메일·user id는 넣지 않는다(이미 방 메타데이터에 마스킹 이메일이 있다).
- 오류: 401, 404 `NOT_FOUND`(없는 방·비참여자, 본문 동일), 422(`roomId`·`afterSeq`·`limit` 형식), 503.
- 읽기 전용: 잠금 없음, 쿼리 2회 이내(참여자·방 상태 조인 1회 + 메시지 1회).

### 6.3 `POST /api/chat-rooms/{roomId}/messages` — 전송

```json
{ "clientMessageId": "uuid", "body": "내일 저녁 7시 강남역 어떠세요?" }
```


| 필드                | 규칙                                              |
| ----------------- | ----------------------------------------------- |
| `clientMessageId` | UUID 필수                                         |
| `body`            | `StrictStr`, trim 후 1\~1000자(줄바꿈 허용). 공백만이면 422 |
| 그 외               | `seq`, `senderId`, `roomId` 등 모든 추가 필드 422      |


- 성공 **201** `{ "message": MessageView }`(6.2 `items[]` 와 같은 형태, `isMine: true`).
- 멱등 재전송 **200** `{ "message": 기존 MessageView }`.
- 오류 순서: 403 `INVALID_ORIGIN` / 415 → 401 → 422 → 404 `NOT_FOUND` → (멱등 200) → 409 `CHAT_ROOM_CLOSED` → 503.

### 6.4 `GET /api/chat-rooms` — 내 채팅 목록

쿼리 `limit`(1~50, 기본 50). 성공 **200**:

```json
{
  "items": [
    {
      "id": "uuid",
      "viewerRole": "buyer",
      "chatStatus": "active",
      "request": { "id": "uuid", "title": "아이패드 프로를 구합니다", "status": "open" },
      "counterpart": { "id": "uuid", "maskedEmail": "se***@example.com" },
      "lastMessage": { "body": "앞 100자까지…", "senderRole": "seller", "createdAt": "…" },
      "lastActivityAt": "…"
    }
  ],
  "hasMore": false
}
```

- 범위: `seller_applications.buyer_id = viewer OR seller_id = viewer` 인 방만. 다른 사람의 방은 어떤 조건에서도 포함되지 않는다.
- 정렬: `lastActivityAt DESC, id DESC`, `lastActivityAt = COALESCE(마지막 메시지 created_at, 방 created_at)`. `lastMessage` 는 메시지가 없으면 `null`, `body` 는 최대 100자로 자른다.
- 오류: 401, 422, 503. 라우트 `GET ""`(빈 경로)를 `chat_rooms_router` 에 둔다. `GET /{room_id}` 와 충돌하지 않는다.

### 6.5 기존 엔드포인트 변경 (필드 추가만)


| 엔드포인트                                         | 변경                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /api/requests/{id}/applications`    | `ApplicationView` 에 `status: "pending" | "accepted" | "closed"` 추가. 범위 규칙(owner 전체 / applicant 본인 / 나머지 `[]`)과 `applicantCount`(모든 상태 포함 총 지원 수) 유지 |
| `GET /api/chat-rooms/{roomId}`                | `ChatRoomView` 에 `applicationStatus`, `chatStatus`, `canSend` 추가. `request.status` 는 기존대로                                                           |
| `GET /api/requests`, `GET /api/requests/{id}` | 필드 변경 없음. 매칭 후 `status: "matched"`, `updatedAt` 은 매칭 시각으로 바뀐다(05의 “`updatedAt == createdAt`”은 미변경 요청에만 해당)                                          |
| `POST /api/requests/{id}/applications`        | 동작 변경 없음. 매칭된 요청은 기존 규칙대로 409 `REQUEST_NOT_OPEN`                                                                                                    |
| 사진 API 전체                                     | 변경 없음(12장)                                                                                                                                          |


### 6.6 새 오류 code

`backend/app/api/errors.py` `ERROR_MESSAGES`, `frontend/src/types/api.ts` `ApiErrorCode`, `frontend/src/lib/api/http.ts` `KNOWN_ERROR_CODES` 세 곳에 함께 추가한다.


| code                      | HTTP | message                      |
| ------------------------- | ---- | ---------------------------- |
| `NOT_REQUEST_OWNER`       | 403  | `구매요청 작성자만 판매자를 확정할 수 있습니다.` |
| `REQUEST_ALREADY_MATCHED` | 409  | `이미 다른 판매자와 매칭된 구매요청입니다.`    |
| `REQUEST_CLOSED`          | 409  | `마감된 구매요청입니다.`               |
| `CHAT_ROOM_CLOSED`        | 409  | `마감된 채팅방에는 메시지를 보낼 수 없습니다.`  |


### 6.7 422 필드 메시지 (`main.py` `validation_error_handler`)

경로 분기를 다음 순서로 확장한다(먼저 맞는 것 사용).

1. `^/api/requests/[^/]+/applications$` → 기존 지원 맵(변경 없음).
2. `^/api/requests/[^/]+/match$` → `{"applicationId": "확정할 지원을 선택해 주세요."}`
3. `^/api/chat-rooms/[^/]+/messages$` → `{"body": "메시지는 1자 이상 1000자 이하로 입력해 주세요.", "clientMessageId": "입력값을 확인해 주세요.", "afterSeq": "입력값을 확인해 주세요.", "limit": "입력값을 확인해 주세요."}`
4. `^/api/chat-rooms` 그 밖 → `{"limit": "입력값을 확인해 주세요."}` (현재는 auth 맵으로 떨어지는데, auth 필드명은 이 경로에 존재하지 않으므로 결과는 같다)
5. `/api/requests` → 기존 요청 맵, 그 외 → 기존 auth 맵.

### 6.8 권한 매트릭스


| 행위             | 익명             | 회원(비참여)                 | 구매자(작성자) | 해당 판매자                      | 같은 요청의 다른 판매자 |
| -------------- | -------------- | ----------------------- | -------- | --------------------------- | ------------- |
| 매칭 POST        | 401            | 403 NOT\_REQUEST\_OWNER | 200/409  | 403                         | 403           |
| 메시지 GET        | 401            | 404                     | 200      | 200                         | 404           |
| 메시지 POST       | 401            | 404                     | 201/409  | 201/409                     | 404           |
| 채팅 목록          | 401            | 200(자기 방만, 보통 `[]`)     | 200 자기 방 | 200 자기 방                    | 200 자기 방      |
| 지원 `status` 열람 | 없음             | 없음                      | 전체 지원    | 본인 지원                       | 본인 지원         |
| “누가 매칭됐는지”     | 요청 `matched` 만 | 요청 `matched` 만          | 알 수 있음   | 본인이 `accepted`/`closed` 인지만 | 본인 `closed` 만 |


---

## 7. 백엔드 레이어


| #   | 파일                                                        | 내용                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `migrations/versions/0005_chat_messages_matching.py` (신규) | 9장                                                                                                                                                                                                                                                                                              |
| L2  | `app/db/models.py`                                        | 4.3                                                                                                                                                                                                                                                                                             |
| L3  | `app/schemas/applications.py`                             | `ApplicationStatus = Literal["pending","accepted","closed"]`, `ChatStatus = Literal["active","matched","closed"]`. `ApplicationView.status`, `ChatRoomView.application_status/chat_status/can_send` 추가. `MatchCreate(application_id: UUID)`, `MatchRequestSummary(id, status)`, `MatchResponse` |
| L4  | `app/schemas/chat.py` (신규)                                | `MessageCreate(client_message_id: UUID, body: StrictStr 1~1000, trim)`, `MessageView`, `MessageRoomState`, `MessageListResponse`, `MessageEnvelope(message)`, `ChatRoomListItem`, `ChatRoomListResponse`, `MessageListParams(after_seq: int|None ge=0 le=2147483647, limit: int 1~100 = 50)`    |
| L5  | `app/repositories/applications.py`                        | `lock_request_for_match`(FOR NO KEY UPDATE), `lock_application_in_request`(FOR UPDATE), `accept_application`, `close_other_pending`(RETURNING id), `count_closed`. `list_for_request` 는 그대로(엔티티에 `status` 포함)                                                                                   |
| L6  | `app/repositories/chat_rooms.py`                          | `lock_for_send`(5.3 (1)), `get_state_for_participant`(잠금 없는 같은 조인), `list_for_user(viewer_id, limit)`. `get_for_participant` 는 시그니처 유지                                                                                                                                                          |
| L7  | `app/repositories/chat_messages.py` (신규)                  | `find_by_client_id`, `next_seq`, `insert_message`, `list_after(room_id, after_seq, limit+1)`, `list_latest(room_id, limit+1)`, `max_seq`                                                                                                                                                        |
| L8  | `app/services/matching.py` (신규)                           | `confirm_match` (5.1). 예외 `NotRequestOwner`, `RequestAlreadyMatched`, `RequestClosed`, `ApplicationNotFound`. `RequestNotFound` 는 `services/requests.py` 것을 재사용                                                                                                                                 |
| L9  | `app/services/chat.py` (신규)                               | `derive_chat_status`, `send_message`(5.3), `list_messages`, `list_rooms`. 예외 `ChatRoomNotFound`(applications 서비스 것 재사용), `ChatRoomClosed`. `send_message` 는 `(MessageView, created: bool)` 반환 → 라우터가 201/200 결정                                                                                 |
| L10 | `app/services/applications.py`                            | `_application_data` 에 `status`, `_room_data` 에 상태 3필드 추가(`derive_chat_status` 사용). 지원 생성 응답은 `pending`/`active`/`true`                                                                                                                                                                          |
| L11 | `app/api/applications.py`                                 | `POST /{request_id}/match` 추가. `chat_rooms_router` 에 `GET ""`, `GET /{room_id}/messages`, `POST /{room_id}/messages` 추가(POST에 `require_auth_post_request`)                                                                                                                                      |
| L12 | `app/main.py`                                             | 6.7 분기만. 라우터 include 변경 없음(기존 `chat_rooms_router` 에 추가하므로)                                                                                                                                                                                                                                      |
| L13 | `app/api/errors.py`                                       | 6.6                                                                                                                                                                                                                                                                                             |


---

## 8. 폴링 클라이언트 계약


| #   | 규칙                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | 첫 데이터는 SSR(`/chats/[roomId]/page.tsx`)에서 `getChatRoom` 과 `listMessages(roomId)`(afterSeq 없음, limit 100)를 병렬로 받아 클라이언트 컴포넌트에 전달한다. 메시지 SSR 실패는 페이지를 깨지 않고 클라이언트가 첫 폴링으로 다시 시도한다 |
| P2  | `lastSeq` 초기값 = SSR 결과의 `latestSeq`(실패 시 `undefined` → 첫 폴링은 afterSeq 없이)                                                                                                      |
| P3  | 폴링은 이전 요청이 끝난 뒤 `setTimeout(3000)` 으로 다음을 예약한다. `setInterval` 금지                                                                                                               |
| P4  | `hasMore = true` 면 지연 없이 바로 다음 조회                                                                                                                                              |
| P5  | `document.visibilityState === 'hidden'` 이면 예약을 취소한다. `visible` 로 돌아오면 즉시 1회 조회 후 주기 재개                                                                                         |
| P6  | 오류 백오프: `SERVICE_UNAVAILABLE`/`NETWORK_ERROR`/`INTERNAL_ERROR` 는 6s → 12s → 24s → 30s(상한), 성공 시 3s로 복귀. 연속 실패 2회부터 “연결이 불안정해요. 자동으로 다시 시도합니다.” 안내(`role="status"`)             |
| P7  | `UNAUTHENTICATED` → 폴링 중지, `/login?next=/chats/{roomId}` 로 이동                                                                                                                  |
| P8  | `NOT_FOUND` → 폴링 중지, “채팅방을 볼 수 없어요.” 표시, 입력 비활성                                                                                                                                |
| P9  | 언마운트·이동 시 `AbortController.abort()` 와 타이머 정리. abort로 인한 오류는 무시                                                                                                                 |
| P10 | 병합: 메시지는 `id` 기준 Map, 표시 순서는 `seq` 오름차순. `lastSeq` 는 **폴링 결과의 최대 seq로만** 전진(D13)                                                                                               |
| P11 | 매 응답의 `room` 으로 `chatStatus`/`canSend` 를 갱신한다. `active → matched/closed` 로 바뀌면 상단 배너와 입력 상태가 즉시 바뀐다                                                                            |
| P12 | 새 메시지가 오면 사용자가 바닥 근처(120px 이내)일 때만 자동 스크롤. 아니면 “새 메시지 ↓” 버튼                                                                                                                    |


전송(낙관적 표시):


| #   | 규칙                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| P13 | 전송 시 `crypto.randomUUID()` 로 `clientMessageId` 를 만들고, 목록 끝에 “전송 중” 말풍선을 `clientMessageId` 키로 붙인다                        |
| P14 | 201/200 → 그 말풍선을 서버 메시지로 교체(`id` 키). 이후 폴링이 같은 `id` 를 다시 가져오면 중복 없이 합쳐진다. `lastSeq` 는 바꾸지 않는다                           |
| P15 | 실패(`NETWORK_ERROR`/503) → 말풍선 “전송 실패 · 다시 시도”. 다시 시도는 **같은** `clientMessageId` 로 보낸다                                    |
| P16 | `CHAT_ROOM_CLOSED` → 말풍선 제거, 입력 비활성, 마감 배너 표시. `VALIDATION_ERROR` → 입력 아래 `fields.body` 문구                              |
| P17 | Enter 전송, Shift+Enter 줄바꿈, IME 조합 중(`isComposing`) Enter는 전송하지 않음. trim 후 0자면 전송 버튼 비활성. `maxLength=1000`, `n/1000` 카운터 |


---

## 9. 마이그레이션 `0005_chat_matching`

### 9.1 revision

- 파일 `backend/migrations/versions/0005_chat_messages_matching.py`, `revision = "0005_chat_matching"`(18자 ≤ 32), `down_revision = "0004_request_photos"`, `branch_labels = None`, `depends_on = None`.
- 단일 head 유지. 다른 형제 브랜치가 `0005*` 를 만들면 나중에 병합하는 쪽이 `down_revision` 을 develop head로 다시 잇는다(06 8.4·07의 re-parent 규칙). 이 문서는 id `0005_chat_matching` 과 위 파일명을 고정한다.

### 9.2 upgrade (멱등 additive, `0004` 스타일)

순서대로 `op.execute(sa.text(...))`:

1. `ALTER TABLE app_private.seller_applications ADD COLUMN IF NOT EXISTS status varchar(10) NOT NULL DEFAULT 'pending'`
2. `ALTER TABLE app_private.seller_applications ADD COLUMN IF NOT EXISTS decided_at timestamptz NULL`
3. `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_seller_applications_status') THEN ALTER TABLE … ADD CONSTRAINT ck_seller_applications_status CHECK (…); END IF; END $$` — `ck_seller_applications_decided_at` 도 같은 방식
4. `CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_applications_one_accepted ON app_private.seller_applications (request_id) WHERE status = 'accepted'`
5. `CREATE TABLE IF NOT EXISTS app_private.chat_messages (…4.2의 컬럼과 명명된 제약 전부…)`
6. `CREATE INDEX IF NOT EXISTS ix_chat_messages_sender_id ON app_private.chat_messages (sender_id)`

금지: 기존 컬럼 `ALTER COLUMN`/`DROP`/`RENAME`, 기존 제약 삭제, 데이터 `UPDATE`/`DELETE`(backfill 없음), `alembic_version` 직접 쓰기.

### 9.3 downgrade

`DROP TABLE IF EXISTS app_private.chat_messages` → `DROP INDEX IF EXISTS …one_accepted` → 제약 2개 `DROP CONSTRAINT IF EXISTS` → 컬럼 2개 `DROP COLUMN IF EXISTS`. **정의만 하고 공유 DB에서는 실행하지 않는다.** 검증은 오프라인 SQL(`sql=True`)로만 한다.

### 9.4 적용 경로

- 로컬: pytest 세션 fixture가 `_explicit_migration_target` 으로 `0005_chat_matching` 까지 `command.upgrade` (13.2). 로컬 개발 서버 단독 기동 시에는 `MIGRATION_DATABASE_URL` 을 로컬 URL로 지정한 `uv run alembic upgrade 0005_chat_matching` 만 허용(명시 target, `head` 아님).
- 운영 Supabase: `pr-merge` 스킬 절차로 배포 전에 적용. 테스트·개발 서버가 운영 DB에 DDL을 적용하지 않는다(conftest 가드 유지).
- 잠금 영향: `ADD COLUMN`/`ADD CONSTRAINT` 는 `seller_applications` 에 짧은 ACCESS EXCLUSIVE, CHECK 검증은 전체 스캔(행 수가 작아 무시 가능).

---

## 10. 프론트엔드

### 10.1 타입 (`frontend/src/types/application.ts`, 신규 `frontend/src/types/chat.ts`)

- `ApplicationStatus = 'pending' | 'accepted' | 'closed'`, `Application.status: ApplicationStatus` (필수).
- `ChatStatus = 'active' | 'matched' | 'closed'`, `ChatRoom` 에 `applicationStatus`, `chatStatus`, `canSend` 추가.
- `MatchResult { request: { id; status: 'matched' }; acceptedApplicationId; chatRoomId; closedApplicationCount }`.
- `chat.ts`: `ChatMessage { id; seq; senderRole: 'buyer'|'seller'; isMine; body; clientMessageId; createdAt }`, `MessageRoomState`, `MessageList { room; items; latestSeq; hasMore; hasOlder }`, `ChatRoomListItem`, `ChatRoomList`.

### 10.2 API 클라이언트


| 함수                                                                        | 위치                        | 계약                                                                                         |
| ------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `confirmMatch(requestId, applicationId, signal?)`                         | `lib/api/applications.ts` | `POST /api/requests/{id}/match`, `postInit`, 필드 키 `['applicationId']`, 409 추정값 보정(F-5)     |
| `listMessages(roomId, { afterSeq?, limit?, signal?, baseUrl?, cookie? })` | `lib/api/chat.ts` (신규)    | `GET /api/chat-rooms/{id}/messages`, 쿼리는 값이 있을 때만                                          |
| `sendMessage(roomId, { clientMessageId, body }, signal?)`                 | 〃                         | `POST …/messages`, 201·200 모두 성공으로 `{ message, created: status === 201 }`                  |
| `listChatRooms({ baseUrl?, cookie? })`                                    | 〃                         | `GET /api/chat-rooms`                                                                      |
| 기존 파서                                                                     | `lib/api/applications.ts` | `parseApplication` 이 `status`, `parseChatRoom` 이 3필드를 검사·복사. 모르는 enum 값 → `INTERNAL_ERROR` |


모든 파서는 기존 방식대로 타입 가드 실패 시 `INTERNAL_ERROR` 를 던진다.

### 10.3 `/chats/[roomId]`

- `page.tsx`: 기존 오류 분기 유지 + `listMessages` 병렬 SSR(P1).
- `ChatRoomView`(서버 호환 컴포넌트): 기존 헤더·참여자·제시가 카드는 유지하고, 하단 자리표시를 다음으로 교체한다.
  - 상태 배너: `matched` → “매칭이 확정된 채팅방이에요. 거래 일정을 이야기해 보세요.” / `closed` → “다른 판매자와 매칭되어 마감된 채팅방이에요. 이전 대화만 볼 수 있어요.”(구매자 시점은 “이 지원은 마감되었어요.”)
  - `ConfirmMatchButton`(구매자 + `chatStatus === 'active'` 일 때만): 10.4.
  - `ChatMessagePanel`(`'use client'`): 메시지 목록(`role="log"`, `aria-live="polite"`), 내 메시지 오른쪽/상대 왼쪽, 본문 `whitespace-pre-wrap`(React 텍스트 렌더링 — HTML 삽입 금지), 시각 `formatDateTime`. `hasOlder` 면 목록 상단에 “이전 메시지 일부는 표시되지 않아요.” 입력 영역은 `canSend` 가 false면 비활성 + 이유 문구.
- 모바일: 입력 영역은 하단 고정, 목록은 `max-h-[60vh]` 스크롤.

### 10.4 확정 UX (`features/matching/components/ConfirmMatchButton.tsx`)

- 1단계 버튼 “이 판매자로 확정”. 누르면 같은 자리에 확인 패널: “확정하면 다른 지원 {pendingOthers}건은 자동으로 마감되고 되돌릴 수 없어요.” + “확정” / “취소”. (채팅방에서는 `pendingOthers` 를 모르므로 “다른 지원은 자동으로 마감되고 되돌릴 수 없어요.”)
- 진행 중 버튼 비활성(중복 클릭 방지, 서버 멱등이 2차 방어).
- 성공 → `router.refresh()`. 409 `REQUEST_ALREADY_MATCHED`/`REQUEST_CLOSED` → 서버 message 표시 후 `router.refresh()`. 403/404 → message 표시. 503/네트워크 → “잠시 후 다시 시도해 주세요.” 유지.

### 10.5 `ApplicantList` (owner·applicant 보기)

- 각 카드에 지원 상태 배지: `pending` “협의 중”, `accepted` “확정”, `closed` “마감”.
- owner + 요청 `open` + 지원 `pending` 인 카드에만 `ConfirmMatchButton`(`pendingOthers = pending 수 - 1`). 이를 위해 `ApplicantList` 에 `requestStatus` prop을 추가한다.
- 요청 `matched` 면 확정 카드를 목록 맨 위에 강조 표시(정렬은 서버 순서 유지 + 클라이언트에서 accepted만 앞으로).
- member/anonymous 화면은 **변경 없음**(🔒 안내, 상태·매칭 상대 비노출).

### 10.6 `ApplyPanel` (applicant)


| 지원 `status` | 문구                              | 링크       |
| ----------- | ------------------------------- | -------- |
| `pending`   | “지원 완료 · 채팅방에서 거래 조건을 협의해 보세요.” | 채팅방 열기   |
| `accepted`  | “구매자가 회원님을 판매자로 확정했어요!”         | 채팅방 열기   |
| `closed`    | “다른 판매자와 매칭되어 지원이 마감되었어요.”      | 대화 기록 보기 |


owner·member·anonymous 분기는 변경 없음(member + `matched` 는 기존 “모집이 마감된 요청입니다” 비활성 버튼).

### 10.7 `/chats` 목록과 헤더

- `app/chats/page.tsx`(신규, `force-dynamic`): SSR `listChatRooms`. 401 → `/login?next=/chats`. 빈 목록 → `EmptyState`(“아직 참여 중인 채팅이 없어요.”). 항목: 요청 제목, 요청 `Badge`, 상대 마스킹 이메일, 내 역할(구매/판매), `chatStatus` 배지, 마지막 메시지 미리보기와 상대 시간. 목록 자체는 폴링하지 않는다.
- `HeaderAuth`: 로그인 상태에서 “채팅” 링크(`/chats`) 추가. 비로그인 링크는 변경 없음.

### 10.8 기존 테스트의 의도된 변경


| 테스트                                                                                                  | 변경                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ChatRoomView.test.tsx`                                                                              | “textbox·보내기 없음” 단정을 “`canSend` 면 textbox와 ‘보내기’ 있음 / `closed` 면 비활성” 으로 교체. 참여자·제시가 단정은 유지 |
| `applicationsApi.test.ts`, `ApplicantList.test.tsx`, `ApplyPanel.test.tsx`, `RequestDetail.test.tsx` | 픽스처에 `status`, 방 상태 3필드 추가. 기존 단정의 의미는 유지                                                   |
| 백엔드 `test_applications.py` 중 응답 키 집합을 정확히 비교하는 단정                                                    | 새 필드를 기대 키에 추가. 검증하는 계약(마스킹, 범위)은 유지                                                        |


---

## 11. 오류·엣지 동작 요약


| 상황                      | 서버                         | 화면                      |
| ----------------------- | -------------------------- | ----------------------- |
| 폴링 중 세션 만료              | 401 + 쿠키 만료(기존 핸들러)        | 로그인으로 이동(P7)            |
| 폴링 중 DB 장애              | 503                        | 백오프 + 안내(P6), 입력은 유지    |
| 전송 중 매칭으로 마감            | 409 `CHAT_ROOM_CLOSED`     | 마감 배너, 입력 비활성(P16)      |
| 응답 유실 후 재전송             | 200 기존 메시지                 | 중복 말풍선 없음(P14·P15)      |
| 구매자가 두 탭에서 서로 다른 판매자 확정 | 하나 200, 하나 409             | 409 탭은 메시지 후 새로고침       |
| 매칭 직후 다른 판매자가 지원        | 409 `REQUEST_NOT_OPEN`(기존) | 기존 ApplyForm 처리         |
| 공백만 있는 메시지              | 422 `fields.body`          | 클라이언트에서 미리 막음           |
| 1000자 초과                | 422                        | `maxLength` 로 미리 막음     |
| 없는/남의 방 메시지 조회          | 404(동일 본문)                 | “채팅방을 볼 수 없어요.”         |
| lock\_timeout 초과        | 503                        | 확정·전송 실패 안내, 재시도 가능(멱등) |


---

## 12. 호환성 — 보존하는 기존 계약


| #   | 계약                                                                                                             | 보존 방법                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| K1  | 인증(02/04): 쿠키 세션, `get_current_user`/`get_optional_user`, 401 시 쿠키 만료, POST의 Origin·`X-Requested-With`·JSON 검사 | 새 엔드포인트가 같은 의존성을 그대로 사용. 인증 코드 변경 없음                                                                              |
| K2  | 지원(06): 원자적 지원+방 생성, 중복 409, 본인 403, `FOR SHARE`, 목록 범위, 방 404 은닉, `applicantCount` 공개                         | 06 코드 경로 변경은 응답 필드 추가뿐. 06 테스트 전부 회귀 통과해야 함                                                                       |
| K3  | 사진(07/08): 업로드·연결·공개 `/api/request-photos/files/{id}.{ext}`, private 버킷, sweep                                 | 사진 테이블·라우트·스토리지 코드 변경 없음. `matched` 요청의 attached 사진도 기존처럼 공개 제공                                                   |
| K4  | 요청(05): 목록·상세·정렬·필터 응답 형태                                                                                      | 변경 없음. `status` 값으로 `matched` 가 나타날 뿐(기존 CHECK·타입에 이미 존재)                                                         |
| K5  | 응답 확장 방식                                                                                                       | 필드 **추가만**. 프론트 파서는 추가 필드를 무시하므로 구버전 프론트도 깨지지 않는다. 신버전 프론트는 새 필드를 필수로 요구하므로 **백엔드를 먼저 또는 동시에** 배포한다(Vercel 단일 배포) |
| K6  | 스키마                                                                                                            | additive만, 기존 행 기본값으로 유효, 06·07 제약 그대로                                                                            |


---

## 13. 비파괴 검증 계약

### 13.1 사전 확인 (읽기 전용)

1. `docker compose up -d`(볼륨 유지)로 DB 기동.
2. `SELECT version_num FROM alembic_version` → `0004_request_photos` 기대. 다르면 중단·escalation(stamp/downgrade 금지).
3. 결과를 `docs/verification/09-*.md` 에 기록(tester 소유).

### 13.2 conftest 변경 (tester)

- `_explicit_migration_target`: `"0005_chat_matching" in known` 이면 그것을 최우선 반환. 나머지 로직·가드·`head` 금지 유지.
- 새 fixture는 기존 `test_ns`, `ns_email`, `ns_title`, `rollback_connection`, `wait_until_blocked_by`, `owned_request_ids` 를 재사용한다. `_application_support.py` 의 `signup`/`create_request` 헬퍼를 재사용하고 `confirm_match`, `send_message`, `poll_messages` 헬퍼를 추가한다.

### 13.3 금지 사항

- `DELETE`, `TRUNCATE`, `DROP`, `alembic downgrade`/`stamp`, `alembic_version` 쓰기, 새 DB/스키마 생성 — 롤백 트랜잭션 안에서도 금지.
- 전역 개수 단정. 모든 단정은 테스트가 만든 요청·방 id 또는 `test_ns` 로 한정.
- 테스트 데이터가 아닌 행의 `UPDATE`. 원시 SQL 상태 변경은 **자기 테스트 요청**에만.
- 매칭된 테스트 요청·메시지는 삭제하지 않고 그대로 남긴다(되돌리기 API도 없음).
- 메시지 본문·DB URL을 로그·assert 메시지에 출력하지 않는다(테스트 본문 문자열은 `test_ns` 포함 더미).

### 13.4 RED 테스트 매트릭스

**백엔드 — `backend/tests/test_matching.py`**


| #   | 테스트                                                                                                               | 기대                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| M1  | `test_confirm_match_accepts_one_and_closes_others`                                                                | S1. DB 상태·`decided_at`·요청 `updated_at` 변경·응답 필드                                                                      |
| M2  | `test_confirm_match_is_idempotent_for_same_application`                                                           | 두 번째 200, 동일 본문, `decided_at` 불변                                                                                     |
| M3  | `test_confirm_other_application_after_match_conflicts`                                                            | 409 `REQUEST_ALREADY_MATCHED`, 상태 불변                                                                                 |
| M4  | `test_confirm_match_authorization`                                                                                | 익명 401, 비참여 회원·판매자 403 `NOT_REQUEST_OWNER`(존재하지 않는 applicationId를 넣어도 403 — 누출 없음), 다른 요청의 지원 id 404, 없는 요청 404      |
| M5  | `test_confirm_match_validation_and_origin`                                                                        | 본문 누락·형식 오류·추가 필드 422(`fields.applicationId`), Origin 누락 403, `text/plain` 415                                       |
| M6  | `test_confirm_match_on_closed_request`                                                                            | 자기 요청을 원시 SQL로 `closed` → 409 `REQUEST_CLOSED`                                                                       |
| M7  | `test_apply_after_match_rejected`                                                                                 | 409 `REQUEST_NOT_OPEN`(06 규칙 회귀)                                                                                     |
| M8  | `test_application_list_exposes_status_by_role`                                                                    | owner 전체 상태, applicant 본인 상태, member/anonymous `[]`·상태 문자열 부재                                                        |
| M9  | `test_db_rejects_second_accepted_and_bad_decided_at` (`rollback_connection`, 실패 INSERT/UPDATE만 — **자기 테스트 행 대상**) | `uq_seller_applications_one_accepted`, `ck_seller_applications_decided_at`, `ck_seller_applications_status` 위반 이름 일치 |
| M10 | `test_match_endpoints_no_store_and_503`                                                                           | `no-store`, `FailingSession` 503, 비밀 문자열 부재                                                                          |


**백엔드 — `backend/tests/test_chat_messages.py`**


| #    | 테스트                                              | 기대                                                                                                       |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| CH1  | `test_send_and_poll_messages`                    | 201, `seq` 1,2,3, `afterSeq` 조회, `isMine`/`senderRole` 시점별 정확, `latestSeq`                               |
| CH2  | `test_send_is_idempotent_by_client_message_id`   | 같은 id 재전송 200 동일 메시지, 행 1개. 다른 발신자가 같은 id → 별개 메시지 201                                                   |
| CH3  | `test_message_access_matrix`                     | 6.8 표 전부, 비참여 404 본문 == 없는 방 404 본문                                                                      |
| CH4  | `test_message_validation`                        | 공백만·0자·1001자·`StrictStr` 위반·추가 필드 422, 1자·1000자 201(trim 저장), `afterSeq=-1`/`limit=0`/`101` 422          |
| CH5  | `test_closed_room_is_read_only`                  | 매칭 후 마감 방: 판매자·구매자 전송 409 `CHAT_ROOM_CLOSED`, GET 200 `chatStatus=closed`, 기존 메시지 보존. accepted 방은 양쪽 201 |
| CH6  | `test_legacy_non_open_pending_room_is_read_only` | 원시 SQL로 `matched` 만 만든 자기 요청(accepted 없음) → `closed`/`canSend=false`                                     |
| CH7  | `test_initial_load_returns_latest_window`        | 메시지 105건 → 첫 로드 100건 오름차순 `seq` 6..105, `hasOlder=true`. `afterSeq=0&limit=50` → 50건 `hasMore=true`      |
| CH8  | `test_chat_room_list_scope_and_order`            | 사용자 X의 방만, 마지막 활동 내림차순, 미리보기 100자, 다른 사람 방 부재                                                            |
| CH9  | `test_chat_room_view_additive_fields`            | `GET /api/chat-rooms/{id}`, 지원 POST 응답의 새 필드 값                                                           |
| CH10 | `test_message_cascade_declared` (읽기 전용)          | `pg_constraint` 로 두 FK `confdeltype='c'`, 오프라인 SQL에 `ON DELETE CASCADE`                                  |
| CH11 | `test_message_endpoints_no_store_and_503`        | 3개 엔드포인트 `no-store`, 503, 로그에 본문 문자열 부재(`caplog`)                                                        |
| U1   | `test_derive_chat_status_table` (순수 함수)          | 4.4 표 전 조합                                                                                               |


**백엔드 — `backend/tests/test_matching_concurrency.py`** (06 10장의 헬퍼·제한 시간 규칙 그대로)


| #   | 테스트                                                            | 기대                                                                                                                         |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1  | `test_concurrent_confirm_different_applications_single_winner` | S3, 5회 반복(매번 새 요청)                                                                                                         |
| C2  | `test_concurrent_confirm_same_application_idempotent`          | S2, K=8 스레드 전부 200                                                                                                         |
| C3  | `test_match_racing_new_applications_leaves_no_pending`         | S4, N=16 지원 + 매칭 1 동시                                                                                                      |
| C4  | `test_apply_waits_for_match_then_rejected`                     | 제어 커넥션이 자기 요청에 `FOR NO KEY UPDATE`+`UPDATE status='matched'`(미커밋) → 지원 Lock 대기 관측 → COMMIT → 409, 0행                       |
| C5  | `test_send_waits_for_close_then_rejected`                      | 제어 커넥션이 자기 지원 행 `UPDATE status='closed', decided_at=now()`(미커밋) → 전송 Lock 대기 관측 → COMMIT → 409 `CHAT_ROOM_CLOSED`, 0행      |
| C6  | `test_match_waits_for_in_flight_send`                          | `lock_for_send` 반환 직후 훅(`acquired`/`release`)으로 정지 → 매칭 스레드 시작 → 매칭 Lock 대기 관측 → release → 전송 201, 매칭 200, 그 메시지는 마감 이전 커밋 |
| C7  | `test_concurrent_sends_have_contiguous_seq`                    | S6, K=10씩, I5·I6 검사                                                                                                        |
| C8  | `test_polling_never_skips_messages`                            | S7: 전송 스레드 4개 × 25건 진행 중 폴러가 `afterSeq` 반복 → 수집 결과 = DB의 1..100, 중복 0                                                      |
| C9  | `test_match_lock_timeout_returns_503`                          | `application_lock_timeout_ms=300`, 제어 커넥션이 요청 행 `FOR UPDATE` 유지 → 503, 상태 불변 → 해제 후 재시도 200                                |


**백엔드 — 마이그레이션 (`test_migration_guards.py` 또는 `test_chat_migration.py`)**


| #   | 테스트                                                  | 기대                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MG1 | `test_chat_schema_objects_exist`                     | 인스펙터: 새 컬럼·기본값, 4장 제약·인덱스 이름 전부, 부분 인덱스 조건                                                                                                                                                                                                  |
| MG2 | `test_revision_graph_single_head`                    | `0005_chat_matching` down = `0004_request_photos`, head 1개, id ≤ 32자                                                                                                                                                                        |
| MG3 | `test_offline_0005_sql_is_additive`                  | `0004_request_photos:0005_chat_matching` 오프라인 SQL에 `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS app_private.chat_messages` 포함, `DROP`·`TRUNCATE`·`DELETE FROM`·`ALTER COLUMN`·`RENAME`·`UPDATE` 부재. downgrade SQL은 0005 객체만 DROP |
| MG4 | `test_existing_applications_default_pending` (읽기 전용) | 이 테스트가 0005 이전 방식(원시 INSERT, status 미지정)으로 만든 행이 `pending`/`NULL`                                                                                                                                                                           |


**프론트엔드 — Vitest**


| #    | 파일                                              | 기대                                                                                                      |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| FE1  | `chatApi.test.ts`                               | 3개 함수의 URL·쿼리·헤더·`credentials`/`cache`, 201/200 구분, 파서 실패 `INTERNAL_ERROR`, 409 보정, 새 code 전달           |
| FE2  | `applicationsApi.test.ts`                       | `confirmMatch` 요청·응답, 파서의 `status`/방 상태 필드 필수                                                           |
| FE3  | `ChatMessagePanel.test.tsx` (fake timers)       | 3초 주기, 겹침 없음, `hasMore` 즉시 재조회, hidden 시 중지·visible 즉시 조회, 백오프 6/12/24/30, 401 이동, 404 중지, 언마운트 시 abort |
| FE4  | 〃                                               | 병합·정렬·중복 제거, 전송 응답이 `afterSeq` 를 전진시키지 않음(D13), 낙관적 말풍선 교체·실패·같은 id 재시도                                 |
| FE5  | 〃                                               | Enter/Shift+Enter/IME, 공백 비활성, 카운터, `canSend=false` 비활성과 배너, 상태 변경 반영                                   |
| FE6  | `ConfirmMatchButton.test.tsx`                   | 확인 2단계, 진행 중 비활성, 성공 `router.refresh`, 409·403·503 처리                                                   |
| FE7  | `ApplicantList.test.tsx`, `ApplyPanel.test.tsx` | 10.5·10.6 표                                                                                             |
| FE8  | `ChatRoomList.test.tsx`                         | 빈 상태, 항목 렌더, 마스킹 이메일만 표시                                                                                |
| FE9  | `HeaderAuth.test.tsx`                           | 로그인 시 “채팅” 링크                                                                                           |
| FE10 | `noMockData.test.ts`                            | 기존 규칙 유지(새 컴포넌트에 목업 데이터 없음)                                                                             |


### 13.5 UI 검증 (UI tester, 로컬 DB 데이터 보존)

계정 3개(구매자, 판매자 A·B, `test_ns` 표식 이메일)로 실제 서버를 띄워 확인하고 스크린샷과 결과를 `docs/verification/09-*.md` 에 남긴다. 생성한 데이터는 지우지 않는다.

1. A·B가 지원 → 두 방에서 구매자와 각각 메시지 교환, 3~5초 안에 상대 화면에 표시.
2. 탭 숨김 동안 네트워크 요청 없음(DevTools), 복귀 즉시 갱신.
3. 구매자가 B 방에서 확정 → B 방 “매칭 확정” 배너, A 방은 다음 폴링 안에 마감 배너·입력 비활성, 상세 페이지 상태 “매칭됨”, A의 ApplyPanel “마감” 문구.
4. 제3 계정으로 A 방 URL 접근 → 404 페이지. `/chats` 목록에 남의 방 없음.
5. 백엔드 중지 → 안내 표시와 백오프, 재기동 후 자동 복구.
6. 모바일 폭(375px)에서 입력 영역·목록 스크롤.

---

## 14. 한계 (명시)


| #   | 한계                                                           | 이유·후속                                                      |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| X1  | 폴링 1회 = 인증 조회 + PG 커넥션 1개(NullPool). 열린 채팅 탭 100개면 초당 약 33요청 | 커리큘럼 규모에서 허용. 탭 숨김 중지·백오프로 상한. 필요 시 이후 단계에서 풀링·Realtime 검토 |
| X2  | 이전 메시지는 최근 100건까지만 첫 로드                                      | `beforeSeq` 페이지네이션은 후속                                     |
| X3  | 읽음 표시·알림 없음                                                  | H6                                                         |
| X4  | 전송 속도 제한 없음                                                  | 참여자 2명 방이라 위험이 작다. 남용 대응은 후속                               |
| X5  | 매칭 취소 불가                                                     | D14                                                        |
| X6  | 발신자 참여자 여부는 DB가 아닌 서비스가 보장                                   | 트리거를 피함. I6 테스트로 고정                                        |


---

## 15. 사람 검토 항목 (권장 기본값)


| #   | 질문                | 권장 기본값                             |
| --- | ----------------- | ---------------------------------- |
| H1  | 폴링 주기             | 3초(커리큘럼 3\~5초 범위의 하한)              |
| H2  | 마감 방 열람           | 읽기 허용, 쓰기 금지                       |
| H3  | 확정 위치             | 채팅방(주) + 지원자 목록(보조) 둘 다            |
| H4  | 매칭 후 요청 상세의 공개 범위 | 요청 상태 `matched` 만 공개, 매칭 상대는 비공개   |
| H5  | 메시지 길이            | 1\~1000자                           |
| H6  | 읽음 표시·안 읽은 수      | 이 단계 제외                            |
| H7  | `/chats` 목록       | 포함(06이 6단계로 미룬 항목). 목록 자체는 폴링하지 않음 |
| H8  | 매칭 취소             | 이 단계 제외(불가역)                       |


---

## 16. 구현 순서

1. tester: 13.1 사전 확인 → 13.2 conftest target 추가 → 13.4 RED 작성(실패 확인).
2. backend: L1~L13, `uv run pytest`(로컬 DB, 데이터 보존) 전체 통과(06·07·08 회귀 포함).
3. frontend: 10장, `npm run lint`, `npm test` 통과.
4. UI tester: 13.5, `docs/verification/09-*.md` 기록.
5. PR: develop 대상, `pr-merge` 스킬로 운영 마이그레이션(0005) 적용 절차 검토.
