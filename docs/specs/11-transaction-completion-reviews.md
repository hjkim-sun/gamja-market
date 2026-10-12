# 11. 거래 완료 & 후기 — 구현 계약

> **상태: 사람 설계 검토 완료 — 2026-10-12 승인.** §15의 H1~H3·H5~H9는 권장 기본값대로 승인되었다. **H4는 “후기는 익명 사용자를 포함한 모두에게 공개”로 변경 승인**되어 문서 전체에 반영했다(반영 위치는 §15). RED 테스트·구현은 코디네이터의 별도 dispatch로 시작한다.
>
> 기준: GitHub 이슈 #19(“거래 완료 후 후기 작성할 수 있는 기능이 있었으면 좋겠습니다.”)와 `curriculum.md` **8단계**(“거래 완료 처리, 후기 작성 (캡스톤)”).
> 조사 대상: worktree `issue-19`(branch `hjkim-sun/issue-19`, HEAD `d25bf0d`, 2026-10-12). 문서 번호는 `01`~`10` 다음인 `11`이며 커리큘럼 단계 번호와 다르다.
> 선행 계약: [06 지원·채팅방](06-seller-applications-chat-rooms.md), [09 채팅·매칭](09-chat-messaging-and-matching.md), [10 하드닝](10-security-performance-hardening.md). 이 문서는 그 계약을 **확장**한다. 의도적으로 바꾸는 기존 동작은 §12에 모두 적었다.
> 설계자는 이 문서와 자기 작업 노트 외에 어떤 파일도 수정하지 않았고, DB에는 접근하지 않았다(조사 시점 docker 데몬 정지 — §13.1).

---

## 0. 한눈에 보기

| # | 항목 | 결정 |
| --- | --- | --- |
| 0.1 | 거래 완료 | 구매자(요청 작성자)가 `matched` 요청을 **1단계로 완료 처리**한다. `matched → completed`, 되돌릴 수 없다 |
| 0.2 | 기존 테이블 변경 | `purchase_requests`: 컬럼 `completed_at` 추가, `ck_purchase_requests_status` 에 `'completed'` 추가(허용값 확대), CHECK `ck_purchase_requests_completed_at` 추가 |
| 0.3 | 새 테이블 | `app_private.reviews` — 거래 1건당 최대 2건(구매자 → 판매자, 판매자 → 구매자) |
| 0.4 | 마이그레이션 | revision `0007_completion_reviews`(23자), `down_revision = "0006_security_perf_hardening"`. 멱등. 데이터 `UPDATE`/`DELETE` 없음. **downgrade 미지원**(DDL 전에 `RuntimeError`, §9.3). 완료 행이 생긴 뒤에는 0006 코드로 되돌릴 수 없다(§9.4) |
| 0.5 | 완료 후 채팅 | 확정 방은 **읽기 전용**이 된다(`chatStatus: "completed"`, `canSend: false`). 09 §1.1-4 “거래 완료 전까지 대화 가능”을 그대로 따른다 |
| 0.6 | 완료 ↔ 메시지 전송 직렬화 | 완료는 요청 행 `FOR NO KEY UPDATE` → 확정 지원 행 `FOR UPDATE`. 전송은 잠금 획득 **뒤에** 요청 status를 새 스냅샷으로 다시 읽는다. 완료 커밋 이후에 커밋되는 메시지는 없다 |
| 0.7 | 후기 | 평점 정수 1~5(필수) + 본문 trim 후 2~500자(필수). 작성자당 거래 1건에 1개, **수정·삭제 없음** |
| 0.8 | 멱등성 | 완료 재요청은 200(같은 본문). 후기는 `UNIQUE(request_id, reviewer_id)`; **같은 내용** 재전송은 200, 다른 내용은 409 `ALREADY_REVIEWED` |
| 0.9 | 권한 | 완료는 요청 작성자만(403 `COMPLETION_FORBIDDEN`). 후기 **읽기는 공개**(익명 포함, 선택 인증). 후기 **쓰기**는 그 거래의 구매자와 확정 판매자만 — 그 외 회원은 없는 요청과 **동일한 404** |
| 0.10 | 공개 범위 | 완료된 요청의 후기(작성자 역할·평점·본문·작성일)는 작성 즉시 **누구나** 본다(H4, 2026-10-12 승인). 작성자는 역할(`buyer`/`seller`)로만 표시하고 user id·이메일은 내보내지 않는다. 확정 판매자가 누구인지는 계속 비공개다. 프로필·평점 집계는 없다 |
| 0.11 | 새 API | `POST /api/requests/{id}/complete`, `GET /api/requests/{id}/reviews`(공개), `POST /api/requests/{id}/reviews`(참여자 전용) |
| 0.12 | 기존 API 변경 | **enum 값 추가만**: `status`/`requestStatus` 에 `completed`, `chatStatus` 에 `completed`. 필드 추가·삭제 없음 |
| 0.13 | 새 화면 요소 | “거래 완료” 버튼(채팅방·지원자 목록), 요청 상세의 **공개 후기 목록**, 채팅방의 후기 패널(작성 폼·내 후기·받은 후기), 상태 배지 “거래완료” |
| 0.14 | 테스트 DB | 로컬 공유 DB 그대로. DELETE/TRUNCATE/DROP/downgrade/stamp 금지, 완료·후기 테스트 데이터도 보존(§13) |

---

## 1. 목표와 범위

### 1.1 이 단계에서 하는 것

1. 구매자가 매칭이 확정된 자기 요청을 “거래 완료”로 처리한다.
2. 완료와 동시에 확정 채팅방은 읽기 전용이 된다(이전 대화는 계속 볼 수 있다).
3. 완료된 거래의 구매자와 확정 판매자는 **서로에 대해** 후기(평점 + 글)를 1개씩 쓴다.
4. 두 참여자는 채팅방 화면에서 내가 쓴 후기와 상대가 쓴 후기를 본다.
5. 공개 목록·상세에는 요청 상태가 “거래완료”로 표시된다.
6. 완료된 요청의 상세 화면에서 **누구나(익명 포함)** 그 거래의 후기를 본다. 작성자는 “구매자”/“판매자” 역할로만 표시된다.

### 1.2 하지 않는 것

| 기능 | 처리 |
| --- | --- |
| 판매자의 완료 처리, 양측 합의 완료(2단계) | 하지 않음(§15 H1). 구매자 단독 1단계 |
| 완료 취소, 매칭 취소 | 하지 않음. `completed` 는 종료 상태 |
| 후기 수정·삭제·신고·답글 | 하지 않음(§15 H5) |
| 후기 작성 기한 | 없음. 완료된 거래는 언제든 작성 가능 |
| 사용자 평점 집계(평균·개수) 노출, 프로필·받은 후기 목록 페이지 | 하지 않음(§15 H4 — 승인된 공개 범위는 요청 단위 후기까지다). 사용자 프로필 화면이 아직 없다. `reviews.reviewee_id` 인덱스로 후속 확장만 열어 둔다 |
| 후기 작성자의 신원(user id·이메일·마스킹 이메일) 공개, 확정 판매자 공개 | 하지 않음(§10). 공개 후기는 역할만 표시한다 |
| 후기 페이지네이션·검색, 홈 목록 카드의 후기·평점 표시 | 하지 않음. 요청당 최대 2건을 요청 상세에서만 보여 준다 |
| 상대가 쓰기 전까지 내 후기를 숨기는 블라인드 | 하지 않음(§15 H6) |
| 알림(완료·후기 도착), 후기 영역 폴링 | 하지 않음. 새로고침 시 반영 |
| 요청 수동 마감(`closed`) API | 하지 않음(09와 동일) |
| 사진 첨부 후기 | 하지 않음 |

### 1.3 가정 (명시)

| # | 가정 | 근거 |
| --- | --- | --- |
| A1 | “거래”는 **요청 1건 + 확정 지원 1건**이다. 별도 거래 테이블을 만들지 않는다 | `uq_seller_applications_one_accepted` 가 요청당 확정 지원 1건을 이미 보장한다(09 I1) |
| A2 | 완료 주체는 구매자다 | 구매자 중심 플랫폼(AGENTS.md)이고, 매칭 확정도 구매자만 한다(09 D5). 글 작성자가 완료를 누르는 구조와 같다 |
| A3 | 대금 결제·배송은 서비스 밖에서 일어난다. 완료는 구매자의 **선언**이며 서버가 검증하지 않는다 | 결제 기능이 없다 |
| A4 | 완료 후 채팅은 닫는다 | 09 §1.1-4가 “8단계 거래 완료 전까지”로 예고했다. 낮은 평점 후기 뒤의 채팅 보복도 막는다 |
| A5 | 후기는 **공개 기록**이다(2026-10-12 승인으로 초안의 ‘비공개’ 가정에서 변경). 작성자 신원은 역할로만 드러낸다 | 사람 검토 H4. 09 §15 H4의 “매칭 상대는 비공개”는 그대로 유지한다 — 공개 DTO에 user id·이메일을 넣지 않으므로 후기가 공개되어도 확정 판매자가 누구인지는 드러나지 않는다(§10) |
| A6 | 프론트·백엔드는 **함께 배포**된다 | 09 K5와 같다. 구버전 프론트 파서는 모르는 enum 값(`completed`)을 `INTERNAL_ERROR` 로 처리한다 |

---

## 2. 현재 코드 근거

### 2.1 백엔드

| # | 위치 | 관찰 | 이 설계의 결정 |
| --- | --- | --- | --- |
| B-1 | `backend/app/db/models.py:64` | `ck_purchase_requests_status` 는 `('open','matched','closed')` 만 허용 | `'completed'` 를 추가한다(§4.1). `closed`(마감)를 완료로 재사용하지 않는다 — 취소·마감과 완료를 구분할 수 없게 된다 |
| B-2 | `backend/app/db/models.py:92` | `status varchar(10)` | `completed` 는 9자라 타입 변경이 없다 |
| B-3 | `backend/app/repositories/applications.py:28-33` | `lock_request_for_match` = 요청 행 `FOR NO KEY UPDATE` | 완료가 그대로 재사용한다 |
| B-4 | `backend/app/repositories/chat_rooms.py:46-58` | `lock_for_send` 는 방 `FOR NO KEY UPDATE`, 지원 `FOR SHARE` 를 잡고 **요청 status는 잠금 없이 같은 문장에서 읽는다** | 잠금 대기 뒤에는 이 값이 낡을 수 있다. 전송 경로에 재조회 1문장을 추가한다(§5.2) |
| B-5 | `backend/app/services/chat.py:25-30` | `derive_chat_status("accepted", "completed")` 는 기본 분기로 `"closed"` 가 된다 | `"completed"` 를 명시적으로 반환한다. `closed` 배너 문구(“다른 판매자와 매칭되어…”)가 완료 방에 나오면 틀리다 |
| B-6 | `backend/app/services/matching.py:74-83` | 요청이 `matched`/`closed`/`open` 이 아니면 불변식 위반 로그 + 503 | `completed` 요청에 대한 매칭 시도를 409 `REQUEST_CLOSED` 로 명시 처리한다(§12 K3) |
| B-7 | `backend/app/services/applications.py:119` | `status != 'open'` → `REQUEST_NOT_OPEN` | 완료된 요청의 신규 지원은 이 규칙으로 409. 변경 없음 |
| B-8 | `backend/app/schemas/requests.py:12`, `schemas/chat.py:13,42,65`, `schemas/applications.py:63` | `RequestStatus`, `ChatStatus` Literal과 인라인 Literal 3곳 | 값 추가, 인라인 Literal은 공용 타입으로 통일(§7) |
| B-9 | `backend/app/main.py:105-116` | 422 필드 맵을 경로 정규식으로 고른다. `/api/requests/*` 는 요청 맵으로 떨어진다 | `/api/requests/*/reviews` 분기를 **일반 `/api/requests` 분기보다 앞에** 추가한다(§6.6) |
| B-10 | `backend/app/main.py:46,58` | `/api/requests` prefix 응답에 `no-store` | 새 경로가 모두 이 prefix 안이다. 미들웨어 변경 없음 |
| B-11 | `backend/app/api/errors.py:7-30` | 모르는 code는 `KeyError` | 새 code 4개 추가(§6.5) |
| B-12 | `backend/app/services/matching.py`, `services/chat.py` | `set_config('lock_timeout', …, true)`, 결과 유무 분기, 제약 이름 기반 `IntegrityError` 분류, 단일 commit, SQLAlchemy 오류 → 503 | 완료·후기 서비스가 같은 구조를 따른다 |
| B-13 | `backend/migrations/versions/0006_security_perf_hardening.py:10-11` | 현재 head `0006_security_perf_hardening`, `IF NOT EXISTS` 멱등 DDL | `0007` 을 그 위에 단일 head로 올린다(§9) |
| B-14 | `backend/tests/conftest.py:66-79` | `_explicit_migration_target` 이 최신 revision을 **명시**한다(현재 `0006…` 고정, `head` 금지) | `0007_completion_reviews` 를 최우선 후보로 추가한다(§13.2) |
| B-15 | `backend/tests/test_migration_0006.py:68-82` | 모델과 DB의 **인덱스 드리프트 0** 을 단정 | `Review` 모델의 인덱스·unique를 마이그레이션과 이름까지 일치시킨다(§4.3) |
| B-16 | `backend/tests/test_requests.py:23-30,652` | `EXPECTED_CHECKS <= 실제` (부분집합 단정) | 새 CHECK 추가로 깨지지 않는다 |
| B-17 | `backend/app/api/deps.py:121-136`, `api/applications.py:112-127` | `get_optional_user` 는 쿠키가 없거나 세션이 없거나 만료되면 `None` 을 돌려주고 쿠키를 건드리지 않는다(DB 오류만 503). 지원 목록 GET이 이 의존성으로 공개 읽기 + 조회자별 응답을 만든다 | 후기 GET이 같은 패턴을 쓴다(§6.2). 401은 없다 |

### 2.2 프론트엔드

| # | 위치 | 관찰 | 결정 |
| --- | --- | --- | --- |
| F-1 | `frontend/src/types/request.ts:1`, `types/application.ts:35` | `RequestStatus`, `ChatStatus` 유니온 | `'completed'` 추가 |
| F-2 | `frontend/src/lib/api/requests.ts:72`, `applications.ts:40,86`, `chat.ts:35,39` | enum 타입 가드가 파일마다 따로 있다. 모르는 값은 `INTERNAL_ERROR` | 5곳 모두 `completed` 를 받도록 고친다. 하나라도 빠지면 완료된 요청·방이 오류 화면이 된다 |
| F-3 | `frontend/src/components/ui/Badge.tsx:3-13`, `StatusBadges.tsx:17-27` | `Record<RequestStatus, …>`, `Record<ChatStatus, …>` | 유니온 확장 시 컴파일 오류로 누락이 드러난다. 라벨 추가(§11.3) |
| F-4 | `frontend/src/features/chat/components/ChatMessagePanel.tsx:321-323` | 구매자 + `active` 일 때 `ConfirmMatchButton` | 구매자 + `matched` 일 때 `CompleteTransactionButton` 을 같은 자리에 둔다 |
| F-5 | `ChatMessagePanel.tsx:238-240` | 전송 409 `CHAT_ROOM_CLOSED` 시 로컬 상태를 `closed` 로 고정 | 직전 상태가 `matched` 였으면 `completed` 로 둔다(§11.5) |
| F-6 | `ChatMessagePanel.tsx:126` | 폴링 응답의 `room` 으로 `chatStatus`/`canSend` 갱신 | 판매자의 열린 탭이 3초 안에 완료를 감지한다. 그때 `router.refresh()` 1회로 후기 패널을 띄운다 |
| F-7 | `frontend/src/features/matching/components/ConfirmMatchButton.tsx` | 2단계 확인, 진행 중 비활성, 성공 시 `router.refresh()` | 완료 버튼이 같은 패턴을 따른다 |
| F-8 | `frontend/src/features/requests/components/ApplicantList.tsx:31,92-99` | owner + `open` + `pending` 카드에 확정 버튼 | owner + `matched` + `accepted` 카드에 완료 버튼, `completed` 면 후기 링크 |
| F-9 | `frontend/src/features/applications/components/ApplyPanel.tsx:12-16` | 지원 상태별 문구 `Record<ApplicationStatus, …>` | `accepted` + 요청 `completed` 문구를 따로 둔다(§11.7) |
| F-10 | `frontend/src/lib/api/http.ts:53` | 본문 파싱 실패 시 409 → `EMAIL_ALREADY_EXISTS` 추정 | 새 클라이언트도 409 추정값을 `INTERNAL_ERROR` 로 보정한다 |
| F-11 | `frontend/src/app/requests/[id]/page.tsx:33-44,66-88`, `features/requests/components/RequestDetail.tsx:25-98` | 상세 페이지는 SSR로 요청과 지원 목록을 함께 읽고, 지원 목록 실패는 `{ ok: false }` 로 받아 페이지를 깨지 않는다. `RequestDetail` 은 `article` → `ApplicantList` → `ApplyPanel` 순서로 그린다 | 후기도 같은 방식으로 읽는다. 실패 시 후기 영역만 오류 + 재시도로 둔다(§11.9) |

---

## 3. 핵심 설계 결정

| # | 결정 | 이유 |
| --- | --- | --- |
| D1 | 완료를 `purchase_requests.status = 'completed'` + `completed_at` 으로 표현한다 | 요청 상태가 이미 화면·목록·채팅 상태의 기준이다. `completed_at` 만 추가하고 status를 `matched` 로 두면 모든 사용처가 두 컬럼을 함께 봐야 한다 |
| D2 | 지원 상태는 바꾸지 않는다(확정 지원은 `accepted` 유지) | `uq_seller_applications_one_accepted` 가 계속 거래 상대를 식별한다. enum 확대를 요청 쪽 한 곳으로 줄인다 |
| D3 | 완료는 **요청 행 `FOR NO KEY UPDATE` → 확정 지원 행 `FOR UPDATE` → 요청 UPDATE → 단일 commit** | 매칭과 같은 잠금 순서(요청 → 지원)라 교착이 없다. 지원 행 잠금이 전송의 `FOR SHARE` 와 충돌해 전송과 직렬화된다 |
| D4 | 전송 경로는 잠금 획득 뒤 요청 status를 **별도 문장으로 재조회**한다 | `lock_for_send` 의 조인이 읽은 요청 status는 문장 시작 스냅샷 값이다. 잠금 대기가 끝나도 잠그지 않은 테이블의 값은 갱신되지 않는다(§5.2) |
| D5 | 전송 문장에 `FOR SHARE OF p`(요청 행)를 넣는 방법은 **쓰지 않는다** | 한 문장 안의 행 잠금 순서가 보장되지 않아 전송(지원 → 요청)과 매칭(요청 → 지원)이 교착할 수 있다 |
| D6 | 같은 요청의 완료 재요청은 **멱등 200** | 더블클릭·재시도·두 탭에서 안전(09 D4와 같은 원칙) |
| D7 | 비작성자의 완료 시도는 확정 지원을 보기 전에 403 | 09 D5와 같다. 요청은 공개라 존재 은닉은 무의미하지만, 매칭 여부·상대는 비공개다 |
| D8 | 후기 대상(`reviewee`)과 역할은 **서버가 도출**한다. 클라이언트는 `rating`·`body` 만 보낸다 | 대상 위조를 구조적으로 막는다(`extra="forbid"` 로 다른 필드는 422) |
| D9 | 후기 유일성은 DB가 강제한다: `UNIQUE(request_id, reviewer_id)`, `UNIQUE(request_id, reviewer_role)` | 경쟁·서비스 버그가 있어도 중복 후기나 거래당 3건 이상이 저장될 수 없다 |
| D10 | 후기 작성은 요청 행을 잠그지 않는다 | `completed` 는 종료 상태라 읽은 뒤 바뀌지 않는다. 중복은 unique + `ON CONFLICT DO NOTHING` 이 처리한다 |
| D11 | 후기 재전송은 **내용이 같으면 200**, 다르면 409 | 응답을 못 받은 재시도는 성공으로 끝나고, 두 탭에서 다른 내용을 보낸 경우는 덮어쓰지 않는다 |
| D12 | 후기는 불변이다 | 상태 머신과 테스트 면적을 줄인다. 상대가 본 뒤 고치는 문제도 없다 |
| D13 | 후기 **조회는 공개**(선택 인증)다. 응답의 개인화 필드(`viewerRole`·`canWrite`·`mine`·`received`)는 인증된 참여자에게만 채운다. 후기 **작성**에서 비참여자는 없는 요청과 **동일한 404** | H4 승인. 익명·비참여 회원·마감된 지원 판매자의 GET 응답은 서로 같아 “이 사람이 거래 상대인지”를 응답으로 알 수 없다. 작성 404는 06 D9와 같은 원칙이다 |
| D14 | 기존 엔드포인트에는 **필드를 추가하지 않는다** | 05·06의 응답 키 단정 테스트를 건드리지 않는다. `completedAt` 은 새 엔드포인트에서만 준다 |
| D15 | 공개 후기 DTO는 `reviewerRole`·`rating`·`body`·`createdAt` **4개 필드뿐**이고, GET의 `items`·`mine`·`received` 가 모두 이 DTO를 쓴다 | 후기 id·user id·이메일(원문·마스킹)·대상 정보를 내보내지 않아 확정 판매자의 신원이 드러나지 않는다(09 H4 유지). 요청 단위로만 노출하므로 사용자별 모아 보기·집계가 생기지 않는다 |

---

## 4. DB 스키마 (revision `0007_completion_reviews`)

### 4.1 `app_private.purchase_requests` 변경

| 종류 | 이름 | 정의 |
| --- | --- | --- |
| 컬럼 추가 | `completed_at` | `timestamptz NULL` |
| CHECK 교체(확대) | `ck_purchase_requests_status` | `CHECK (status IN ('open', 'matched', 'closed', 'completed'))` |
| CHECK 추가 | `ck_purchase_requests_completed_at` | `CHECK ((status = 'completed') = (completed_at IS NOT NULL))` |

- 기존 행은 모두 `status ≠ 'completed'`, `completed_at IS NULL` 이라 두 CHECK를 만족한다. **backfill 없음.**
- PostgreSQL은 CHECK를 제자리에서 고칠 수 없다. 같은 이름으로 `DROP` 후 `ADD` 하되 **하나의 `DO` 블록(한 문장)** 안에서 수행해 제약 없는 구간이 없다(§9.2). 허용값이 늘기만 하므로 기존 데이터는 영향이 없다.

### 4.2 `app_private.reviews` (신규)

| 컬럼 | 타입 | 제약 |
| --- | --- | --- |
| `id` | `uuid` | PK, 앱에서 `uuid4` |
| `request_id` | `uuid` | NOT NULL |
| `reviewer_id` | `uuid` | NOT NULL |
| `reviewee_id` | `uuid` | NOT NULL |
| `reviewer_role` | `varchar(6)` | NOT NULL — `buyer` 또는 `seller` |
| `rating` | `smallint` | NOT NULL |
| `body` | `text` | NOT NULL |
| `created_at` | `timestamptz` | NOT NULL, `DEFAULT now()` |

| 이름 | 정의 |
| --- | --- |
| `fk_reviews_request` | `FOREIGN KEY (request_id) REFERENCES app_private.purchase_requests (id) ON DELETE CASCADE` |
| `fk_reviews_reviewer` | `FOREIGN KEY (reviewer_id) REFERENCES app_private.users (id) ON DELETE CASCADE` |
| `fk_reviews_reviewee` | `FOREIGN KEY (reviewee_id) REFERENCES app_private.users (id) ON DELETE CASCADE` |
| `uq_reviews_request_reviewer` | `UNIQUE (request_id, reviewer_id)` — 멱등 키 겸 요청별 조회 인덱스 |
| `uq_reviews_request_role` | `UNIQUE (request_id, reviewer_role)` — 거래당 역할별 1건(최대 2건) |
| `ck_reviews_role` | `CHECK (reviewer_role IN ('buyer', 'seller'))` |
| `ck_reviews_not_self` | `CHECK (reviewer_id <> reviewee_id)` |
| `ck_reviews_rating` | `CHECK (rating BETWEEN 1 AND 5)` |
| `ck_reviews_body_len` | `CHECK (char_length(btrim(body)) BETWEEN 2 AND 500)` |
| `ix_reviews_reviewee_id` | `(reviewee_id)` — 회원 삭제 cascade, 후속 평점 집계 |
| `ix_reviews_reviewer_id` | `(reviewer_id)` — 회원 삭제 cascade |

- 작성자·대상이 그 거래의 구매자·확정 판매자인지는 DB가 아니라 서비스가 보장한다(트리거 없음, 09 §4.2와 같은 방침). 테스트로 고정한다(R-I3).

### 4.3 SQLAlchemy 모델 (`backend/app/db/models.py`)

- `PurchaseRequest`: `completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))` 추가, status CHECK 문자열을 4.1대로 교체, `ck_purchase_requests_completed_at` 을 `{"schema": …}` 바로 앞에 추가.
- 파일 끝에 `Review` 를 4.2대로 추가한다. `ForeignKeyConstraint`·`UniqueConstraint`·`CheckConstraint`·`Index` 이름은 4.2와 **글자까지 동일**해야 한다(B-15의 드리프트 단정).

### 4.4 상태와 불변식

**요청 상태 전이**

```
purchase_requests.status :
    open ──(POST /match)──▶ matched ──(POST /complete, 구매자)──▶ completed     (종료 상태, 역전이 없음)
seller_applications.status : 이 단계에서 변경 없음 (확정 지원은 accepted 유지)
```

**지원 상태 × 요청 상태 → 방 상태** (`derive_chat_status`, 굵은 행이 추가분)

| 지원 `status` | 요청 `status` | `chatStatus` | `canSend` |
| --- | --- | --- | --- |
| `pending` | `open` | `active` | true |
| `accepted` | `matched` | `matched` | true |
| **`accepted`** | **`completed`** | **`completed`** | **false** |
| `closed` | `matched` / `completed` | `closed` | false |
| 그 외 조합 | — | `closed` | false (방어적) |

**불변식** (테스트는 테스트 소유 요청 id 범위에서만 검사)

- R-I1 `status = 'completed'` ⇔ `completed_at IS NOT NULL` (DB CHECK).
- R-I2 API로 만든 데이터에서 `completed` 요청에는 `accepted` 지원이 정확히 1건 있고 `pending` 지원은 없다.
- R-I3 모든 후기에서 `reviewer_id`, `reviewee_id` 는 그 요청의 `buyer_id` 와 확정 지원의 `seller_id` 이며 서로 다르다. `reviewer_role = 'buyer'` ⇔ `reviewer_id = buyer_id`.
- R-I4 후기가 있는 요청은 `completed` 다.
- R-I5 요청당 후기는 최대 2건, 역할별 최대 1건 (DB unique).
- R-I6 `completed` 요청의 확정 방에는 완료 커밋 이후 커밋된 메시지가 없다(§5.2 직렬화, 결정적 테스트 TC-C3·C4).
- R-I7 09 불변식 I1~I8은 그대로 유지된다(I2는 “`matched` **또는 `completed`** ⇔ accepted 1건”으로 읽는다).

---

## 5. 트랜잭션과 동시성

### 5.1 `complete_transaction` (신규 `app/services/transactions.py`)

```
BEGIN (READ COMMITTED; get_current_user 조회로 이미 시작됨)
  SELECT set_config('lock_timeout', '<application_lock_timeout_ms>ms', true)
  SELECT id, buyer_id, status, completed_at FROM app_private.purchase_requests
   WHERE id = :request_id FOR NO KEY UPDATE                              -- (1) lock_request_for_match 재사용
   └ 없음                    → ROLLBACK, 404 NOT_FOUND
   └ buyer_id <> :viewer     → ROLLBACK, 403 COMPLETION_FORBIDDEN          (확정 지원은 아직 보지 않음)
   └ status = 'completed'    → 확정 지원·방 id를 읽어 200 멱등 결과, ROLLBACK(읽기만 했으므로)
   └ status <> 'matched'     → ROLLBACK, 409 REQUEST_NOT_MATCHED           (open, closed)
  SELECT a.id, r.id AS room_id FROM app_private.seller_applications a
    JOIN app_private.chat_rooms r ON r.application_id = a.id
   WHERE a.request_id = :request_id AND a.status = 'accepted'
   FOR UPDATE OF a                                                        -- (2) 전송의 FOR SHARE 와 충돌 → 직렬화
   └ 없음 → ROLLBACK, 409 REQUEST_NOT_MATCHED   (06·09 테스트가 원시 SQL로 만든 “accepted 없는 matched” 과거 데이터)
  SELECT clock_timestamp() AS completed_at                                -- (3a) 잠금 (1)·(2)를 모두 얻은 뒤 DB 벽시계를 1회만 읽는다
  UPDATE app_private.purchase_requests
     SET status = 'completed', completed_at = :completed_at, updated_at = :completed_at
   WHERE id = :request_id AND status = 'matched'
   RETURNING completed_at                                                 -- (3b) 1행 기대. 두 컬럼에 (3a)의 같은 값을 바인드
  응답 DTO 검증 → COMMIT (단 한 번)                                         -- (4)
```

- **완료 시각은 `now()` 가 아니라 (3a)의 `clock_timestamp()` 한 값이다.** `now()`(= `transaction_timestamp()`)는 **트랜잭션 시작 시각**이다. 이 트랜잭션은 `get_current_user` 조회에서 이미 시작되었고 (1)·(2)에서 최대 `lock_timeout` 만큼 기다릴 수 있으므로, `now()` 를 쓰면 `completed_at` 이 잠금을 얻기 전 시각으로 기록된다(완료가 기다려 준 전송보다 앞선 시각이 될 수 있다).
- (3a)는 반드시 (2) **뒤**, (3b) **앞**의 별도 문장이다. `SET completed_at = clock_timestamp(), updated_at = clock_timestamp()` 처럼 두 번 호출하지 않는다(호출마다 값이 달라 두 컬럼이 어긋난다). 애플리케이션 서버 시계(`datetime.now()`)도 쓰지 않는다. 읽은 값을 그대로 두 컬럼에 바인드하므로 `completed_at = updated_at` 이다.
- 그래도 **타임스탬프는 커밋 순서의 증거가 아니다.** (3a)는 잠금 획득 뒤·커밋 전의 시각이고, `chat_messages.created_at` 은 전송 트랜잭션의 `now()`(시작 시각)이며, 벽시계는 보정될 수 있다. R-I6(완료 커밋 이후 커밋된 메시지 없음)의 근거는 §5.2의 잠금 직렬화이고, 검증도 Lock 대기 관측과 응답 순서로만 한다(TC-C3~C5). `completed_at` 과 `created_at` 의 대소 비교를 순서 증명으로 쓰지 않는다.
- 다른 경로(`confirm_match` 등)의 `updated_at = now()` 는 바꾸지 않는다.
- (3b)가 1행이 아니면 rollback, `log_database_failure("complete_transaction_invariant", …)`, 503.
- `IntegrityError`·`OperationalError`(`55P03` lock_timeout 포함)·기타 `SQLAlchemyError` → rollback, `log_database_failure("complete_transaction", …)`, 503. 비 DB 예외는 rollback 후 재발생(500). `confirm_match` 와 같은 구조다.
- (2)는 지원 행을 **수정하지 않고 잠그기만** 한다. 지원 상태·`decided_at` 은 그대로다.
- 멱등 결과의 `completedAt` 은 저장된 값이다(첫 응답과 같다). 멱등 경로는 (3a)를 실행하지 않는다.

### 5.2 메시지 전송 경로 보정 (`app/services/chat.py` `send_message`)

**문제.** `lock_for_send` 는 한 문장에서 방·지원 행을 잠그고 요청 status를 조인으로 읽는다. READ COMMITTED에서 이 문장이 지원 행 잠금을 기다리는 동안 완료가 커밋되어도, 잠그지 않은 `purchase_requests` 의 값은 **문장 시작 스냅샷** 그대로다(지원 행이 수정되지 않았으므로 재평가도 없다). 보정이 없으면 완료 직후에 `matched` 로 판정된 메시지가 커밋된다.

**변경.**

1. `lock_for_send` 의 SELECT 목록에 `a.request_id` 를 추가한다(잠금 절은 그대로 `FOR NO KEY UPDATE OF r FOR SHARE OF a`).
2. `send_message` 는 잠금 획득 뒤, 멱등 재전송 확인 다음에 **새 문장**으로 요청 status를 읽고 그 값으로 판정한다.

```
  room = lock_for_send(...)                                   -- (1) 기존. 없으면 404
  existing = find_by_client_id(...)                            -- (2) 기존. 있으면 200 (완료 후 재시도여도 기존 메시지)
  request_status = SELECT status FROM app_private.purchase_requests WHERE id = :request_id   -- (2b) 신규, 잠금 없음, 새 스냅샷
  derive_chat_status(room.application_status, request_status) ∉ {active, matched} → 409 CHAT_ROOM_CLOSED   -- (3)
  seq 배정 → INSERT → COMMIT                                   -- (4)~(6) 기존
```

**정당성.** 전송과 완료는 확정 지원 행에서 만난다(전송 `FOR SHARE`, 완료 `FOR UPDATE`).

| 먼저 지원 행을 잡은 쪽 | 진행 | 결과 |
| --- | --- | --- |
| 전송 | 완료의 (2)가 대기한다. 전송은 (2b)에서 `matched` 를 읽고 커밋한다. 그 뒤 완료가 진행된다 | 메시지 201 → 완료 200. 메시지는 완료 **이전** 커밋 |
| 완료 | 전송의 (1)이 대기한다. 완료 커밋 뒤 잠금을 얻고, (2b)는 새 스냅샷이라 `completed` 를 읽는다 | 완료 200 → 전송 409 `CHAT_ROOM_CLOSED`, 0행 |

그 외 결과는 없다. 마감된(`closed`) 방은 지원 행 상태만으로 이미 거절된다(09 D8).

### 5.3 잠금 순서와 교착

| 경로 | 잠금 순서 |
| --- | --- |
| 지원(06) | `purchase_requests`(SHARE) → INSERT |
| 매칭(09) | `purchase_requests`(NO KEY UPDATE) → `seller_applications` |
| **완료(11)** | `purchase_requests`(NO KEY UPDATE) → `seller_applications`(확정 1행, UPDATE) |
| 전송(09+11) | `chat_rooms`(NO KEY UPDATE) → `seller_applications`(SHARE). `purchase_requests` 는 **잠그지 않고** 읽기만 |
| **후기 작성(11)** | 행 잠금 없음. unique 인덱스 삽입 대기만 |

`purchase_requests` 는 항상 `seller_applications` 보다 먼저 잠기고, `chat_rooms` 를 잡는 경로(전송)는 `purchase_requests` 를 잠그지 않는다. 역순이 없으므로 교착이 없다. 모든 대기는 `lock_timeout`(기본 5초)으로 끊기고 503이 된다.

### 5.4 `create_review` (신규 `app/services/reviews.py`)

```
BEGIN
  SELECT set_config('lock_timeout', …, true)
  SELECT p.id, p.buyer_id, p.status, p.completed_at, a.seller_id
    FROM app_private.purchase_requests p
    LEFT JOIN app_private.seller_applications a ON a.request_id = p.id AND a.status = 'accepted'
   WHERE p.id = :request_id                                              -- (1) 잠금 없음
   └ 없음 또는 :viewer ∉ {buyer_id, seller_id}  → ROLLBACK, 404 NOT_FOUND   (두 경우 동일 본문)
   └ status <> 'completed'                      → ROLLBACK, 409 REQUEST_NOT_COMPLETED
  역할 도출: viewer = buyer_id → role 'buyer', reviewee = seller_id / 그 외 → role 'seller', reviewee = buyer_id
  INSERT INTO app_private.reviews (id, request_id, reviewer_id, reviewee_id, reviewer_role, rating, body)
  VALUES (…) ON CONFLICT DO NOTHING RETURNING id, created_at              -- (2) 대상 미지정: 두 unique 모두 arbiter
   └ 행 반환 → 응답 DTO 검증 → COMMIT → 201
   └ 0행 → SELECT … WHERE request_id = :request_id AND reviewer_id = :viewer        -- (3)
        └ 있음, rating·body 동일 → ROLLBACK, 200 { review: 기존 }
        └ 있음, 내용 다름        → ROLLBACK, 409 ALREADY_REVIEWED
        └ 없음                   → ROLLBACK, log_database_failure("create_review_invariant"), 503
```

- `completed` 는 종료 상태라 (1)에서 읽은 뒤 바뀌지 않는다. 완료와 후기 작성이 겹치면 후기가 완료 커밋 전 스냅샷을 읽어 409가 될 뿐이다(재시도하면 성공).
- (2)의 `ON CONFLICT DO NOTHING` 은 대상을 지정하지 않는다. 같은 작성자의 중복은 두 unique를 모두 위반하므로 어느 인덱스에서 먼저 충돌해도 오류 없이 0행이 된다. 동시에 들어온 다른 트랜잭션이 미커밋이면 그 종료까지 기다린다(상한 `lock_timeout`).
- 비교하는 `body` 는 trim된 값이다(저장값도 trim된 값).
- 방어용 `IntegrityError`: 제약 이름이 `uq_reviews_request_reviewer`/`uq_reviews_request_role` 이면 rollback 후 (3)을 수행, 그 외는 503.
- 후기 본문은 **어떤 로그에도 남기지 않는다**. `log_database_failure` 는 작업명·SQLSTATE만 기록한다(기존 동작).

### 5.5 `get_reviews` (읽기, 공개)

`get_reviews(db, *, request_id, viewer_id: UUID | None, settings)`. 잠금 없음, 쿼리 최대 2회.

1. 5.4 (1)과 같은 조인 1회. 요청이 없으면 `RequestNotFound` → 404. **참여자 여부로 거절하지 않는다.**
2. `status = 'completed'` 일 때만 `SELECT … FROM app_private.reviews WHERE request_id = :id`(최대 2행, `uq_reviews_request_reviewer` 인덱스 사용). 그 외 상태에서는 조회를 생략하고 빈 목록으로 둔다(R-I4).
3. 같은 행들로 응답을 조립한다(추가 쿼리 없음).
   - `items`: 공개 DTO(§6.2)로 변환한다. 순서는 작성 순서와 무관하게 `buyer` → `seller` 고정이다.
   - `viewer_role`: `viewer_id = buyer_id` 면 `buyer`, `viewer_id` 가 확정 지원의 `seller_id` 면 `seller`, 그 외(`viewer_id` 없음 포함)는 `None`.
   - `mine` / `received`: `viewer_role` 이 있을 때만 `reviewer_id = viewer_id` 인 행 / 아닌 행. `viewer_role` 이 없으면 둘 다 `None`.
   - `can_write`: `viewer_role` 이 있고, `status = 'completed'` 이고, `mine` 이 없을 때만 true.

- 익명, 비참여 회원, 마감된 지원 판매자는 모두 `viewer_role = None` 경로를 타므로 응답이 같다.
- `SQLAlchemyError` → rollback, `log_database_failure("get_reviews", …)`, 503.

### 5.6 시나리오와 기대 결과

| # | 시나리오 | 기대 |
| --- | --- | --- |
| S1 | 구매자가 `matched` 요청을 완료 | 200, 요청 `completed`·`completed_at`·`updated_at` 설정(같은 값, §5.1 (3a)), 지원 상태 불변, 확정 방 `completed`/`canSend=false`, 마감 방은 `closed` 유지 |
| S2 | 같은 완료를 두 번(순차·동시 K건) | 모두 200, 같은 본문(`completedAt` 동일). DB 변경 1회 |
| S3 | `open` 요청에서 완료와 매칭이 동시에 | 완료가 먼저면 409 `REQUEST_NOT_MATCHED` 뒤 매칭 200, 매칭이 먼저면 둘 다 200. 끝난 뒤 상태는 `matched` 또는 `completed` |
| S4 | 확정 방 전송과 완료가 경합 | §5.2 표의 두 결과뿐 |
| S5 | 완료 후 같은 `clientMessageId` 로 재전송(최초 전송은 완료 전 성공) | 200 기존 메시지(09 S8과 같은 규칙) |
| S6 | 같은 작성자가 같은 후기를 동시에 K건 | 정확히 1건 201, 나머지 200(같은 `id`). 행 1개 |
| S7 | 같은 작성자가 서로 다른 내용을 동시에 2건 | 하나 201, 하나 409 `ALREADY_REVIEWED`. 행 1개 |
| S8 | 구매자와 판매자가 동시에 후기 작성 | 둘 다 201. 행 2개, 역할 각 1건 |
| S9 | 완료된 요청에 매칭·지원 시도 | 매칭 409 `REQUEST_CLOSED`, 지원 409 `REQUEST_NOT_OPEN` |

---

## 6. API 계약

공통: JSON camelCase(`RequestSchema`, 입력 `extra="forbid"`), 모든 응답 `Cache-Control: no-store`, 오류 본문 `{"error": {"code","message","fields"}}`. 변경 요청은 `require_auth_post_request`(Origin 허용 목록 + `X-Requested-With: gamja-market` + `application/json`), 인증은 `get_current_user`. 후기 GET만 공개이며 `get_optional_user` 를 쓴다(§6.2).

### 6.1 `POST /api/requests/{requestId}/complete` — 거래 완료

요청 본문은 **읽지 않는다**(입력값이 없다). `require_auth_post_request` 가 JSON content-type을 요구하므로 클라이언트는 `{}` 를 보낸다.

성공 **200** (최초·멱등 동일):

```json
{
  "request": { "id": "uuid", "status": "completed", "completedAt": "2026-10-12T10:00:00.000000Z" },
  "acceptedApplicationId": "uuid",
  "chatRoomId": "uuid"
}
```

오류 판정 순서: 403 `INVALID_ORIGIN` / 415 → 401 `UNAUTHENTICATED` → 422 `VALIDATION_ERROR`(경로 UUID) → 404 `NOT_FOUND` → 403 `COMPLETION_FORBIDDEN` → 200 멱등 / 409 `REQUEST_NOT_MATCHED` → 503 `SERVICE_UNAVAILABLE`.

### 6.2 `GET /api/requests/{requestId}/reviews` — 이 거래의 후기 (공개, 선택 인증)

**로그인 없이 호출할 수 있다.** 세션 쿠키가 있으면 `get_optional_user` 로 조회자를 식별해 참여자 전용 필드를 채운다. 쿠키가 없거나 세션이 없거나 만료된 경우는 **익명과 똑같이 200**이고 쿠키를 건드리지 않는다(B-17).

성공 **200** — 완료된 요청을 구매자가 조회한 경우:

```json
{
  "requestId": "uuid",
  "requestStatus": "completed",
  "completedAt": "2026-10-12T10:00:00.000000Z",
  "items": [
    { "reviewerRole": "buyer", "rating": 5, "body": "약속 시간도 잘 지키고 물건 상태도 좋았어요.", "createdAt": "…" },
    { "reviewerRole": "seller", "rating": 4, "body": "입금이 빨라서 편했습니다.", "createdAt": "…" }
  ],
  "viewerRole": "buyer",
  "canWrite": false,
  "mine": { "reviewerRole": "buyer", "rating": 5, "body": "약속 시간도 잘 지키고 물건 상태도 좋았어요.", "createdAt": "…" },
  "received": { "reviewerRole": "seller", "rating": 4, "body": "입금이 빨라서 편했습니다.", "createdAt": "…" }
}
```

같은 요청을 익명·비참여 회원·마감된 지원 판매자가 조회하면 `items` 는 위와 같고 나머지는 다음과 같다.

```json
{ "viewerRole": null, "canWrite": false, "mine": null, "received": null }
```

| 필드 | 규칙 |
| --- | --- |
| `items` | 공개 후기 목록. 0~2건, `buyer` → `seller` 순. **조회자가 누구든 같다.** 완료 전 요청은 항상 `[]` |
| `PublicReviewView`(`items` 원소, `mine`, `received`) | `reviewerRole`, `rating`, `body`, `createdAt` **4개 키뿐**이다. 후기 id, user id, 이메일(원문·마스킹), 대상(reviewee) 정보를 넣지 않는다. **GET 응답의 후기는 모두 이 DTO다** |
| `viewerRole` | 인증된 요청 작성자는 `buyer`, 인증된 확정 판매자는 `seller`, 그 외(익명·비참여 회원·마감된 지원 판매자)는 `null` |
| `canWrite` | `viewerRole` 이 있고 `requestStatus == "completed"` 이고 `mine` 이 없을 때만 true. 익명·비참여자는 항상 false |
| `mine` / `received` | 참여자에게만 채운다: 내가 쓴 후기 / 상대가 나에 대해 쓴 후기(`PublicReviewView`). 없으면 `null`. 익명·비참여자는 항상 `null` |
| `completedAt` | 완료 전이면 `null`. 완료 시점의 기존 공개 필드 `updatedAt` 과 같은 값이라 새로 드러나는 정보가 아니다 |

- 참여자 = 요청 작성자, 또는 그 요청의 `accepted` 지원 판매자. 완료 전의 참여자는 `viewerRole` 만 채워진 200(`items: []`, `canWrite: false`, `mine`·`received` `null`)을 받는다.
- **익명, 비참여 회원, 마감된 지원 판매자의 응답 본문은 같은 요청에 대해 바이트 단위로 같다.** 응답으로 “누가 거래 상대인지”를 가릴 수 없다.
- `mine`·`received` 는 `items` 에 이미 있는 항목을 참여자 시점으로 다시 가리킬 뿐이다(값이 같다). **GET 응답에는 누구에게도 후기 `id` 가 없다.** 후기 `id` 는 작성자 본인의 POST 응답(§6.3)에만 있다.
- 후기는 작성 커밋 즉시 `items` 에 나타난다(블라인드·검수 대기 없음, H6).
- 오류: 422(경로 UUID), 404 `NOT_FOUND`(**없는 요청만**), 503. **401은 없다.**
- 응답에 조회자별 필드가 섞여 있으므로 공개 응답이어도 `Cache-Control: no-store` 를 유지한다(B-10).


### 6.3 `POST /api/requests/{requestId}/reviews` — 후기 작성

```json
{ "rating": 5, "body": "약속 시간도 잘 지키고 물건 상태도 좋았어요." }
```

- 성공 **201** `{ "review": ReviewView }`. 멱등 재전송 **200** `{ "review": 기존 ReviewView }`. `ReviewView` = `id` + `PublicReviewView` 의 4개 필드(`reviewerRole`, `rating`, `body`, `createdAt`)이며 **POST 응답 전용**이다. 이메일·user id는 넣지 않는다.
- 오류 순서: 403 `INVALID_ORIGIN` / 415 → 401 → 422 → 404 `NOT_FOUND` → 409 `REQUEST_NOT_COMPLETED` → (201 / 200 멱등 / 409 `ALREADY_REVIEWED`) → 503.
- 서비스는 `(ReviewView, created: bool)` 을 돌려주고 라우터가 201/200을 정한다(`send_message` 와 같은 방식).
- GET이 공개가 되어도 **POST 권한은 그대로**다: 익명 401, 비참여 회원·마감된 지원 판매자는 없는 요청과 같은 404.

### 6.4 후기 입력 검증

| 필드 | 규칙 |
| --- | --- |
| `rating` | `StrictInt`, 1 ≤ x ≤ 5. 문자열 `"5"`, 실수 `4.5`, `true`, `null`, 누락은 422 |
| `body` | `StrictStr`. 앞뒤 공백 제거(`mode="before"`) 후 2~500자. 줄바꿈 허용. 공백만이면 422. NUL(`\u0000`) 포함 시 422(PostgreSQL `text` 가 저장하지 못해 503이 되는 것을 막는다) |
| 그 외 | `revieweeId`, `reviewerRole`, `requestId` 등 모든 추가 필드 422 |

- 길이는 서버(Python `len`)와 DB(`char_length`) 모두 코드 포인트 기준이다. 저장값은 trim된 문자열이다.
- 본문은 일반 텍스트로만 다룬다. 화면은 React 텍스트 렌더링 + `whitespace-pre-wrap`(HTML 삽입 금지).
- 422 응답의 `fields` 는 아래 고정 문구만 담는다. Pydantic의 `input`·`ctx` 는 직렬화하지 않는다(기존 핸들러 동작).

### 6.5 새 오류 code

`backend/app/api/errors.py` `ERROR_MESSAGES`, `frontend/src/types/api.ts` `ApiErrorCode`, `frontend/src/lib/api/http.ts` `KNOWN_ERROR_CODES` 세 곳에 함께 추가한다.

| code | HTTP | message |
| --- | --- | --- |
| `COMPLETION_FORBIDDEN` | 403 | `구매요청 작성자만 거래를 완료 처리할 수 있습니다.` |
| `REQUEST_NOT_MATCHED` | 409 | `매칭이 확정된 구매요청만 거래 완료 처리할 수 있습니다.` |
| `REQUEST_NOT_COMPLETED` | 409 | `거래가 완료된 뒤에 후기를 작성할 수 있습니다.` |
| `ALREADY_REVIEWED` | 409 | `이미 이 거래의 후기를 작성했습니다.` |

기존 `NOT_REQUEST_OWNER` 는 문구가 “판매자를 확정할 수 있습니다”라 재사용하지 않는다. 완료된 방의 전송 거절은 기존 `CHAT_ROOM_CLOSED` 를 그대로 쓴다.

### 6.6 422 필드 메시지 (`main.py` `validation_error_handler`)

`^/api/requests/[^/]+/match$` 분기 다음, 일반 `/api/requests` 분기 **앞에** 추가한다.

- `^/api/requests/[^/]+/reviews$` → `{"rating": "평점은 1점부터 5점까지 선택해 주세요.", "body": "후기는 2자 이상 500자 이하로 입력해 주세요."}`
- 이 경로의 POST에서 `fields` 가 비면(본문이 객체가 아님 등) `fields["body"]` 를 채운다(메시지 경로의 기존 처리와 같다).
- `/complete` 는 본문 검증이 없어 분기를 추가하지 않는다(경로 UUID 오류는 `fields: {}`).

### 6.7 기존 엔드포인트 변경 (enum 값 추가만)

| 엔드포인트 | 변경 |
| --- | --- |
| `GET /api/requests`, `GET /api/requests/{id}` | `status` 에 `completed` 가 나타난다. `updatedAt` 은 완료 시각으로 바뀐다. 필드 추가 없음. `status=open` 필터 동작 불변(완료 요청은 전체 보기에 배지와 함께 남는다) |
| `GET /api/chat-rooms`, `GET /api/chat-rooms/{id}` | `request.status` 에 `completed`, `chatStatus` 에 `completed`. 확정 방은 `canSend: false` |
| `GET /api/chat-rooms/{id}/messages` | `room.requestStatus` 에 `completed`, `room.chatStatus` 에 `completed` |
| `POST /api/chat-rooms/{id}/messages` | 완료된 확정 방은 409 `CHAT_ROOM_CLOSED`. 완료 전에 성공한 `clientMessageId` 재전송은 계속 200 |
| `POST /api/requests/{id}/match` | 완료된 요청은 409 `REQUEST_CLOSED`(§12 K3) |
| `GET/POST /api/requests/{id}/applications` | 응답 형태 불변. 완료된 요청의 신규 지원은 기존대로 409 `REQUEST_NOT_OPEN` |
| 사진 API 전체 | 변경 없음 |

### 6.8 권한 매트릭스

| 행위 | 익명 | 회원(비참여) | 구매자(작성자) | 확정 판매자 | 마감된 지원 판매자 |
| --- | --- | --- | --- | --- | --- |
| 완료 POST | 401 | 403 `COMPLETION_FORBIDDEN` | 200 / 409 | 403 | 403 |
| 후기 GET — 공개 `items` | 200 | 200 | 200 | 200 | 200 |
| 후기 GET — `viewerRole`·`mine`·`received` | `null` | `null` | 채움 | 채움 | `null` |
| 후기 GET — `canWrite` | false | false | 완료 후 미작성이면 true | 완료 후 미작성이면 true | false |
| 후기 POST | 401 | 404 | 201 / 200 / 409 | 201 / 200 / 409 | 404 |
| 완료 방 메시지 GET | 401 | 404 | 200 | 200 | 404(자기 방은 200, `closed`) |
| 완료 방 메시지 POST | 401 | 404 | 409 | 409 | 404(자기 방은 409) |
| 요청 상태 `completed` 열람 | 가능 | 가능 | 가능 | 가능 | 가능 |

---

## 7. 백엔드 레이어

| # | 파일 | 내용 |
| --- | --- | --- |
| L1 | `migrations/versions/0007_completion_reviews.py` (신규) | §9 |
| L2 | `app/db/models.py` | §4.3 |
| L3 | `app/schemas/requests.py` | `RequestStatus = Literal["open", "matched", "closed", "completed"]` |
| L4 | `app/schemas/chat.py` | `ChatStatus` 에 `"completed"` 추가. `MessageRoomState.request_status`, `ChatRequestSummary.status` 의 인라인 Literal을 `RequestStatus` 로 교체 |
| L5 | `app/schemas/applications.py` | `ChatRoomView.chat_status` 인라인 Literal에 `"completed"` 추가(또는 `ChatStatus` 를 이 모듈로 옮겨 공유 — 순환 import가 없도록 `schemas/chat.py` 가 이 모듈에서 가져온다) |
| L6 | `app/schemas/reviews.py` (신규) | `ReviewCreate(rating: StrictInt 1~5, body: StrictStr 2~500, trim·NUL 검증)`, `PublicReviewView(reviewer_role, rating, body, created_at)`, `ReviewView(PublicReviewView + id, POST 응답 전용)`, `ReviewEnvelope(review: ReviewView)`, `TransactionReviewsResponse(request_id, request_status, completed_at, items: list[PublicReviewView] 최대 2건, viewer_role: ReviewerRole | None, can_write, mine: PublicReviewView | None, received: PublicReviewView | None)`, `CompletedRequestSummary(id, status: Literal["completed"], completed_at)`, `CompleteResponse` |
| L7 | `app/repositories/applications.py` | `lock_accepted_application(db, request_id)` — §5.1 (2). `lock_request_for_match` 는 그대로 재사용 |
| L8 | `app/repositories/chat_rooms.py` | `lock_for_send` SELECT 목록에 `a.request_id` 추가 |
| L9 | `app/repositories/requests.py` | `get_status(db, request_id)` — §5.2 (2b)의 단일 컬럼 조회 |
| L10 | `app/repositories/reviews.py` (신규) | `get_transaction(db, request_id)`(§5.4 (1) 조인), `insert_review(...)`(`ON CONFLICT DO NOTHING RETURNING`), `get_by_reviewer`, `list_for_request`(최대 2행. 공개 목록과 참여자 시점이 이 결과를 함께 쓴다) |
| L11 | `app/services/transactions.py` (신규) | `complete_transaction`(§5.1). 예외 `CompletionForbidden`, `RequestNotMatched`. `RequestNotFound` 는 `services/requests.py` 것을 재사용 |
| L12 | `app/services/reviews.py` (신규) | `get_reviews(viewer_id: UUID | None)`(§5.5, 없는 요청은 `services/requests.py` 의 `RequestNotFound`), `create_review`(§5.4). 예외 `ReviewTransactionNotFound`(작성 전용: 없는 요청·비참여자), `RequestNotCompleted`, `AlreadyReviewed` |
| L13 | `app/services/chat.py` | `derive_chat_status` 에 `("accepted", "completed") → "completed"` 추가, `send_message` 에 §5.2 (2b) 추가. `can_send` 판정 집합(`{"active","matched"}`)은 그대로 |
| L14 | `app/services/matching.py` | `request.status == "completed"` → `RequestClosed`(§12 K3). 기존 `closed` 분기 옆에 둔다 |
| L15 | `app/api/reviews.py` (신규) | `APIRouter(prefix="/api/requests")` 에 `POST /{request_id}/complete`, `GET /{request_id}/reviews`, `POST /{request_id}/reviews`. POST 2개는 `require_auth_post_request` + `get_current_user`, **GET은 `get_optional_user`**(인증 선택, `viewer.id if viewer else None` 전달). 셋 다 `_no_store` |
| L16 | `app/main.py` | `include_router(reviews_router)`, §6.6 분기 |
| L17 | `app/api/errors.py` | §6.5 |

---

## 8. 멱등성·재시도 요약

| 요청 | 멱등 키 | 재시도 결과 |
| --- | --- | --- |
| 완료 | 요청 id(상태 자체) | 200, 같은 본문 |
| 후기 작성 | `(request_id, reviewer_id)` + 내용 일치 | 같은 내용 200, 다른 내용 409 |
| 완료된 방 메시지 재전송 | `clientMessageId`(09) | 완료 전에 저장된 것이면 200 |
| lock_timeout·DB 장애(503) | — | 상태가 바뀌지 않았으므로 그대로 재시도 가능 |

클라이언트는 완료·후기 제출 버튼을 진행 중 비활성으로 둔다(1차 방어). 서버 멱등이 2차 방어다.

---

## 9. 마이그레이션 `0007_completion_reviews`

### 9.1 revision

- 파일 `backend/migrations/versions/0007_completion_reviews.py`, `revision = "0007_completion_reviews"`(23자 ≤ 32), `down_revision = "0006_security_perf_hardening"`, `branch_labels = None`, `depends_on = None`. 단일 head 유지.

### 9.2 upgrade (멱등, `0005`·`0006` 스타일)

먼저 `op.execute(sa.text("SET LOCAL lock_timeout = '5s'"))`를 실행한다. 기존 요청을 잡은 장기 트랜잭션 때문에 DDL이 무기한 대기하지 않도록 하며, 타임아웃 시 트랜잭션이 롤백되어 재실행할 수 있다. 이어서 순서대로 `op.execute(sa.text(...))`:

1. `ALTER TABLE app_private.purchase_requests ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL`
2. status CHECK 확대 — 정의에 `completed` 가 없을 때만 교체한다(재실행 안전, 한 문장이라 원자적). `sa.text` 가 바인드 파라미터나 포맷 문자로 오해하지 않도록 `::` 캐스트와 `%` 를 쓰지 않는다.

   ```sql
   DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'ck_purchase_requests_status'
          AND c.conrelid = to_regclass('app_private.purchase_requests')
          AND position('completed' in pg_get_constraintdef(c.oid)) > 0
     ) THEN
       ALTER TABLE app_private.purchase_requests DROP CONSTRAINT IF EXISTS ck_purchase_requests_status;
       ALTER TABLE app_private.purchase_requests ADD CONSTRAINT ck_purchase_requests_status
         CHECK (status IN ('open', 'matched', 'closed', 'completed'));
     END IF;
   END $$
   ```
3. `ck_purchase_requests_completed_at` — `pg_constraint` 에 없을 때만 `ADD CONSTRAINT`(0005의 `DO` 블록 방식).
4. `CREATE TABLE IF NOT EXISTS app_private.reviews (…§4.2의 컬럼과 명명된 제약 전부…)`
5. `CREATE INDEX IF NOT EXISTS ix_reviews_reviewee_id ON app_private.reviews (reviewee_id)`
6. `CREATE INDEX IF NOT EXISTS ix_reviews_reviewer_id ON app_private.reviews (reviewer_id)`

금지: 데이터 `UPDATE`/`DELETE`/`TRUNCATE`, 기존 컬럼 `ALTER COLUMN`/`DROP`/`RENAME`, `alembic_version` 직접 쓰기. 이 revision에서 허용되는 `DROP` 은 2번의 `DROP CONSTRAINT IF EXISTS ck_purchase_requests_status` **하나뿐**이다.

### 9.3 downgrade

**이 revision의 downgrade는 지원하지 않는다.** `downgrade()` 는 **어떤 DDL보다 먼저** `RuntimeError` 를 던지고 끝난다.

```python
def downgrade() -> None:
    raise RuntimeError(
        "0007_completion_reviews downgrade is unsupported: "
        "it would destroy reviews and transaction completion data"
    )
```

- 함수 본문은 이 `raise` 한 문장뿐이다. `op.execute`·`op.*` 호출, 조건 분기, `raise` 앞의 다른 문장을 두지 않는다. 온라인·오프라인(`--sql`) 어느 모드에서도 DDL이 한 줄도 나가지 않는다.
- 따라서 `app_private.reviews` 의 후기, `purchase_requests.completed_at`, `completed` 상태 행, 두 CHECK는 **그대로 보존**된다. 0005·0006의 downgrade(`DROP …`)와 다른 이유는 다음과 같다.
  - `reviews` 테이블과 `completed_at` 컬럼을 지우면 후기와 완료 시각이 사라진다. 사용자가 만든 데이터이고 복구할 수 없다.
  - `completed` 행이 하나라도 있으면 status CHECK를 0006 정의(`open`/`matched`/`closed`)로 좁힐 수 없다. 좁히려면 그 행을 다른 상태로 `UPDATE` 해야 하는데, 완료는 불가역이고(§0.1) 데이터 `UPDATE` 는 금지다(§9.2).
  - 스키마 일부만 되돌리면(테이블·컬럼만 제거하고 CHECK는 넓게 둠) DB가 0006도 0007도 아닌 상태가 된다.
- **넓어진 CHECK가 0006 코드에 무해한 것이 아니다.** 0006 코드는 `completed` 행을 스스로 만들지 않을 뿐이다. `completed` 행이 **처음 생긴 뒤**에는 0006 코드가 그 행에서 오동작한다(§9.4).
- 되돌려야 하는 문제가 생기면 schema downgrade가 아니라 **수정 전진**(새 revision 또는 코드 수정)으로 해결한다.
- 검증은 DB에 접속하지 않는 오프라인 방식으로만 한다(MG6). 공유 DB를 대상으로 `alembic downgrade` 를 실행하지 않는다(§13.3).

### 9.4 적용 경로

- 로컬: pytest 세션 fixture가 `_explicit_migration_target` 으로 `0007_completion_reviews` 까지 `command.upgrade`(§13.2). 개발 서버 단독 기동 시에는 `MIGRATION_DATABASE_URL` 을 로컬 URL로 둔 `uv run alembic upgrade 0007_completion_reviews` 만 허용(명시 target, `head` 아님).
- 운영 Supabase: `pr-merge` 스킬 절차로 배포 전에 적용한다. 테스트·개발 서버는 운영 DB에 DDL을 적용하지 않는다(conftest 가드 유지).
- 잠금 영향: 1~3번은 `purchase_requests` 에 짧은 ACCESS EXCLUSIVE, CHECK 2개 검증은 전체 스캔(행 수가 작아 무시 가능).
- 배포 순서: **마이그레이션 → 코드**. 0007이 적용된 DB에서 0006 코드는 **`completed` 행이 처음 생기기 전까지만** 정상 동작한다. 0006 코드는 추가 컬럼·새 테이블을 쓰지 않고 `completed` 를 만들지도 않으므로, 마이그레이션 적용과 신버전 코드 배포 사이 구간은 안전하다.
- **신버전 코드가 완료를 1건이라도 만든 뒤에는 0006 코드로 되돌릴 수 없다.** 0006 코드는 `completed` 를 모른다.
  - 응답 스키마의 status `Literal`(§7 L3~L5의 변경 전 정의)이 `completed` 를 거부해, 그 요청이 포함된 목록·상세·채팅방 응답이 오류(500)가 된다. 목록은 그 행이 든 페이지 전체가 실패한다.
  - `confirm_match` 는 불변식 위반 503이 된다(K3). `derive_chat_status` 는 확정 방을 `closed` 로 판정한다(K5).
  - 구버전 프론트 파서는 `INTERNAL_ERROR` 로 처리한다(A6).
- 그러므로 0007 배포 후의 롤백 수단은 **코드 롤백도 schema downgrade(§9.3)도 아니고 수정 전진뿐**이다. 구버전·신버전 백엔드가 동시에 트래픽을 받는 구간에도 같은 문제가 생기므로 전환은 한 번에 한다(A6). 이 제약을 `pr-merge` 배포 점검 항목에 넣는다.

---

## 10. 공개 범위와 프라이버시

**승인된 정책(H4, 2026-10-12): 후기는 익명 사용자를 포함한 모두에게 공개한다.** 작성 즉시 공개되고, 공개 단위는 요청(거래) 1건이다. 프로필·평점 집계는 범위 밖이다.

| 정보 | 익명·비참여 회원·마감된 지원 판매자 | 구매자·확정 판매자 |
| --- | --- | --- |
| 요청 상태 `completed`(“거래완료” 배지) | 보임 | 보임 |
| 완료 시각 | 보임(`completedAt`. 완료 시점의 기존 공개 필드 `updatedAt` 과 같은 값) | 보임 |
| 후기 존재 여부·개수 | **공개** | 공개 |
| 후기의 작성자 역할·평점·본문·작성일 | **공개**(`items`) | 공개 |
| 어느 역할이 아직 쓰지 않았는지 | 공개(`items` 에 그 역할이 없다) | 공개 |
| 후기 작성자의 user id·이메일(원문·마스킹) | **비공개** — 어떤 응답에도 없다 | 후기 응답에는 없다(상대의 마스킹 이메일은 채팅방 기존 표시로만) |
| 확정 판매자가 누구인지 | **비공개**(09 H4 유지) | 서로의 마스킹 이메일(채팅방 기존 표시) |
| 내가 이 거래의 참여자인지(`viewerRole`), `mine`·`received`·`canWrite` | 항상 `null`/false | 본인 요청에만 채워진다 |
| 후기 `id` | 비공개 | GET에는 없다. 작성자 본인의 POST 응답에만 |

**신원 마스킹 정책과의 관계**

- 공개 후기는 작성자를 **역할로만** 표시한다. `reviewerRole: "buyer"` 는 요청 작성자를 뜻하고, 요청 작성자는 요청 상세에 이미 마스킹 이메일로 공개되어 있다(05). 후기 응답은 그 마스킹 이메일조차 다시 싣지 않는다.
- `reviewerRole: "seller"` 는 “확정 판매자”라는 사실만 알린다. 지원자 목록은 익명·비참여 회원에게 인원 수만 보이므로(06), 후기가 공개되어도 **확정 판매자가 누구인지는 제3자가 알 수 없다.**
- 익명, 비참여 회원, 마감된 지원 판매자가 받는 GET 응답은 같은 요청에 대해 바이트 단위로 같다. 마감된 지원 판매자도 응답으로 자신이 탈락했다는 것 이상을 알 수 없다.
- 후기 **작성** API는 비참여자에게 없는 요청과 같은 404를 준다. 응답 차이·상태 코드로 거래 상대 여부를 추론할 수 없다.

**공개에 따른 주의**

- 본문은 작성자가 자유롭게 쓰는 글이라 상대의 연락처·실명 같은 개인정보나 비방이 들어갈 수 있다. 이 단계에는 신고·숨김·삭제 기능이 없다(X4, X12). 작성 폼에 “누구나 볼 수 있게 공개된다”는 안내를 **제출 전에** 보여 준다(§11.6).
- 요청 상세는 로그인 없이 열리는 SSR 페이지라 후기 본문이 HTML에 포함되고 검색엔진에 수집될 수 있다(X12).
- 본문은 일반 텍스트로만 렌더한다(§6.4). 공개 화면에서도 HTML 삽입·링크 자동 변환을 하지 않는다.
- 후기 본문은 서버 로그, 오류 응답, 테스트 assert 메시지에 넣지 않는다(공개 데이터여도 로그 위생은 유지한다).
- 응답은 조회자별 필드가 섞여 있어 `no-store` 다. 프론트는 후기 데이터를 `localStorage` 등에 저장하지 않는다.
- 평점 집계·프로필이 없으므로 후기는 그 요청 화면에서만 보인다. 특정 사용자의 후기를 모아 보는 경로는 없다.

---


## 11. 프론트엔드

### 11.1 타입

- `types/request.ts`: `RequestStatus` 에 `'completed'`.
- `types/application.ts`: `ChatStatus` 에 `'completed'`.
- `types/api.ts`: §6.5 code 4개.
- 신규 `types/review.ts`: `ReviewerRole = 'buyer' | 'seller'`, `PublicReview { reviewerRole; rating; body; createdAt }`(id 없음, GET의 모든 후기), `Review = PublicReview & { id }`(POST 응답 전용), `TransactionReviews { requestId; requestStatus; completedAt: string | null; items: PublicReview[]; viewerRole: ReviewerRole | null; canWrite; mine: PublicReview | null; received: PublicReview | null }`, `ReviewPayload { rating; body }`, `CreateReviewResult { review; created }`, `CompleteResult { request: { id; status: 'completed'; completedAt }; acceptedApplicationId; chatRoomId }`.

### 11.2 API 클라이언트 (신규 `lib/api/reviews.ts`)

| 함수 | 계약 |
| --- | --- |
| `completeTransaction(requestId, signal?)` | `POST /api/requests/{id}/complete`, `postInit({})`. 409 추정값 보정(F-10) |
| `getTransactionReviews(requestId, { signal?, baseUrl?, cookie? })` | `GET /api/requests/{id}/reviews`. **로그인 없이도 성공한다**(공개). SSR은 쿠키가 있으면 전달한다. 파서: `items` 는 길이 0~2의 배열이고 원소는 4개 필드가 모두 유효해야 한다. `viewerRole` 은 `'buyer'`·`'seller'`·`null` 만 허용 |
| `createReview(requestId, payload, signal?)` | `POST …/reviews`, 필드 키 `['rating', 'body']`, 201·200 모두 성공으로 `{ review, created: status === 201 }`, 409 추정값 보정 |

기존 파서 5곳(F-2)의 enum 가드에 `completed` 를 추가한다. 모든 파서는 타입 가드 실패 시 `INTERNAL_ERROR` 를 던진다(기존 방식). `rating` 은 1~5 정수가 아니면 파서 실패다.

### 11.3 배지

| 컴포넌트 | 추가 |
| --- | --- |
| `Badge`(요청 상태) | `completed` → “거래완료”. 기존 3색과 구분되는 색(권장 `bg-violet-50 text-violet-700 ring-violet-600/20`) |
| `ChatStatusBadge` | `completed` → “거래 완료”. 같은 색 계열 |

### 11.4 `CompleteTransactionButton` (신규 `features/transactions/components/`)

`ConfirmMatchButton` 과 같은 2단계 패턴이다. props `requestId`, `className?`.

- 1단계 버튼 “거래 완료”. 누르면 확인 패널: “물건을 받으셨나요? 거래를 완료하면 채팅이 종료되고 되돌릴 수 없어요.” + “완료” / “취소”.
- 진행 중 버튼 비활성. 성공 → `router.refresh()`.
- 409 `REQUEST_NOT_MATCHED` → 서버 message 표시 후 `router.refresh()`. `COMPLETION_FORBIDDEN`/`NOT_FOUND` → message 표시. `UNAUTHENTICATED` → “로그인이 필요해요. 다시 로그인해 주세요.” 그 외 → “잠시 후 다시 시도해 주세요.”

### 11.5 `/chats/[roomId]`

- `page.tsx`: `getChatRoom` 성공 뒤 `room.chatStatus === 'completed'` 일 때만 `getTransactionReviews(room.request.id, …).catch(() => null)` 을 SSR로 받아 넘긴다. 실패해도 페이지를 깨지 않는다.
- `ChatRoomView`: prop `initialReviews?: TransactionReviews | null` 추가. `room.chatStatus === 'completed'` 면 지원 카드와 메시지 패널 사이에 `<ReviewPanel id="reviews" …>` 를 렌더한다.
- `ChatMessagePanel`:
  - 배너: `completed` → “거래가 완료된 채팅방이에요. 이전 대화만 볼 수 있어요.”
  - 구매자 + `chatStatus === 'matched'` + `!unavailable` → `CompleteTransactionButton`(기존 확정 버튼 자리).
  - 입력 비활성 사유: `completed` 면 “거래가 완료되어 메시지를 보낼 수 없어요.”, 그 외는 기존 문구.
  - 폴링이 `chatStatus` 를 `completed` 로 **처음** 바꾼 순간 `routerRef.current.refresh()` 를 1회 호출한다(판매자의 열린 탭에 후기 패널이 나타난다). 기준은 부모의 `room.chatStatus`다. 병렬 SSR에서 초기 메시지만 더 최신(`completed`)이고 부모는 `matched`인 경우에도 갱신한다. 부모가 이미 `completed`로 시작한 방에서는 호출하지 않는다.
  - 전송 409 `CHAT_ROOM_CLOSED`: 직전 `chatStatus` 가 `matched` 면 `{ chatStatus: 'completed', canSend: false }`, 아니면 기존대로 `closed`(`matched` 방이 닫히는 경로는 완료뿐이다).
  - 폴링 주기·백오프·커서 규칙(09 P1~P17)은 변경 없음.

### 11.6 `ReviewPanel` (신규 `features/reviews/components/`, `'use client'`)

props: `requestId`, `roomId`, `initial: TransactionReviews | null`. 완료된 확정 채팅방의 **참여자용** 패널이다(작성·내 후기·받은 후기). 공개 목록은 §11.9의 `PublicReviewList` 가 맡고, 이 패널은 `items` 를 쓰지 않는다. 조회 결과의 `viewerRole` 이 `null` 이면(정상 흐름에서는 없다) 패널을 그리지 않는다.

| 상태 | 화면 |
| --- | --- |
| `initial === null` | 마운트 시 1회 조회. 실패 시 “후기를 불러오지 못했어요.” + “다시 시도” |
| `canWrite` | 작성 폼 |
| `mine` 있음 | “내가 남긴 후기” 카드(별점·본문·작성 시각) |
| `received` 있음 / 없음 | “상대방이 남긴 후기” 카드 / “아직 상대방이 후기를 남기지 않았어요.” |

작성 폼:

- 별점: `role="radiogroup"`(이름 “평점”) 안의 라디오 5개(“1점”~“5점”), 키보드 방향키로 선택. **기본 선택 없음** — 고르기 전에는 제출 비활성.
- 본문: `textarea`, `maxLength={500}`, `n/500` 카운터, 안내 “거래는 어떠셨나요? (2자 이상)”. trim 후 2자 미만이면 제출 비활성.
- 안내 문구(제출 버튼 위, 항상 표시): “후기는 등록하면 **누구나 볼 수 있게 공개**되고, 수정하거나 삭제할 수 없어요. 연락처 같은 개인정보는 적지 마세요.”
- “내가 남긴 후기” 카드 아래에 링크 “공개된 후기 보기”(`/requests/{requestId}#reviews`).
- 제출 중 비활성. 201/200 → 응답의 `review` 로 `mine` 을 채우고 폼을 카드로 교체(새로고침 불필요).
- 409 `ALREADY_REVIEWED` → GET 재조회로 저장된 후기를 보여 주고 “이미 작성한 후기가 있어요.” 안내. 409 `REQUEST_NOT_COMPLETED` → message 표시 후 `router.refresh()`.
- 422 → `fields.rating`/`fields.body` 를 해당 입력 아래에 표시(`role="alert"`). 401 → `/login?next=/chats/{roomId}`. 404 → “후기를 작성할 수 없어요.” 503/네트워크 → “잠시 후 다시 시도해 주세요.”(입력 유지).
- 별점 표시는 색만으로 전달하지 않는다: 텍스트 대체 “5점 만점에 4점”.
- 후기 영역은 폴링하지 않는다. 상대 후기는 새로고침 시 반영된다.

### 11.7 요청 상세 (`ApplicantList`, `ApplyPanel`)

- `ApplicantList`: owner + 요청 `matched` + 지원 `accepted` 카드에 `CompleteTransactionButton`. 요청 `completed` + `accepted` 카드(owner·applicant 모두)에 “거래 후기” 링크(`/chats/{chatRoomId}#reviews`). 확정 카드 강조·정렬은 그대로.
- `ApplyPanel`(applicant): 지원 `accepted` 이고 요청 `completed` 면 문구 “거래가 완료됐어요. 후기를 남겨 보세요.”, 링크 “후기 남기기”(`/chats/{chatRoomId}#reviews`). 그 외 조합은 기존 표 그대로. member·anonymous·owner 분기는 변경 없음(member + `completed` 는 기존 “모집이 마감된 요청입니다”).
- member/anonymous 화면의 지원 영역은 배지 외에 변경 없다(🔒 안내 유지, 지원자·거래 상대 비노출). 후기는 §11.9의 공개 목록으로 보인다.

### 11.8 `/chats` 목록, 홈 목록

배지 라벨만 추가된다. 목록 쿼리·정렬·필터 변경 없음.

### 11.9 요청 상세의 공개 후기 (`PublicReviewList`, 신규 `features/reviews/components/`, `'use client'`)

**SSR 읽기 (`app/requests/[id]/page.tsx`)**

- 기존 `Promise.all([loadRequest, loadApplications])` 는 그대로 둔다. 그 뒤 `request.status === 'completed'` 일 때만 `loadReviews(id, cookie)` 를 호출한다(완료되지 않은 요청은 추가 요청이 없다).
- `loadReviews` 는 `loadApplications` 와 같은 방식이다: `getTransactionReviews(id, { baseUrl: resolveServerApiBase(), cookie })` 를 `try`/`catch` 로 감싸 실패 시 `null` 을 돌려준다. **후기 조회 실패는 페이지를 실패시키지 않는다.** 익명 방문자는 쿠키 없이 호출한다.
- 결과를 `RequestDetail` 의 새 prop `initialReviews?: TransactionReviews | null`(기본 `null`)로 넘긴다. 지원 목록 성공·실패 두 분기 모두 같은 값을 넘긴다. prop이 선택이라 기존 `RequestDetail` 호출·테스트는 그대로 컴파일된다.
- `generateMetadata` 는 바꾸지 않는다(후기 본문을 메타 태그에 넣지 않는다).

**렌더 (`RequestDetail`)**

- `request.status === 'completed'` 일 때만 `</article>` 과 `ApplicantList` 사이에 `<PublicReviewList id="reviews" requestId={request.id} initial={initialReviews ?? null} />` 를 둔다. 그 외 상태에서는 후기 영역이 없다.

**`PublicReviewList`** — props `requestId`, `initial: TransactionReviews | null`. `items` 만 사용한다.

| 상태 | 화면 |
| --- | --- |
| `initial` 있음, `items` 1~2건 | 제목 “거래 후기”. 항목마다 역할 라벨(“구매자가 남긴 후기” / “판매자가 남긴 후기”), 별점(텍스트 대체 “5점 만점에 4점”), 본문(`whitespace-pre-wrap`, 일반 텍스트), 작성일(`formatDateTime`) |
| `initial` 있음, `items` 0건 | “아직 등록된 후기가 없어요.” |
| `initial === null`(SSR 실패) | 마운트 시 브라우저에서 1회 재조회. 진행 중 “후기를 불러오는 중이에요.” |
| 재조회 실패 | “후기를 불러오지 못했어요.”(`role="alert"`) + “다시 시도” 버튼. 누르면 다시 조회하고 진행 중에는 버튼 비활성 |

- 항목의 React key는 `reviewerRole` 이다(요청당 역할별 최대 1건, 공개 DTO에 id 없음).
- 작성자 이름·이메일·아바타를 그리지 않는다. 역할 라벨이 유일한 작성자 표시다.
- 익명·회원·참여자 모두 같은 목록을 본다. 작성 폼·“내 후기” 구분은 이 컴포넌트에 없다. 참여자의 작성 진입점은 기존대로 `ApplicantList`/`ApplyPanel` 의 링크(§11.7)와 채팅방 `ReviewPanel` 이다.
- 폴링하지 않는다. 새 후기는 새로고침 시 반영된다(`force-dynamic` + `no-store`).
- 재조회 중 언마운트되면 `AbortController` 로 취소한다.

---

## 12. 호환성 — 보존하는 계약과 의도된 변경

| # | 계약 | 처리 |
| --- | --- | --- |
| K1 | 인증(02/04/10): 쿠키 세션, POST의 Origin·`X-Requested-With`·JSON 검사, 레이트리밋 | 새 엔드포인트가 같은 의존성을 사용. 인증 코드 변경 없음 |
| K2 | 지원(06)·매칭(09): 원자적 지원+방 생성, 잠금 순서, 목록 범위, 404 은닉 | 변경 없음. 06·09 테스트 전부 회귀 통과 |
| K3 | **의도된 변경** — 매칭 서비스 | `completed` 요청의 매칭 시도는 기존 코드에서 불변식 위반 503이 된다. 409 `REQUEST_CLOSED` 로 고친다(같은 지원 재확정 포함) |
| K4 | **의도된 변경** — 전송 경로 | `send_message` 에 요청 status 재조회 1문장 추가(§5.2). 완료 전 동작·응답은 같다 |
| K5 | **의도된 변경** — 09 §4.4 표 | `("accepted", "completed")` 가 `closed` 에서 `completed` 로 바뀐다. 0007 이전에는 존재할 수 없던 조합이다 |
| K6 | 응답 확장 방식 | 기존 엔드포인트는 enum 값 추가만. 신버전 프론트·백엔드를 **함께** 배포한다(A6). `completed` 행이 생긴 뒤에는 구버전 백엔드·프론트로 되돌릴 수 없다(§9.4) |
| K7 | 스키마 | 기존 행은 변경 없이 유효. status CHECK는 허용값 확대만 |
| K8 | 사진(07/08) | 테이블·라우트·스토리지 코드 변경 없음. `completed` 요청의 사진도 기존처럼 공개 제공 |
| K9 | **의도된 변경** — 요청 상세 화면 | `completed` 요청의 상세에 공개 후기 영역이 추가된다(§11.9). `RequestDetail` 의 새 prop은 선택이라 기존 호출·테스트는 수정 없이 통과한다. 요청·지원 API 응답은 그대로다(D14) |
| K10 | 09 §15 H4(매칭 상대 비공개) | 유지. 공개 후기는 역할만 싣는다(D15). 익명·비참여 회원의 지원 목록 응답도 그대로다 |

---

## 13. 비파괴 검증 계약

### 13.1 사전 확인 (읽기 전용, tester)

1. 조사 시점(2026-10-12) docker 데몬이 꺼져 있어 `alembic_version` 을 읽지 못했다. `docker compose up -d`(프로젝트명 `gamja-market` 고정, 기존 볼륨 유지)로만 기동한다. `down -v`, 볼륨 삭제, 새 DB·스키마 생성 금지.
2. `SELECT version_num FROM alembic_version` → `0006_security_perf_hardening` 기대. 다르면 중단하고 코디네이터에게 escalation한다(stamp/downgrade 금지).
3. 결과를 `docs/verification/11-*.md` 에 기록한다(tester 소유).

### 13.2 conftest 변경 (tester)

- `_explicit_migration_target`: `"0007_completion_reviews" in known` 이면 그것을 **최우선** 반환한다. 그 아래 `0006…` → `0005…` 순서와 가드·`head` 금지·모르는 revision 중단 로직은 그대로 둔다.
- 기존 fixture(`test_ns`, `ns_email`, `ns_title`, `rollback_connection`, `wait_until_blocked_by`, `owned_request_ids`, `client_factory`, `post_headers`)와 `_application_support.py` 헬퍼를 재사용하고 `complete`, `post_review`, `get_reviews` 헬퍼를 추가한다.

### 13.3 금지 사항

- `DELETE`, `TRUNCATE`, `DROP`, `alembic downgrade`/`stamp`, `alembic_version` 쓰기, 새 DB/스키마 생성 — 롤백 트랜잭션 안에서도 금지(0007 upgrade의 CHECK 교체는 예외). MG6은 DB에 접속하지 않고 `downgrade()` 가 예외를 던지는지만 확인하므로 이 금지에 해당하지 않는다.
- 전역 개수 단정. 모든 단정은 테스트가 만든 요청 id 또는 `test_ns` 로 한정한다.
- 테스트 데이터가 아닌 행의 `UPDATE`. 원시 SQL 상태 변경은 **자기 테스트 요청**에만.
- 완료된 테스트 요청·후기는 삭제하지 않고 남긴다(되돌리기 API도 없다).
- 후기 본문·DB URL을 로그·assert 메시지에 출력하지 않는다.

### 13.4 인수 조건 — RED 테스트 매트릭스

**백엔드 — `backend/tests/test_transaction_completion.py`**

| # | 테스트 | 기대 |
| --- | --- | --- |
| TC1 | `test_complete_marks_request_completed` | S1. 응답 필드, DB `status`·`completed_at`·`updated_at`(`completed_at = updated_at`, 응답 `completedAt` 과 일치), 지원 상태·`decided_at` 불변 |
| TC2 | `test_complete_is_idempotent` | 두 번째 200, 본문 동일, `completed_at` 불변 |
| TC3 | `test_complete_authorization` | 익명 401, 비참여 회원·확정 판매자·마감 판매자 403 `COMPLETION_FORBIDDEN`, 없는 요청 404 |
| TC4 | `test_complete_requires_matched` | `open` 요청 409 `REQUEST_NOT_MATCHED`, 원시 SQL로 `closed` 로 만든 자기 요청 409, accepted 없이 `matched` 만 만든 자기 요청 409 |
| TC5 | `test_complete_origin_and_path_validation` | Origin 누락 403, `text/plain` 415, 잘못된 UUID 422, 본문에 임의 필드가 있어도 200 |
| TC6 | `test_completed_room_is_read_only` | 확정 방: 양쪽 전송 409 `CHAT_ROOM_CLOSED`, GET 200 `chatStatus=completed`·`canSend=false`·`requestStatus=completed`, 기존 메시지 보존. 마감 방은 `closed` 유지 |
| TC7 | `test_resend_after_completion_returns_existing` | S5 |
| TC8 | `test_completed_status_visible_in_existing_endpoints` | 목록·상세 `status=completed`, `GET /api/chat-rooms` 와 `/{id}` 의 `request.status`·`chatStatus`. 응답 키 집합은 0006과 동일 |
| TC9 | `test_match_and_apply_after_completion` | S9 |
| TC10 | `test_db_rejects_inconsistent_completed_at` (`rollback_connection`, 자기 테스트 행 대상 실패 UPDATE만) | `ck_purchase_requests_completed_at` 위반 이름 일치(양방향), 모르는 status 값은 `ck_purchase_requests_status` |
| TC11 | `test_complete_no_store_and_503` | `no-store`, `FailingSession` 503, 비밀 문자열 부재 |
| U1+ | `test_derive_chat_status_table` 확장(`test_chat_messages.py`) | §4.4 표 전 조합(추가 2행 포함, 기존 단정 유지) |

**백엔드 — `backend/tests/test_reviews.py`**

| # | 테스트 | 기대 |
| --- | --- | --- |
| RV1 | `test_buyer_and_seller_each_write_one_review` | 둘 다 201. DB: 역할·`reviewer_id`·`reviewee_id` 정확(R-I3), 행 2개 |
| RV2 | `test_get_reviews_by_viewpoint` | 구매자·판매자 시점의 `viewerRole`/`mine`/`received`/`canWrite`, 두 시점의 `items` 는 동일. `mine`·`received` 가 `items` 의 같은 역할 항목과 값이 같다(4개 키). 응답에 이메일·user id 문자열 부재 |
| RV3 | `test_review_requires_completed` | `matched` 요청: 구매자·확정 판매자 POST 409 `REQUEST_NOT_COMPLETED`, GET 200 `items=[]`·`canWrite=false`·`viewerRole` 채움. `open` 요청 작성자도 같음. 익명의 GET은 200 `items=[]`·`viewerRole=null` |
| RV4 | `test_review_access_matrix` | §6.8 표. **GET**: 익명·비참여 회원·마감 판매자 200, 없는 요청 404, 401 없음. **POST**: 익명 401, 비참여 회원·마감 판매자 404 본문 == 없는 요청 404 본문 |
| RV5 | `test_review_validation` | rating 0·6·`"5"`·`4.5`·`true`·`null`·누락 422(`fields.rating`), body 1자·501자·공백만·비문자열·NUL 422(`fields.body`), `revieweeId` 등 추가 필드 422, 경계값(rating 1·5, body 2자·500자) 201, trim 저장 |
| RV6 | `test_review_post_is_idempotent_for_same_content` | 같은 내용 재전송 200, 같은 `id`, 행 1개. 앞뒤 공백만 다른 본문도 200 |
| RV7 | `test_second_review_with_different_content_conflicts` | 409 `ALREADY_REVIEWED`, 저장된 후기 불변 |
| RV8 | `test_reviews_are_public_without_identity` | 양쪽 작성 후 익명·비참여 회원·마감 판매자의 GET: 200, `items` 2건(`buyer` → `seller` 순, 작성 순서를 바꿔도 같음), 각 항목의 **키 집합이 정확히 `reviewerRole`·`rating`·`body`·`createdAt`**, `viewerRole=null`·`canWrite=false`·`mine=null`·`received=null`. **세 시점의 응답 본문이 서로 동일.** 구매자·확정 판매자를 포함한 모든 시점의 GET 응답 전체에 구매자·판매자의 user id, 원문 이메일, 마스킹 이메일, 후기 id 문자열 부재 |
| RV8b | `test_reviews_visible_immediately` | 구매자만 작성한 직후 익명 GET `items` 1건(`buyer`), 판매자 작성 직후 2건. 새로고침 외 조건 없음 |
| RV8c | `test_optional_auth_on_public_reviews` | 쿠키 없음·위조 토큰·만료 세션 쿠키의 GET이 모두 익명과 같은 200 본문이고 `Set-Cookie` 가 없다 |
| RV8d | `test_existing_endpoints_gain_no_review_fields` | 요청 상세·목록·지원 목록 응답의 키 집합이 0006과 같다(`rating`·`review`·`reviews` 키 없음, D14). 익명·비참여 회원의 지원 목록에 확정 판매자 정보가 여전히 없다(K10) |
| RV9 | `test_db_constraints_on_reviews` (`rollback_connection`, 실패 INSERT만) | `ck_reviews_rating`, `ck_reviews_body_len`, `ck_reviews_role`, `ck_reviews_not_self`, `uq_reviews_request_reviewer`, `uq_reviews_request_role` 위반 이름 일치 |
| RV10 | `test_review_endpoints_no_store_origin_and_503` | 두 엔드포인트 `no-store`(익명 GET 포함), POST의 Origin 403·415, GET·POST 503(`FailingSession`), 로그에 본문 문자열 부재(`caplog`) |

**백엔드 — `backend/tests/test_completion_concurrency.py`** (06 §10의 헬퍼·제한 시간 규칙 그대로)

| # | 테스트 | 기대 |
| --- | --- | --- |
| TC-C1 | `test_concurrent_complete_is_idempotent` | S2, K=8 스레드 전부 200, 같은 `completedAt` |
| TC-C2 | `test_complete_racing_match_on_open_request` | S3, 5회 반복(매번 새 요청) |
| TC-C3 | `test_send_waits_for_complete_then_rejected` | 제어 커넥션이 자기 요청의 확정 지원 행 `FOR UPDATE` + 요청 `UPDATE status='completed', completed_at=clock_timestamp()`(미커밋) → 전송 Lock 대기 관측 → COMMIT → 409 `CHAT_ROOM_CLOSED`, 0행. **§5.2 (2b)가 없으면 201이 되어 실패한다** |
| TC-C4 | `test_complete_waits_for_in_flight_send` | `lock_for_send` 반환 직후 훅으로 정지 → 완료 스레드 시작 → 완료 Lock 대기 관측 → release → 전송 201, 완료 200, 그 메시지가 저장되어 있다(완료가 전송 커밋을 기다렸음은 Lock 대기 관측으로 확인). 추가로, 완료의 Lock 대기를 관측한 뒤 release 전에 제어 커넥션으로 읽은 `clock_timestamp()` 값 T에 대해 저장된 `completed_at ≥ T` 이다 — §5.1 (3a)가 **잠금 뒤** 캡처임을 고정하는 단정이며(`now()` 구현이면 실패) 커밋 순서 증명은 아니다 |
| TC-C5 | `test_concurrent_sends_and_complete_leave_no_late_message` | 전송 스레드 4개 × 10건 + 완료 1건 동시. 응답은 201 또는 409뿐, 201 수 = 저장 행 수, `seq` 연속(09 I5), 완료 200을 받은 뒤 시작한 전송은 전부 409(R-I6) |
| TC-C6 | `test_concurrent_same_review_single_row` | S6, K=8 |
| TC-C7 | `test_concurrent_different_reviews_single_winner` | S7 |
| TC-C8 | `test_buyer_and_seller_review_concurrently` | S8 |
| TC-C9 | `test_complete_lock_timeout_returns_503` | `application_lock_timeout_ms=300`, 제어 커넥션이 요청 행 `FOR UPDATE` 유지 → 503, 상태 불변 → 해제 후 재시도 200 |

**백엔드 — `backend/tests/test_migration_0007.py`**

| # | 테스트 | 기대 |
| --- | --- | --- |
| MG1 | `test_0007_revision_chain` | `revision`·`down_revision` 값, head 1개, id ≤ 32자 |
| MG2 | `test_0007_offline_sql` | `ADD COLUMN IF NOT EXISTS completed_at`, `CREATE TABLE IF NOT EXISTS app_private.reviews`, 인덱스 2개 포함. `DELETE FROM`·`TRUNCATE`·`UPDATE`·`ALEMBIC_VERSION` 부재(FK의 `ON DELETE CASCADE` 는 허용). `DROP` 은 `DROP CONSTRAINT IF EXISTS ck_purchase_requests_status` 1회뿐 |
| MG3 | `test_0007_objects_exist_after_upgrade` (읽기 전용) | 컬럼, CHECK 정의에 `completed` 포함, §4의 제약·인덱스 이름 전부 |
| MG4 | `test_models_and_db_have_no_index_drift` | 기존 테스트가 0007 이후에도 통과(B-15) |
| MG5 | `test_existing_requests_remain_valid` (읽기 전용) | 이 테스트가 `completed_at` 미지정으로 만든 요청이 `NULL` 이고 기존 status 값 그대로 |
| MG6 | `test_0007_downgrade_is_unsupported` (오프라인, DB 미접속) | MG2와 같은 `as_sql` + `output_buffer` 컨텍스트에서 `downgrade()` 호출 → `RuntimeError`. 출력 버퍼에 `DROP`·`ALTER`·`DELETE FROM`·`UPDATE`·`TRUNCATE` 가 없다(DDL 0줄). 소스 AST에서 `downgrade` 본문의 **첫 문장이 `raise RuntimeError`** 이고 본문에 `op.` 호출이 없다 |

MG2는 **upgrade** 의 오프라인 SQL만 대상으로 한다. downgrade의 오프라인 SQL은 생성되지 않는 것이 기대값이며(MG6), `DROP TABLE … reviews`·`DROP COLUMN … completed_at` 이 어느 출력에도 나타나면 실패다.

**프론트엔드 — Vitest**

| # | 파일 | 기대 |
| --- | --- | --- |
| FE1 | `reviewsApi.test.ts` (신규) | 3개 함수의 URL·메서드·헤더·`credentials`/`cache`, 201/200 구분, 파서 실패 `INTERNAL_ERROR`(rating 범위 밖, `items` 3건 이상, 항목 필드 누락, 모르는 `viewerRole` 포함), `viewerRole: null`·`mine: null` 응답 파싱 성공, 409 보정, 새 code 전달 |
| FE2 | `requestsApi.test.ts`, `applicationsApi.test.ts`, `chatApi.test.ts` | `completed` status·chatStatus 파싱 성공(5곳 가드) |
| FE3 | `CompleteTransactionButton.test.tsx` (신규) | 확인 2단계, 진행 중 비활성, 성공 `router.refresh`, 409·403·401·503 처리 |
| FE4 | `ReviewPanel.test.tsx` (신규) | §11.6 상태 표, 별점 미선택·2자 미만 제출 비활성, 카운터, **공개 안내 문구가 제출 전에 보임**, 201/200 후 카드 전환과 “공개된 후기 보기” 링크, `ALREADY_REVIEWED` 재조회, 422 필드 오류, 401 이동, 실패 시 입력 유지, 별점 접근성 이름, `viewerRole: null` 이면 렌더 없음 |
| FE5 | `ChatMessagePanel.test.tsx` | `completed` 배너·입력 비활성 문구, 구매자 + `matched` 완료 버튼(판매자·`active` 에는 없음), 폴링이 `completed` 로 바꾼 순간 `router.refresh` 1회, `matched` 에서 `CHAT_ROOM_CLOSED` → `completed` |
| FE6 | `ChatRoomView.test.tsx` | `completed` 일 때만 후기 패널 렌더 |
| FE7 | `ApplicantList.test.tsx`, `ApplyPanel.test.tsx` | §11.7 |
| FE8 | Badge·`ChatRoomList.test.tsx`·`RequestList.test.tsx` | “거래완료”/“거래 완료” 라벨 |
| FE9 | `noMockData.test.ts` | 기존 규칙 유지(새 컴포넌트에 목업 데이터 없음) |
| FE10 | `PublicReviewList.test.tsx` (신규) | §11.9 상태 표: 2건·1건·0건 렌더, 역할 라벨과 별점 텍스트 대체, 이메일·id 미표시, `initial=null` 이면 마운트 시 1회 조회, 실패 시 오류 + “다시 시도”, 재시도 성공 시 목록 표시, 재시도 중 버튼 비활성 |
| FE11 | `RequestDetail.test.tsx` | `completed` 요청에서만 후기 영역 렌더(`open`·`matched`·`closed` 에는 없음), `initialReviews` 생략 시 기존 단정 그대로 통과, 익명(`viewerRole` `anonymous`) 화면에도 후기 영역이 보이고 🔒 지원 안내는 유지 |

**의도된 기존 테스트 변경**: `test_chat_messages.py` U1에 행 추가, `RequestDetail.test.tsx` 에 FE11 케이스 추가(둘 다 기존 단정 삭제 없음). 그 밖의 기존 테스트는 수정 없이 통과해야 한다.

### 13.5 UI 검증 (UI tester, 로컬 DB 데이터 보존)

계정 4개(구매자, 판매자 A·B, 제3자 — `test_ns` 표식 이메일)로 실제 서버를 띄워 확인하고 스크린샷과 결과를 `docs/verification/11-*.md` 에 남긴다. 만든 데이터는 지우지 않는다.

1. A·B 지원 → 구매자가 A 확정 → A 방에서 구매자에게만 “거래 완료” 버튼이 보인다(판매자 A 화면에는 없다).
2. 구매자가 완료 → 요청 상세·홈 목록·`/chats` 에 “거래완료” 배지, A 방 입력 비활성과 완료 배너, 후기 패널 표시.
3. 판매자 A가 방을 열어 둔 상태에서 2를 수행 → 3~5초 안에 배너·입력 비활성·후기 패널이 나타난다.
4. 구매자·판매자가 각각 후기 작성 → 작성 전에 “누구나 볼 수 있게 공개” 안내가 보인다. 새로고침 후 서로의 후기가 “상대방이 남긴 후기”에 보인다. 폼은 다시 나타나지 않는다.
5. 별점 미선택·1자 본문은 제출 비활성, 500자 초과 입력 불가.
6. **로그아웃 상태**·제3자·판매자 B(마감)가 완료된 요청 상세를 연다 → “거래 후기” 영역에 작성된 후기가 역할 라벨·별점·본문·작성일로 보이고, 후기 영역에는 작성자 이메일·id가 없으며 판매자 A의 신원은 페이지 어디에도 없다. 지원 영역의 🔒 안내는 그대로다. B의 방에는 후기 패널이 없다. 제3자·B의 `POST /api/requests/{id}/reviews` 직접 호출은 404다.
7. 구매자가 두 탭에서 완료를 연달아 누름 → 오류 없이 같은 완료 상태.
8. 모바일 폭(375px)에서 완료 확인 패널·별점·후기 폼.
9. 후기가 0건·1건·2건인 각 시점에 익명으로 요청 상세를 새로고침 → “아직 등록된 후기가 없어요.” → 1건 → 2건 순으로 즉시 반영된다. 완료되지 않은 요청 상세에는 후기 영역이 없다.
10. 후기 조회 실패 → “다시 시도” 흐름은 SSR의 후기 조회만 실패해야 나타나 수동 재현이 어렵다. FE10(단위 테스트)으로 고정하고, UI 검증에서는 정상 SSR 경로에서 콘솔 오류·hydration 경고가 없는지만 확인한다.
11. 모바일 폭(375px)에서 요청 상세의 공개 후기 목록.

---

## 14. 한계 (명시)

| # | 한계 | 이유·후속 |
| --- | --- | --- |
| X1 | 구매자가 완료를 누르지 않으면 판매자는 후기를 쓸 수 없다 | 구매자 단독 완료(A2). 판매자 완료 요청·자동 완료는 후속(H1) |
| X2 | 완료는 구매자의 선언일 뿐 실제 거래 여부를 검증하지 않는다 | 결제 기능이 없다(A3). 허위 완료 후 낮은 평점을 남길 수 있고 **이제 그 후기가 공개된다.** 다만 확정 판매자의 신원은 공개되지 않고 집계도 없어, 제3자가 특정 판매자의 평판으로 연결할 수 없다 |
| X3 | 후기는 공개되지만 사용자 단위로 모아 볼 수 없어 신뢰 판단에 쓰기 어렵다 | 승인 범위가 요청 단위 공개까지다(H4). 프로필·평점 집계는 후속. `ix_reviews_reviewee_id` 로 확장 여지를 남겼다 |
| X4 | 후기 수정·삭제·신고 불가 | D12. 공개 후기인데도 숨김 수단이 없다. 운영 삭제는 DB 작업으로만 가능. 신고·숨김은 후속으로 권장한다 |
| X5 | 완료 후 채팅 불가 | A4. 완료 뒤 연락 수단이 없다(H2) |
| X6 | 새 후기는 새로고침해야 보인다(채팅방 패널, 요청 상세 공개 목록 모두) | 알림·폴링 없음 |
| X7 | 작성자·대상의 참여자 여부는 DB가 아닌 서비스가 보장 | 트리거를 피함. R-I3 테스트로 고정 |
| X8 | 완료된 방도 열려 있으면 3초 폴링을 계속한다 | 09 X1과 같은 비용. 종료 상태 방의 폴링 중지는 후속 최적화 |
| X9 | 클라이언트 `maxLength` 는 UTF-16 단위라 이모지가 많으면 서버 한도(코드 포인트)보다 먼저 막힌다 | 기존 폼과 같은 특성. 서버가 최종 기준 |
| X10 | 0007은 downgrade할 수 없고, 완료가 1건이라도 생긴 뒤에는 0006 코드로 롤백할 수 없다 | 후기·완료 데이터 보존이 우선(§9.3). 0006 코드는 `completed` 행에서 오동작한다(§9.4). 문제는 수정 전진으로만 해결 |
| X11 | `completed_at` 은 잠금 획득 뒤·커밋 전의 DB 벽시계 값이라 커밋 순서를 증명하지 않는다 | §5.1. 순서 보장은 잠금 직렬화(§5.2)가 한다 |
| X12 | 공개 본문에 개인정보·비방이 들어갈 수 있고, SSR HTML에 포함되어 검색엔진에 수집될 수 있다 | 자유 서술 본문을 사전 검수하지 않는다. 작성 전 공개 안내(§11.6)와 일반 텍스트 렌더로만 대응한다. 색인 제외·신고는 후속 |
| X13 | 공개 후기 GET에는 레이트리밋이 없다 | 다른 공개 읽기(요청 목록·상세)와 같다. 요청당 최대 2행이라 응답 크기는 고정이다 |

---

## 15. 사람 검토 결과 (2026-10-12 승인)

사람 검토가 끝났다. H4만 초안의 권장 기본값과 다르게 결정되었고, 나머지는 권장 기본값대로 승인되었다.

| # | 질문 | 결정 (2026-10-12) | 초안 대비 |
| --- | --- | --- | --- |
| H1 | 누가 완료 처리하는가 | **구매자 단독, 1단계** | 승인(변경 없음) |
| H2 | 완료 후 채팅 | **읽기 전용**(09 예고대로) | 승인(변경 없음) |
| H3 | 후기 본문 | **필수, 2~500자** | 승인(변경 없음) |
| H4 | 후기 공개 범위 | **익명 사용자를 포함한 모두에게 공개.** 요청 상세에 표시. 작성자는 역할로만 표시(user id·이메일 없음). 프로필·평점 집계는 범위 밖 | **변경** — 초안은 “참여자 2명만”이었다 |
| H5 | 후기 수정·삭제 | **불가(불변)** | 승인(변경 없음) |
| H6 | 후기 열람 시점 | **작성 즉시 공개**(블라인드·검수 대기 없음) | 승인. H4에 따라 대상이 참여자에서 모두로 넓어졌다 |
| H7 | 후기 작성 기한 | **없음** | 승인(변경 없음) |
| H8 | 완료 버튼 위치 | **채팅방(주) + 지원자 목록의 확정 카드(보조)** | 승인(변경 없음) |
| H9 | 평점 척도 | **정수 1~5** | 승인(변경 없음) |

**H4 변경이 반영된 곳**

| 영역 | 내용 |
| --- | --- |
| API | `GET /api/requests/{id}/reviews` 가 공개(선택 인증)가 되고 `items` 가 추가되었다. `viewerRole` 은 nullable. 익명·비참여자는 `canWrite=false`, `mine`·`received` `null`(§6.2, §6.8) |
| 변하지 않은 것 | `POST …/reviews` 는 참여자 전용이고 비참여자는 404다. 완료 API·DB 스키마·마이그레이션·동시성 설계는 그대로다 |
| 프라이버시 | GET의 후기 DTO는 4개 필드뿐이고 후기 id도 없다(D15). 확정 판매자 신원 비공개(09 H4)는 유지한다(§10) |
| 화면 | 요청 상세에 공개 후기 목록(§11.9), 채팅방 `ReviewPanel` 은 참여자용으로 유지하되 공개 안내 문구를 넣는다(§11.6) |
| 테스트 | RV2~RV4·RV8~RV8d·RV10, FE1·FE4·FE10·FE11, UI 검증 4·6·9~11(§13.4, §13.5) |

---


## 16. 구현 순서 (설계 승인 이후)

1. tester: §13.1 사전 확인 → §13.2 conftest target 추가 → §13.4 RED 작성(실패 확인).
2. backend: L1~L17, `uv run pytest`(로컬 DB, 데이터 보존) 전체 통과(06·09·10 회귀 포함).
3. frontend: §11, `npm run lint`, `npm test` 통과.
4. 보안·성능 리뷰 → UI tester: §13.5, `docs/verification/11-*.md` 기록.
5. PR: develop 대상, `pr-merge` 스킬로 운영 마이그레이션(0007) 적용 절차 검토. downgrade 미지원과 완료 행 생성 후 코드 롤백 불가(§9.3·§9.4)를 배포 점검에 포함한다.
