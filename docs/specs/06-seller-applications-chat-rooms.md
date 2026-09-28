# 06. 판매자 지원 & 지원 건별 채팅방 — 동시 지원의 원자적 처리

> **사람 검토 승인 (2026-09-26)**: 사용자가 “진행해”로 본 설계와 기본값을 승인했다. tester → backend/front → ui tester 순서로 구현·검증을 진행한다.

> 기준: `curriculum.md` **4단계**("판매자 N명의 동시 지원을 병렬로 처리하고, 지원 건마다 독립된 채팅방 생성")와 2026-09-26 코드 조사.
> 대상 worktree: `/Users/hjkim/orca/workspaces/gamja-market/curriculum-04-seller-applications` (branch `hjkim-sun/curriculum-04-seller-applications`, HEAD `bab6411`). 조사한 소스는 원본 checkout(`develop` `cb7fb4b`)과 내용이 같다(`diff -rq`로 비교, 차이는 로컬 `.vercel`/`.claude` 설정뿐).
> `docs/specs`의 기존 문서는 `01`~`05`이므로 다음 순번은 `06`이다. 문서 번호와 커리큘럼 단계 번호는 서로 다르다.
> 이 문서는 승인된 **구현 계약**이다. 최초 설계 시에는 읽기 전용 조사만 수행했으며, 승인 후 구현·검증 결과는 [검증 기록](../validation/06-seller-applications.md)에 별도로 남긴다.
>
> **사람 검토 게이트**: 사람 검토 대상은 **이 문서 전체**다. 검토를 통과하면 tester(RED) → backend/front → ui tester 순서로 넘긴다. 별도의 개별 승인 게이트는 없다. 기존 테스트의 안전한 전환(9.4)과 형제 worktree와의 통상적인 마이그레이션 호환 절차(8장)는 **이미 승인된 기술 선택**으로 확정해 반영했다. 14장에는 제품 동작의 **권장 기본값**을 표시해 두었으며, 검토자가 바꾸지 않으면 그대로 구현한다.
>
> **보정(2026-09-26, 코디네이터 후속 지시 반영)**: (1) 테스트는 롤백 트랜잭션 안에서도 **DELETE를 실행하지 않는다**. cascade는 읽기 전용 FK 메타데이터와 오프라인 SQL로만 검증한다. (2) 세션 `run_ns` 아래에 테스트별 `test_ns`를 둔다. (3) 불변식 검사는 테스트가 소유한 요청 id로만 범위를 한정한다. (4) 잠금 대기는 `pg_blocking_pids`로 관측하거나 실제 잠금 획득 지점에서 명시적으로 동기화해 증명한다(제한 시간 있음). (5) H1·H7은 결정 게이트가 아닌 확정 사항이다.

---

## 0. 한눈에 보기

| 항목 | 결정 |
| --- | --- |
| 새 테이블 | `app_private.seller_applications`(지원), `app_private.chat_rooms`(지원 1건당 방 1개) |
| 기존 테이블 변경 | `purchase_requests`에 **제약 1개만 추가**(`uq_purchase_requests_id_buyer`). 컬럼 변경·삭제는 없다 |
| 중복 지원 방지 | DB `UNIQUE (request_id, seller_id)` + `INSERT … ON CONFLICT DO NOTHING` → 409 `ALREADY_APPLIED` |
| 본인 요청 지원 금지 | 서비스 검사(403 `SELF_APPLICATION_FORBIDDEN`) + DB `CHECK (seller_id <> buyer_id)`(복합 FK로 `buyer_id` 정합성 보장) |
| 원자성 | 지원 INSERT와 채팅방 INSERT를 **한 트랜잭션**에서 수행하고 한 번만 commit한다. 중간 실패 시 둘 다 남지 않는다 |
| 동시성 | 요청 행에 `SELECT … FOR SHARE`(지원자끼리는 막지 않고, 상태 변경과는 직렬화), `lock_timeout` 적용 |
| 권한 | 지원 상세(제시가·메시지·방 id)는 **구매자와 해당 판매자만** 볼 수 있다. 공개 정보는 `applicantCount`뿐이다. 채팅방은 참여자만 볼 수 있으며, 그 밖의 사용자에게는 404를 반환한다 |
| 새 API | `POST/GET /api/requests/{requestId}/applications`, `GET /api/chat-rooms/{roomId}` |
| 새 화면 | 상세 하단 지원 패널·지원 폼, 구매자용 지원자 목록, `/chats/[roomId]` 채팅방 셸(메시지 입력 없음) |
| 마이그레이션 | revision `0003_seller_applications`(24자, `down_revision=0002`), 추가(additive)만 허용. 형제 photo revision과 **branch 공존**. stamp/downgrade/reset 금지(8장) |
| 테스트 DB | 로컬 공유 DB를 그대로 쓴다. **TRUNCATE·DELETE·DROP 실행 금지**(롤백 트랜잭션 안에서도 금지). 테스트별 namespace(`run_ns`/`test_ns`)가 붙은 데이터만 사용한다. cascade는 읽기 전용 FK 메타데이터로 검증한다. 롤백은 실패했거나 커밋하지 않은 INSERT의 원자성 검증에만 쓴다(9장) |
| 포트 | item4 = frontend **3104** / backend **8104** (item5 = 3105/8105) |

---

## 1. 목표와 범위

### 1.1 이 단계에서 하는 것

- 로그인한 회원이 **남의** `open` 구매요청에 판매자로 지원한다(제시가 + 짧은 메시지).
- 지원 1건이 생성될 때 **그 지원 전용 채팅방 1개**를 같은 트랜잭션에서 만든다. 방은 지원과 1:1이며 다른 지원과 공유하지 않는다.
- 판매자 N명이 같은 요청에 **동시에** 지원해도 N건 모두 성공하고, 방도 N개가 된다.
- 같은 판매자의 중복 제출(더블클릭·재시도·병렬 요청)은 정확히 1건만 성공한다.
- 구매자 본인의 요청에는 지원할 수 없다.
- 구매자는 상세 화면에서 지원자 목록(제시가·메시지·채팅방 링크)을 보고, 판매자는 자기 지원과 방 링크를 본다. 제3자는 지원자 수만 본다.
- 목록·상세의 `applicantCount`를 실제 집계로 바꾸고, `sort=applicants`에 실제 의미를 부여한다.
- 채팅방 페이지는 **참여자 확인과 방 메타데이터 표시까지만** 구현한다(6단계에서 메시지가 들어올 자리).
- 공유 로컬 DB를 보존하는 테스트 인프라로 교체한다(9장). 코디네이터 지시에 따라 구현 전 필수 선행 작업이다.

### 1.2 이 단계에서 하지 않는 것 (Out of Scope)

| 기능 | 담당 |
| --- | --- |
| 사진 업로드, Supabase Storage, `thumbnail_url` 채우기 | 5단계(item5, 형제 worktree `curriculum-05-request-photos`) |
| 채팅 메시지 송수신, 폴링, 읽음 표시, 채팅 목록(inbox) | 6단계(item6) |
| 구매자의 판매자 확정, 요청 `matched`/`closed` 전이, 다른 지원 자동 마감 | 7단계(item7) |
| 지원 수정·철회, 지원 상태 컬럼(`status`) | 7단계 이후에 필요할 때 추가 컬럼으로 도입한다 |
| 거래 완료·후기 | 8단계 |
| 판매자 프로필(닉네임·지역) | 없음. 회원 정보는 이메일뿐이므로 마스킹 이메일을 쓴다 |
| CORS 미들웨어 | 추가하지 않는다. 브라우저는 동일 출처 `/api/*` rewrite만 사용한다(12.2) |

이 단계는 요청 상태를 바꾸는 API를 만들지 않는다. `status != 'open'` 거부 규칙은 두지만, 테스트에서는 **테스트가 만든 요청**의 상태를 원시 SQL로 바꿔 그 규칙을 검증한다.

---

## 2. 현재 코드 근거 (관찰한 소스)

### 2.1 백엔드

| 위치 | 관찰 | 이 설계의 결정 |
| --- | --- | --- |
| `backend/app/db/models.py:46-80` | `PurchaseRequest`는 `app_private` 스키마를 쓰고 `status IN ('open','matched','closed')` CHECK가 있다. `buyer_id`는 `users.id`를 참조하며 `ON DELETE CASCADE`다 | 새 모델 `SellerApplication`, `ChatRoom`을 같은 스키마·명명 규칙(`ck_`/`uq_`/`ix_`)으로 **파일 끝에 추가**한다 |
| `backend/app/db/session.py:10-12` | `NullPool`, `autoflush=False`, `expire_on_commit=False`. 요청마다 새 커넥션을 연다 | 동시 요청 N개는 PG 커넥션 N개가 된다. 테스트의 N 상한은 `max_connections=100`(읽기 확인)보다 충분히 작게 둔다 |
| `backend/app/api/deps.py:40-46` | `require_auth_post_request`: Origin 허용 목록과 `X-Requested-With: gamja-market`, `application/json`을 검사한다 | 지원 POST에 그대로 적용한다 |
| `backend/app/api/deps.py:49-95` | `get_current_user`(401과 쿠키 만료 처리), `get_optional_user`(공개 조회용) | POST와 채팅방 GET은 `get_current_user`, 지원 목록 GET은 `get_optional_user`를 쓴다 |
| `backend/app/main.py:19-24` | `/api/auth/`, `/api/requests` 경로에 `Cache-Control: no-store`를 붙인다 | `/api/chat-rooms`도 이 prefix 목록에 추가한다. 새 라우터도 `_no_store`를 호출한다 |
| `backend/app/main.py:35-60` | 422 필드 메시지 맵을 **경로 prefix로** 고른다. `/api/requests`로 시작하면 요청 필드 맵을 쓴다 | `/api/requests/{id}/applications`도 이 prefix에 걸리므로, 지원 경로용 맵(`offerPrice`, `message`)을 먼저 분기해야 한다(6.6) |
| `backend/app/api/errors.py:7-18` | `ERROR_MESSAGES`에 없는 code는 `KeyError`를 일으킨다 | 새 code 3개를 추가한다(6.5) |
| `backend/app/services/auth.py:30-33` | `IntegrityError`의 `sqlstate`와 `diag.constraint_name`으로 unique 위반을 분류한다 | 지원 서비스도 같은 방식으로 제약 이름을 분류한다 |
| `backend/app/core/db_logging.py` | DSN 없이 작업명·SQLSTATE·분류만 로그에 남긴다 | `log_database_failure("apply_to_request", …)`를 재사용한다 |
| `backend/app/schemas/requests.py:86` | `applicant_count: Literal[0] = 0` | `int`(≥0)로 바꾼다 |
| `backend/app/services/requests.py:38` | `"applicant_count": 0` 상수 | 집계 값을 사용한다 |
| `backend/app/repositories/requests.py:76-78` | `applicants` 정렬이 `latest`로 폴백한다(주석: "applicants table 도입 전까지") | 집계 기준 정렬을 구현한다(6.4) |
| `backend/migrations/env.py:12` | Alembic은 `get_settings().migration_database_url`을 쓴다 | 테스트 마이그레이션 대상은 9.2에서 강제한다 |
| `backend/app/core/config.py:17,59-60` | `MIGRATION_DATABASE_URL`이 없으면 `DATABASE_URL`을 쓴다 | — |
| **`backend/.env`(대상 worktree, 값은 비공개)** | `DATABASE_URL` host=`127.0.0.1`(로컬 docker)이지만 **`MIGRATION_DATABASE_URL` host=Supabase pooler**다 | **위험.** 현재 `conftest.py`의 `migrate_database`가 `alembic upgrade head`를 실행하므로 pytest가 **운영 Supabase에 DDL을 적용**할 수 있다. 9.2의 가드가 필수다 |
| `backend/tests/conftest.py:16-19` | 세션 autouse `migrate_database` → `command.upgrade(config, "head")` | 가드 추가, `head` 대신 명시 revision(8.4) |
| `backend/tests/conftest.py:22-38` | 테스트마다 autouse `TRUNCATE auth_sessions, users, purchase_requests CASCADE` | **AGENTS.md "검증 DB 데이터 보존" 위반.** 새 테이블도 FK CASCADE로 함께 지워진다. 9장에서 교체한다 |
| `backend/tests/test_requests.py:601-627` | `test_migration_0002_upgrade_and_downgrade`가 **공유 DB에서 downgrade**(테이블 DROP)한다 | 0003이 생기면 downgrade가 지원·채팅방 데이터까지 DROP한다. 오프라인 SQL 검증으로 교체한다(9.5) |
| `backend/tests/test_requests.py:509-523` | 회원 행을 실제로 DELETE해 cascade를 검증한다 | DELETE 실행 없이 읽기 전용 FK 메타데이터 검사로 교체한다(9.4) |
| `backend/tests/test_auth.py:7,45` | 고정 이메일 `buyer@example.com` | 데이터를 보존하면 두 번째 실행부터 409가 난다. namespace 이메일로 바꾼다 |

### 2.2 프론트엔드

| 위치 | 관찰 | 결정 |
| --- | --- | --- |
| `frontend/src/app/requests/[id]/page.tsx:39-40` | `const applicants: Applicant[] = []`와 "4단계" 주석 | SSR에서 `listApplications`를 호출한다(11.3) |
| `frontend/src/features/requests/components/RequestDetail.tsx:73-82` | "판매자 지원 기능은 4단계에서 열립니다." 문구와 비활성 "지원하기 · 준비 중" 버튼 | `ApplyPanel`로 교체한다(11.4) |
| `frontend/src/features/requests/components/ApplicantList.tsx:16,37-38` | 제목에 `applicants.length`를 쓰고, `seller.nickname`과 `seller.region`을 표시한다 | 제목은 `applicantCount`, 판매자는 `maskedEmail`로 바꾸고 채팅방 링크를 추가한다 |
| `frontend/src/types/request.ts:5-10,49-57` | `UserSummary{nickname,region}`, `Applicant` "타입만 남긴다" | `MaskedUser{id,maskedEmail}`로 교체하고 `Applicant`를 API 계약에 맞춘다 |
| `frontend/src/lib/api/http.ts:7-19` | `KNOWN_ERROR_CODES`에 없는 code는 상태 코드 폴백으로 바뀐다 | 새 code 3개를 추가한다 |
| `frontend/src/lib/api/http.ts:40` | `fallbackCode(409)` → `EMAIL_ALREADY_EXISTS` | 본문이 정상이면 영향이 없다. 다만 지원 API 클라이언트는 본문 파싱 실패 시 409를 `INTERNAL_ERROR`로 처리한다(11.2) |
| `frontend/src/lib/api/http.ts:114` | `postInit`이 `X-Requested-With`와 JSON 헤더를 붙인다 | 재사용한다 |
| `frontend/src/lib/api/serverBase.ts` | SSR 절대 origin: 로컬 `BACKEND_API_ORIGIN`, Vercel `BACKEND_SERVICE_ORIGIN` | 채팅방·지원 SSR 호출에 재사용한다 |
| `frontend/next.config.ts:30` | rewrite `/api/:path*` → `BACKEND_API_ORIGIN` | `/api/chat-rooms`도 자동으로 프록시되므로 변경하지 않는다 |
| `frontend/src/features/requests/components/RequestCard.tsx:58` | "지원 {applicantCount}명" | 변경 없음. 실제 값이 들어온다 |
| `frontend/src/features/requests/components/RequestFilterBar.tsx:79` | "지원자 많은순" 옵션 | 변경 없음. 서버 정렬이 실제로 동작한다 |
| `frontend/tests/RequestDetail.test.tsx:49-52` | 0건 정직 표시 테스트 | 새 prop 구조에 맞게 수정하되 의미(가짜 판매자 없음)는 유지한다 |

### 2.3 실행 환경 (읽기 전용 확인, 2026-09-26)

- `docker-compose.yml`: `postgres:16-alpine`, 컨테이너 `gamja-market-postgres`, 호스트 5432. `default_transaction_isolation=read committed`, `max_connections=100`.
- 로컬 DB `alembic_version` = `0002_create_purchase_requests`(한 행). `users` 0행, `purchase_requests` 0행(기존 TRUNCATE 테스트의 흔적으로 보인다).
- `scripts/service.py`: `--frontend-port`/`--backend-port`(317-318행), frontend 프로세스에 `BACKEND_API_ORIGIN=http://127.0.0.1:{backend_port}` 주입(276행), 상태 파일은 worktree별 `scripts/.state/`(22행). 기동 확인은 `http://127.0.0.1:{frontend_port}/api/auth/me`로 한다(353행). **대상 worktree에도 `scripts/`가 존재함을 확인했다.**
- 대상 worktree에는 `backend/.venv`와 `frontend/node_modules`가 **없다**. 구현 전에 `uv sync`와 `npm ci`가 필요하다(DB 변경 없음).
- 대상 `backend/.env`의 `AUTH_ALLOWED_ORIGINS`는 `["http://localhost:3000"]`뿐이다. 3104 포트로 접속하려면 실행 시 환경 변수로 덮어써야 한다(12.2).

---

## 3. 핵심 설계 결정

| # | 결정 | 이유 |
| --- | --- | --- |
| D1 | 지원과 채팅방을 **별도 테이블**로 두고 1:1(`chat_rooms.application_id UNIQUE`)로 연결한다 | 커리큘럼의 "지원 건마다 독립된 채팅방"을 그대로 반영한다. 6단계 메시지는 `room_id`만 FK로 잡으면 된다 |
| D2 | 두 INSERT를 **한 트랜잭션, 두 문장**으로 실행한다 | 원자성은 트랜잭션이 보장한다. 두 문장 사이에 장애를 주입할 수 있어 롤백을 실제 PG로 검증할 수 있다. 단일 CTE(`WITH app AS (INSERT…) INSERT INTO chat_rooms…`)도 검토했으나 중간 실패 주입 테스트가 어려워 채택하지 않았다 |
| D3 | 중복은 `UNIQUE(request_id, seller_id)`와 `ON CONFLICT ON CONSTRAINT … DO NOTHING RETURNING`으로 판정한다 | 애플리케이션의 "먼저 조회 후 삽입"은 경쟁 조건에 취약하다. 같은 키의 두 번째 트랜잭션은 PG unique 인덱스에서 첫 트랜잭션의 종료를 기다린다. 첫 트랜잭션이 commit되면 두 번째는 409, rollback되면 두 번째가 201이 된다. 예외 대신 결과 행 유무로 분기하므로 트랜잭션이 aborted 상태가 되지 않는다 |
| D4 | 요청 행을 `FOR SHARE`로 잠근다 | 지원자끼리는 호환되는 잠금이라 N명이 병렬로 진행된다. 반면 7단계의 상태 `UPDATE`(FOR NO KEY UPDATE)와는 충돌하므로 "open 확인 → 삽입" 사이에 마감이 끼어들 수 없다. READ COMMITTED에서 대기 후 최신 행을 다시 읽으므로 기다린 뒤 `closed`를 보게 된다 |
| D5 | `SET LOCAL lock_timeout`(기본 5000ms, 설정 `APPLICATION_LOCK_TIMEOUT_MS`) | 잠금이 오래 유지돼도 요청이 무한 대기하지 않게 한다. 초과 시 SQLSTATE `55P03`이며 503 `SERVICE_UNAVAILABLE`로 처리한다 |
| D6 | `seller_applications`에 `buyer_id`를 **비정규화**하고 복합 FK `(request_id, buyer_id) → purchase_requests(id, buyer_id)`와 `CHECK (seller_id <> buyer_id)`를 둔다 | 본인 지원 금지를 트리거 없이 DB 불변식으로 만든다. 채팅방 권한 확인도 `chat_rooms ⋈ seller_applications` 한 번의 조인으로 끝나 6단계 폴링 비용이 작다. 대가로 `purchase_requests`에 `UNIQUE(id, buyer_id)` 제약 1개를 추가한다(H6) |
| D7 | 채팅방 참여자 판정은 `seller_applications.buyer_id / seller_id`로 한다(`chat_rooms`에 참여자 컬럼 없음) | 참여자 정보 중복을 없애 불일치 가능성을 막는다 |
| D8 | 중복 지원은 **409 `ALREADY_APPLIED`**(멱등 200 아님) | "정확히 1건만 201"을 테스트로 고정하기 쉽다. 프론트는 409를 받으면 `router.refresh()`로 기존 방 링크를 보여준다(H2) |
| D9 | 참여자가 아닌 사용자의 채팅방 조회는 **404 `NOT_FOUND`**(403 아님) | 방 id의 존재 여부를 드러내지 않는다. 존재하지 않는 id와 응답을 구별할 수 없다(H3) |
| D10 | 지원 목록 GET은 **선택 인증**이며, 보는 사람에 따라 결과 범위가 달라진다 | 익명 사용자와 비참여자에게도 200을 주되 `items: []`만 반환한다. SSR 상세 페이지가 401 분기 없이 한 번에 렌더할 수 있다. 공개되는 수치는 `applicantCount`뿐이다 |
| D11 | `applicant_count`는 **컬럼이 아닌 집계**(상관 서브쿼리 `COUNT`)로 구한다 | `purchase_requests` 컬럼을 바꾸지 않으므로 형제 worktree와의 충돌 면적이 작다. `(request_id, seller_id)` unique 인덱스의 선두 컬럼으로 집계한다. 비정규화 카운터는 동시 갱신 경합을 만든다 |
| D12 | 제시가(`offerPrice`)는 구매자 희망가 범위에 묶지 않는다(0~10억 정수) | 협상 여지를 둔다. UI는 범위를 벗어나면 안내 문구만 보여준다(H4) |
| D13 | 지원 메시지는 trim 후 **2~500자** | 기존 description(10~1000자)보다 짧은 제안 메모다(H5) |
| D14 | 채팅방 화면에는 **메시지 입력 UI를 만들지 않는다** | 6단계 범위다. "메시지 기능은 6단계에서 열립니다." 안내만 둔다 |

---

## 4. DB 스키마

### 4.1 `app_private.seller_applications`

| 컬럼 | 타입 | 제약 |
| --- | --- | --- |
| `id` | `uuid` | PK, 앱에서 `uuid4` 생성 |
| `request_id` | `uuid` | NOT NULL |
| `buyer_id` | `uuid` | NOT NULL. 요청의 구매자 복사본이며 복합 FK로 일치를 강제한다 |
| `seller_id` | `uuid` | NOT NULL, FK `app_private.users(id)` `ON DELETE CASCADE` |
| `offer_price` | `integer` | NOT NULL |
| `message` | `text` | NOT NULL |
| `created_at` | `timestamptz` | NOT NULL, `server_default now()` |

제약·인덱스 (이름은 계약이며 테스트가 검사한다):

| 이름 | 정의 |
| --- | --- |
| `fk_seller_applications_request_buyer` | `FOREIGN KEY (request_id, buyer_id) REFERENCES app_private.purchase_requests (id, buyer_id) ON DELETE CASCADE` |
| `fk_seller_applications_seller` | `FOREIGN KEY (seller_id) REFERENCES app_private.users (id) ON DELETE CASCADE` |
| `uq_seller_applications_request_seller` | `UNIQUE (request_id, seller_id)` — 중복 지원 방지이자 요청별 집계 인덱스 |
| `ck_seller_applications_not_self` | `CHECK (seller_id <> buyer_id)` |
| `ck_seller_applications_offer_price` | `CHECK (offer_price BETWEEN 0 AND 1000000000)` |
| `ck_seller_applications_message_len` | `CHECK (char_length(btrim(message)) BETWEEN 2 AND 500)` |
| `ix_seller_applications_request_created` | `(request_id, created_at, id)` — 구매자용 목록 정렬 |
| `ix_seller_applications_seller_id` | `(seller_id)` — 판매자 본인 지원 조회와 회원 삭제 cascade |

### 4.2 `app_private.chat_rooms`

| 컬럼 | 타입 | 제약 |
| --- | --- | --- |
| `id` | `uuid` | PK, 앱에서 `uuid4` 생성 |
| `application_id` | `uuid` | NOT NULL, FK `seller_applications(id)` `ON DELETE CASCADE` |
| `created_at` | `timestamptz` | NOT NULL, `server_default now()` |

| 이름 | 정의 |
| --- | --- |
| `fk_chat_rooms_application` | 위 FK |
| `uq_chat_rooms_application` | `UNIQUE (application_id)` — 지원 1건당 방 1개 |

### 4.3 `app_private.purchase_requests` 추가 제약

| 이름 | 정의 | 비고 |
| --- | --- | --- |
| `uq_purchase_requests_id_buyer` | `UNIQUE (id, buyer_id)` | 복합 FK의 참조 대상이다. `id`가 이미 PK이므로 의미상 항상 참이다. 기존 행에 대한 검증이 실패할 수 없다. 컬럼 변경은 없다 |

### 4.4 불변식 (테스트로 고정)

1. 지원 1건에는 채팅방이 **정확히 1개** 있다: `seller_applications LEFT JOIN chat_rooms` 결과 `room IS NULL`이 0건이다(D2의 트랜잭션이 보장하고, 4.2의 UNIQUE가 2개 이상을 막는다).
2. 어떤 지원도 `seller_id = buyer_id`가 아니다.
3. `(request_id, seller_id)`는 전역에서 유일하다.
4. `seller_applications.buyer_id`는 항상 요청의 `buyer_id`와 같다.
5. 지원을 만들어도 `purchase_requests.updated_at`과 `status`는 바뀌지 않는다.

### 4.5 SQLAlchemy 모델 (`backend/app/db/models.py` 끝에 추가)

```python
class SellerApplication(Base):
    __tablename__ = "seller_applications"
    __table_args__ = (
        ForeignKeyConstraint(
            ["request_id", "buyer_id"],
            ["app_private.purchase_requests.id", "app_private.purchase_requests.buyer_id"],
            ondelete="CASCADE", name="fk_seller_applications_request_buyer",
        ),
        UniqueConstraint("request_id", "seller_id", name="uq_seller_applications_request_seller"),
        CheckConstraint("seller_id <> buyer_id", name="ck_seller_applications_not_self"),
        CheckConstraint("offer_price BETWEEN 0 AND 1000000000", name="ck_seller_applications_offer_price"),
        CheckConstraint("char_length(btrim(message)) BETWEEN 2 AND 500", name="ck_seller_applications_message_len"),
        Index("ix_seller_applications_request_created", "request_id", "created_at", "id"),
        Index("ix_seller_applications_seller_id", "seller_id"),
        {"schema": "app_private"},
    )
    id, request_id, buyer_id, seller_id(FK users, name="fk_seller_applications_seller"),
    offer_price(Integer), message(Text), created_at(server_default now())


class ChatRoom(Base):
    __tablename__ = "chat_rooms"
    __table_args__ = (UniqueConstraint("application_id", name="uq_chat_rooms_application"), {"schema": "app_private"})
    id, application_id(FK seller_applications.id ondelete CASCADE, name="fk_chat_rooms_application"), created_at
```

`PurchaseRequest.__table_args__`에 `UniqueConstraint("id", "buyer_id", name="uq_purchase_requests_id_buyer")`를 추가한다. 형제 worktree와 같은 줄을 편집할 수 있으므로 **튜플 맨 끝(`{"schema": …}` 바로 앞)에 한 줄만** 추가한다.

---

## 5. 동시성 · 원자성 설계

### 5.1 지원 트랜잭션 (서비스 `apply_to_request`)

```
BEGIN  (세션 첫 execute 시 자동, READ COMMITTED)
  SET LOCAL lock_timeout = '<APPLICATION_LOCK_TIMEOUT_MS>ms'
  SELECT id, buyer_id, status FROM app_private.purchase_requests
   WHERE id = :request_id FOR SHARE                                  -- (1)
  └ 없음                → ROLLBACK, 404 NOT_FOUND
  └ buyer_id = seller   → ROLLBACK, 403 SELF_APPLICATION_FORBIDDEN
  └ status <> 'open'    → ROLLBACK, 409 REQUEST_NOT_OPEN
  INSERT INTO app_private.seller_applications
         (id, request_id, buyer_id, seller_id, offer_price, message)
  VALUES (...)
  ON CONFLICT ON CONSTRAINT uq_seller_applications_request_seller DO NOTHING
  RETURNING id, created_at                                           -- (2)
  └ 0행                 → ROLLBACK, 409 ALREADY_APPLIED
  INSERT INTO app_private.chat_rooms (id, application_id) VALUES (...)
  RETURNING id, created_at                                           -- (3)
COMMIT                                                               -- (4) 단 한 번
```

- 예외 처리:
  - `IntegrityError`는 제약 이름으로 분류한다. `uq_seller_applications_request_seller`는 `AlreadyApplied`(방어용), `ck_seller_applications_not_self`는 `SelfApplicationForbidden`, 나머지는 `ServiceUnavailable`이다.
  - `OperationalError`(`55P03` 포함)와 기타 `SQLAlchemyError`는 `rollback` 후 `log_database_failure` → `ServiceUnavailable`(503)로 처리한다.
  - SQLAlchemy가 아닌 예외는 잡지 않는다. `get_db`의 `db.close()`가 미완료 트랜잭션을 롤백하고, 전역 핸들러가 500을 반환한다(롤백 테스트 R3).
- 판정 우선순위: 403 `INVALID_ORIGIN` / 415 → 401 → 422(경로·본문) → 404 → 403 `SELF_APPLICATION_FORBIDDEN` → 409 `REQUEST_NOT_OPEN` → 409 `ALREADY_APPLIED` → 503. 마감된 요청에 이미 지원한 사람이 다시 제출하면 `REQUEST_NOT_OPEN`이다.
- 비밀번호 해싱처럼 오래 걸리는 작업이 없으므로 잠금 유지 시간은 밀리초 단위다.

### 5.2 잠금 호환성 근거

| 트랜잭션 A 보유 | 트랜잭션 B 요청 | 결과 |
| --- | --- | --- |
| 요청 행 `FOR SHARE`(지원 중) | 요청 행 `FOR SHARE`(다른 지원자) | **호환**. N명 병렬 진행 |
| 요청 행 `FOR SHARE` | FK 검사용 `FOR KEY SHARE`(자기 INSERT) | 호환 |
| 요청 행 `FOR SHARE` | `UPDATE purchase_requests SET status=…`(7단계·테스트) | **B 대기**. A가 commit한 뒤 상태 변경이 진행된다 |
| `UPDATE status`(미커밋) | 지원 `FOR SHARE` | **지원 대기**. 해제 후 최신 행을 재평가하므로 `closed`면 409가 된다 |
| unique 키 `(r, s)` 미커밋 INSERT | 같은 `(r, s)` INSERT | B는 A의 종료를 기다린다. A commit이면 `DO NOTHING`(409), A rollback이면 B 삽입(201) |

- 지원 트랜잭션은 잠금을 격상하지 않는다(SHARE를 UPDATE로 올리지 않음). 여러 행을 서로 다른 순서로 잠그지도 않으므로 지원자 사이에 교착(deadlock)이 생기지 않는다.
- 커넥션 예산: 요청 1건 = 커넥션 1개(NullPool). 로컬 기본 N=16, 최대 40까지 허용한다(`max_connections=100`, 형제 worktree와 공유하므로 절반 이하). 운영 Supabase Session pooler의 커넥션 상한은 이 단계의 범위가 아니며 한계로만 기록한다(14장).

### 5.3 동시성 시나리오와 기대 결과

| # | 시나리오 | 기대 |
| --- | --- | --- |
| S1 | 서로 다른 판매자 N명이 같은 요청에 동시 지원 | N×201, 지원 N건, 방 N개(모두 다른 id), `applicantCount=N` |
| S2 | 같은 판매자가 K번 동시 제출 | 정확히 1×201, (K−1)×409 `ALREADY_APPLIED`, 지원 1건, 방 1개. 500/503 없음 |
| S3 | 구매자 본인 + 판매자들 + 중복 판매자 혼합 | 구매자 403, 중복 판매자 1×201 + 나머지 409, 다른 판매자 모두 201 |
| S4 | 미커밋 상태 변경(`closed`)이 요청을 잠근 동안 지원 | 지원이 대기하고, 커밋 후 409 `REQUEST_NOT_OPEN`, 0행 |
| S5 | 지원 트랜잭션이 잠금을 보유한 동안 상태 변경 시도 | 상태 변경이 `lock_timeout` 내에 잠금을 얻지 못함(잠금 보유 증명). 지원은 201로 끝난다 |
| S6 | 같은 `(요청, 판매자)`의 미커밋 INSERT가 먼저 있음 → 선행이 ROLLBACK | 대기하던 지원이 201. 거짓 409가 없다 |
| S7 | S6에서 선행이 COMMIT | 대기하던 지원이 409 `ALREADY_APPLIED` |
| S8 | 서로 다른 요청 여러 개에 판매자들이 교차 동시 지원 | 요청별 집계가 정확하다. 한 요청의 잠금이 다른 요청을 막지 않는다 |

---

## 6. API 계약

모든 JSON은 camelCase이며(`RequestSchema` 규칙 재사용, `extra="forbid"`), 모든 응답에 `Cache-Control: no-store`를 붙인다. 오류 본문은 기존 `{"error": {"code", "message", "fields"}}`를 따른다.

### 6.1 `POST /api/requests/{requestId}/applications` — 지원하기

- 의존성: `require_auth_post_request`(Origin/`X-Requested-With`/JSON), `get_current_user`.
- 요청 본문:

```json
{ "offerPrice": 750000, "message": "구매 후 1년 사용했고 박스 포함입니다." }
```

| 필드 | 규칙 |
| --- | --- |
| `offerPrice` | `StrictInt`, 0 ≤ x ≤ 1,000,000,000 |
| `message` | `StrictStr`, 앞뒤 공백 trim 후 2~500자 |
| 그 외 | `requestId`, `sellerId`, `buyerId`, `chatRoomId`, `status` 등 모든 추가 필드는 422 |

- 성공 **201**:

```json
{
  "application": {
    "id": "uuid",
    "requestId": "uuid",
    "seller": { "id": "uuid", "maskedEmail": "se***@example.com" },
    "offerPrice": 750000,
    "message": "구매 후 1년 사용했고 박스 포함입니다.",
    "chatRoomId": "uuid",
    "createdAt": "2026-09-26T10:00:00.000000Z"
  },
  "chatRoom": { "...": "6.3의 ChatRoomView" }
}
```

- 오류: 401 `UNAUTHENTICATED`, 403 `INVALID_ORIGIN`, 415 `UNSUPPORTED_MEDIA_TYPE`, 422 `VALIDATION_ERROR`(fields: `offerPrice`/`message`), 404 `NOT_FOUND`, 403 `SELF_APPLICATION_FORBIDDEN`, 409 `REQUEST_NOT_OPEN`, 409 `ALREADY_APPLIED`, 503 `SERVICE_UNAVAILABLE`.

### 6.2 `GET /api/requests/{requestId}/applications` — 보는 사람별 지원 목록

- 의존성: `get_optional_user`(잘못된 쿠키는 무시하고 쿠키를 건드리지 않는다).
- 성공 **200**:

```json
{
  "viewerRole": "owner",
  "applicantCount": 3,
  "items": [ "ApplicationView (6.1의 application과 동일)" ]
}
```

| `viewerRole` | 조건 | `items` |
| --- | --- | --- |
| `owner` | 로그인 사용자 = 요청 구매자 | 전체. `created_at ASC, id ASC`(먼저 지원한 순) |
| `applicant` | 로그인 사용자가 이 요청에 지원함 | 본인 지원 1건 |
| `member` | 로그인했으나 구매자도 지원자도 아님 | `[]` |
| `anonymous` | 비로그인(또는 무효·만료 쿠키) | `[]` |

- `applicantCount`는 역할과 무관하게 같은 값이다(공개 정보).
- 페이지네이션은 두지 않는다. 한 요청의 지원 수는 이 커리큘럼 규모에서 작다고 보고, 필요해지면 이후 단계에서 `page`/`pageSize`를 추가한다(14장 한계).
- 오류: 404 `NOT_FOUND`(요청 없음), 422(`requestId` 형식 오류), 503.

### 6.3 `GET /api/chat-rooms/{roomId}` — 채팅방 메타데이터

- 의존성: `get_current_user`.
- 성공 **200** (`ChatRoomView`):

```json
{
  "id": "uuid",
  "applicationId": "uuid",
  "viewerRole": "buyer",
  "request": { "id": "uuid", "title": "아이패드 프로를 구합니다", "status": "open", "priceMin": 600000, "priceMax": 800000 },
  "buyer":  { "id": "uuid", "maskedEmail": "bu***@example.com" },
  "seller": { "id": "uuid", "maskedEmail": "se***@example.com" },
  "offerPrice": 750000,
  "applicationMessage": "구매 후 1년 사용했고 박스 포함입니다.",
  "createdAt": "2026-09-26T10:00:00.000000Z"
}
```

- `viewerRole`: `buyer` | `seller`.
- 오류: 401 `UNAUTHENTICATED`(비로그인), **404 `NOT_FOUND`(없는 방, 또는 참여자가 아님)**, 422(형식 오류), 503.
- 권한 판정은 쿼리 한 번으로 한다: `chat_rooms ⋈ seller_applications ⋈ purchase_requests ⋈ users(buyer) ⋈ users(seller) WHERE room.id = :id AND :viewer IN (a.buyer_id, a.seller_id)`. 결과가 없으면 404다. 그래서 존재 여부가 드러나지 않는다.

### 6.4 기존 엔드포인트 변경

| 엔드포인트 | 변경 |
| --- | --- |
| `GET /api/requests`, `GET /api/requests/{id}`, `POST /api/requests` | `applicantCount`가 실제 `COUNT(seller_applications)`를 반환한다(새 요청은 0) |
| `GET /api/requests?sort=applicants` | `applicant_count DESC, created_at DESC, id DESC` |
| 그 외 | 필드·오류 계약 변경 없음. `updatedAt == createdAt`(05 문서의 B20)은 지원 후에도 유지된다 |

### 6.5 새 오류 code (`backend/app/api/errors.py`, `frontend/src/types/api.ts`, `http.ts`의 `KNOWN_ERROR_CODES`)

| code | HTTP | message |
| --- | --- | --- |
| `SELF_APPLICATION_FORBIDDEN` | 403 | `본인 구매요청에는 지원할 수 없습니다.` |
| `REQUEST_NOT_OPEN` | 409 | `모집 중인 구매요청에만 지원할 수 있습니다.` |
| `ALREADY_APPLIED` | 409 | `이미 지원한 구매요청입니다.` |

`NOT_FOUND`, `UNAUTHENTICATED`, `SERVICE_UNAVAILABLE` 등은 재사용한다.

### 6.6 422 필드 메시지 (`main.py` `validation_error_handler`)

경로가 `^/api/requests/[^/]+/applications$`와 일치하면 **요청 맵보다 먼저** 아래 맵을 쓴다. `/api/chat-rooms`는 필드 없는 422(`fields: {}`)다.

| 필드 | 메시지 |
| --- | --- |
| `offerPrice` | `제시가는 0원 이상 10억원 이하의 정수로 입력해 주세요.` |
| `message` | `지원 메시지는 2자 이상 500자 이하로 입력해 주세요.` |

no-store 미들웨어 prefix 튜플에 `"/api/chat-rooms"`를 추가한다.

### 6.7 권한 규칙 요약

| 행위 | 익명 | 회원(비참여) | 구매자(소유자) | 해당 판매자 | 다른 판매자 |
| --- | --- | --- | --- | --- | --- |
| 지원 POST | 401 | 201 | 403 SELF | 409 ALREADY | 201(자기 지원) |
| 지원 목록 GET | 200 `[]` | 200 `[]` | 200 전체 | 200 본인 것 | 200 본인 것 |
| 채팅방 GET | 401 | 404 | 200 buyer | 200 seller | 404 |
| `applicantCount` | 공개 | 공개 | 공개 | 공개 | 공개 |

---

## 7. 백엔드 레이어

| 파일 | 내용 |
| --- | --- |
| `app/db/models.py` | 4.5 모델 추가 |
| `app/schemas/applications.py` (신규) | `ApplicationCreate`, `MaskedUser`, `ApplicationView`, `ApplicationListResponse`, `ChatRoomRequestSummary`, `ChatRoomView`, `ApplyResponse`, `ViewerRole` Literal. `RequestSchema`/`to_camel`을 `schemas/requests.py`에서 import한다 |
| `app/schemas/requests.py` | `applicant_count: int = Field(ge=0)` |
| `app/repositories/applications.py` (신규) | `lock_request_for_application`, `insert_application`(ON CONFLICT … RETURNING), `list_for_request(request_id, viewer_id, role)`, `count_for_request` |
| `app/repositories/chat_rooms.py` (신규) | `create_for_application`, `get_for_participant(room_id, viewer_id)` |
| `app/repositories/requests.py` | `applicant_count` 상관 서브쿼리를 select에 추가하고 `sort == "applicants"` 분기를 구현한다. `get_by_id`도 count를 반환한다 |
| `app/services/applications.py` (신규) | `apply_to_request`, `list_applications`, `get_chat_room`. 예외 `RequestNotFound`(requests 서비스의 것 재사용), `SelfApplicationForbidden`, `RequestNotOpen`, `AlreadyApplied`, `ChatRoomNotFound`. `mask_email`은 `services/requests.py`의 것을 재사용한다 |
| `app/services/requests.py` | `_summary_data`가 count 인자를 받는다 |
| `app/api/applications.py` (신규) | `router = APIRouter(prefix="/api/requests", tags=["applications"])`로 `POST/GET /{request_id}/applications`를 정의한다. 별도 `chat_rooms_router = APIRouter(prefix="/api/chat-rooms")`에 `GET /{room_id}`를 둔다 |
| `app/main.py` | 라우터 2개 include, no-store prefix 추가, 422 맵 분기 추가 |
| `app/api/errors.py` | 6.5 code 추가 |
| `app/core/config.py` | `application_lock_timeout_ms: int = Field(default=5000, ge=100, le=30000)` |

라우트 충돌 확인: `requests.py` 라우터의 `GET /{request_id}`와 새 `GET /{request_id}/applications`는 세그먼트 수가 달라 충돌하지 않는다.

---

## 8. 마이그레이션과 형제 photo worktree 호환

### 8.1 revision

- 파일: `backend/migrations/versions/0003_create_seller_applications.py`
- `revision = "0003_seller_applications"` — **24자.** `alembic_version.version_num`은 `VARCHAR(32)`이므로 32자를 넘는 id는 기록할 수 없다.
- `down_revision = "0002_create_purchase_requests"`, `branch_labels = None`, `depends_on = None`.
- `upgrade()` 순서: `op.create_unique_constraint("uq_purchase_requests_id_buyer", …)` → `create_table seller_applications`(4.1 제약 포함) → 인덱스 2개 → `create_table chat_rooms`.
- `downgrade()` 순서: `drop_table chat_rooms` → 인덱스 → `drop_table seller_applications` → `drop_constraint uq_purchase_requests_id_buyer`. **공유 DB에서는 절대 실행하지 않는다.** 검증은 오프라인 SQL로만 한다(M3).

### 8.2 추가(additive) 원칙

- 새 객체만 만든다. 기존 컬럼·제약·인덱스를 ALTER/DROP/RENAME하지 않는다. `purchase_requests`에는 제약 1개만 **추가**한다.
- 객체 이름은 `seller_applications*`, `chat_rooms*`, `uq_purchase_requests_id_buyer`로 한정한다. 형제 worktree는 이 이름을 쓰지 않아야 한다(코디네이터 공유 사항).
- 데이터 이동(backfill)은 없다. 기존 요청의 `applicantCount`는 자연히 0이다.
- `CREATE UNIQUE INDEX`는 `purchase_requests`에 짧은 SHARE 잠금을 건다. 로컬·운영 모두 행 수가 적어 무시할 수준이다.

### 8.3 공유 `alembic_version`에 형제 revision이 있을 때

**형제 설계 관찰(읽기 전용, 2026-09-26)**: `curriculum-05-request-photos/docs/specs/07-purchase-request-photos.md`(미커밋)의 계획은 다음과 같다.

- revision `0004_create_purchase_request_photos`, 개발 중 `down_revision = "0002_create_purchase_requests"`. 새 테이블 `app_private.purchase_request_photos`만 추가하고 기존 테이블은 ALTER하지 않는다. 우리 객체 이름과 겹치지 않는다.
- 공유 DB에는 `ensure_additive_schema`로 멱등 DDL(`IF NOT EXISTS`)을 적용하며 **`alembic_version`을 읽지도 쓰지도 않는다.**

따라서 형제 쪽 작업만으로는 공유 `alembic_version`이 `{0002}` 또는 우리가 올린 `{0003_seller_applications}`로 남는다. 아래의 "모르는 revision" 상황은 **예외 경로**다. 누군가 photo revision을 공유 DB에 기록한 경우에만 필요하다. 이 문서의 가드는 두 경우를 모두 처리한다.

⚠️ **형제 revision id 길이 문제(코디네이터 전달 필요)**: `0004_create_purchase_request_photos`는 **35자**다. `alembic_version.version_num`은 `VARCHAR(32)`이므로 병합 후 `alembic upgrade`가 이 id를 기록하는 순간 `value too long` 오류로 실패한다(운영 Supabase 포함). 형제 설계에서 32자 이하로 줄여야 한다(예: `0004_request_photos`). 이 worktree는 형제 파일을 수정하지 않는다.

Alembic은 `alembic_version`의 모든 행을 **자기 스크립트 디렉터리에서 찾을 수 있어야** 동작한다. 형제 photo worktree가 먼저 `0003_<photo>`(가칭)를 공유 DB에 적용하면 `alembic_version = {0003_<photo>}`가 된다. 이 worktree의 Alembic은 그 revision 파일을 모르므로 `upgrade`가 `Can't locate revision` 오류로 멈춘다. 이때 금지하는 조치와 허용하는 조치는 다음과 같다.

금지: `alembic stamp`, `alembic_version` 행 UPDATE/DELETE, `downgrade`, DB reset·drop, 검증용 새 DB 생성, 형제 worktree 파일 수정.

허용하는 절차(**형제 revision 읽기 전용 참조**):

1. 현재 상태를 읽는다: `SELECT version_num FROM alembic_version`(읽기 전용).
2. 모르는 revision이 있으면 그 revision 파일을 형제에서 **읽기 전용으로 가져온다**. 커밋된 파일은 `git show hjkim-sun/curriculum-05-request-photos:backend/migrations/versions/<file>`로 읽고, 미커밋이면 형제 worktree 경로에서 읽기만 한다. 가져온 파일은 **저장소 밖**의 임시 디렉터리(예: `$TMPDIR/gamja-item4-sibling-revisions/`)에 둔다. 이 worktree에 추가하거나 커밋하지 않는다. 복사 후 sha256을 원본과 비교한다.
   - 형제의 `0001`/`0002` 파일은 가져오지 않는다. 같은 id가 두 위치에 있으면 Alembic이 거부한다.
3. `version_locations`에 두 경로를 이어서 지정한다. `alembic.ini`는 `path_separator = os`이므로 macOS 구분자는 `:`다(`migrations/versions:$TMPDIR/gamja-item4-sibling-revisions`). 그다음 **명시 target**으로 올린다: `command.upgrade(cfg, "0003_seller_applications")`.
   - 이렇게 하면 Alembic이 형제 revision을 인식한다. 공통 조상 `0002`에서 갈라진 우리 branch만 적용하고 `alembic_version`에 **행을 하나 추가**한다(Alembic의 표준 다중 head 기록이며 stamp가 아니다). 결과는 `{0003_<photo>, 0003_seller_applications}`다.
   - `head`(단수)는 head가 둘이면 오류가 나므로 쓰지 않는다. `heads`는 형제 revision까지 적용할 수 있으므로 **쓰지 않는다**(형제 스키마를 이 worktree가 바꾸면 안 된다).
4. 반대 순서(우리가 먼저 적용)면 형제 worktree가 같은 절차로 우리 파일(`0003_create_seller_applications.py`, id `0003_seller_applications`)을 참조한다. 이 파일명과 id는 **이 문서로 고정**한다.
5. 절차 2에서 파일을 얻을 수 없거나 해시가 다르면 즉시 중단하고 코디네이터에게 escalation한다. 테스트 fixture도 같은 조건에서 `pytest.exit`로 멈춘다(9.2).

### 8.4 통합(merge) 시점

- 두 branch가 모두 `0002`에서 갈라지므로 통합 후 head가 둘이 된다. **나중에 master/develop에 들어가는 PR**이 병합 revision을 추가한다: `0004_merge_item4_item5`(가칭, 32자 이하), `down_revision = ("0003_seller_applications", "<photo id>")`, DDL 없음. 이것이 통합 기본값이다(14.1 T2). 이름은 병합 PR에서 정한다.
- 병합 revision 적용 후 공유 DB의 `alembic_version`은 한 행으로 합쳐진다. 이는 `upgrade`로 수행하며 stamp가 아니다.
- 형제 설계(07)는 다른 통합 규칙을 제안한다. **나중에 병합되는 쪽이 자기 `down_revision`을 develop head로 바꿔 단일 head를 유지하는 방식**이다. 두 규칙 모두 이 설계와 호환된다.
  - photo가 나중에 병합: photo의 `down_revision = "0003_seller_applications"`. 공유 DB(`{0003_seller_applications}`)에서 `upgrade head`를 실행하면 photo DDL은 `IF NOT EXISTS`로 건너뛰고 버전만 기록된다.
  - item4가 나중에 병합: 우리 `down_revision`을 photo revision으로 바꾼다. 우리 revision이 이미 공유 DB에 기록돼 있으므로 Alembic은 photo revision을 "적용됨"(조상)으로 본다. photo 테이블은 `ensure_additive_schema`로 이미 존재하므로 스키마와 기록이 일치한다. 운영 DB는 `0002 → photo → 0003` 순서로 새로 적용된다.
  - 기본값은 병합 revision이다. 형제가 먼저 re-parent 규칙으로 병합했다면 그 결과를 따른다(14.1 T2). 한 번의 통합에서 두 규칙을 섞으면 head가 둘 남으므로 섞지 않는다.
- 운영 Supabase에는 `pr-merge` 스킬의 절차를 따라 배포 전에 별도로 적용한다. 테스트나 개발 서버가 운영 DB에 DDL을 적용하는 일은 없어야 한다(9.2의 가드).

### 8.5 한계 (명시)

- 형제 revision은 공유 DB에 적용된 뒤에는 **동결**되어야 한다. 적용 후 내용이 바뀌면 DB와 파일이 어긋나며, 이 절차로는 복구할 수 없다(escalation 대상).
- 형제 migration이 `purchase_requests`의 PK·`buyer_id`를 바꾸거나 테이블을 재생성하면 복합 FK와 충돌한다. 그 경우는 비호환이며 설계를 다시 협의해야 한다.
- 공유 DB에 `downgrade`가 필요한 상황(스키마 되돌리기)은 이 문서가 다루지 않는다. 사람 승인 없이는 수행하지 않는다.
- `alembic check`/autogenerate는 형제 테이블을 "모르는 테이블"로 볼 수 있으므로 이 단계에서 쓰지 않는다.

---

## 9. 공유 DB 영속 테스트 인프라 (구현 전 필수 선행)

AGENTS.md는 "로컬 DB를 그대로 활용하고 검증 DB는 새로 만들지 않으며, 검증했던 DB 데이터는 삭제하지 않는다"고 규정한다. 현재 `conftest.py`는 매 테스트마다 TRUNCATE하므로 이 규칙과 충돌한다. 형제 worktree가 같은 스위트를 돌리면 이 worktree의 검증 데이터(새 테이블 포함, `TRUNCATE … CASCADE`)도 사라진다. 따라서 **tester가 RED 테스트를 작성하기 전에** 아래와 같이 교체한다. 코디네이터 지시에 따라 교체 전에는 어떤 pytest도 실행하지 않는다.

### 9.1 금지 사항 (테스트 코드 전체)

- **어떤 `DELETE` 문도 실행하지 않는다.** 테스트 데이터나 롤백 트랜잭션 안이라도 마찬가지다. `TRUNCATE`, `DROP`, `alembic downgrade`, `alembic stamp`, `alembic_version` 쓰기, 새 DB/스키마 생성, 테스트 데이터가 아닌 행의 `UPDATE`도 금지한다.
- 롤백(`ROLLBACK`)은 **실패한 INSERT 또는 커밋하지 않은 INSERT의 원자성 검증**에만 쓴다. 제약 위반 INSERT, 미커밋 경쟁 INSERT(C6), 서비스 내부 실패 주입(R1~R4)이 여기에 해당한다. 잠금만 필요한 경우에는 데이터를 바꾸지 않는 `SELECT … FOR UPDATE`/`FOR SHARE`를 쓴다.
- 전역 개수·전역 불변식 단정(`count(*) == 0`, 목록 `total == 15`, "DB 전체에 방 없는 지원 0건" 등). 공유 DB에는 다른 실행, 다른 테스트, 형제 worktree의 데이터가 있다. 모든 단정은 **테스트가 소유한 id 또는 `test_ns`**로 범위를 한정한다.
- 고정 이메일·고정 제목.
- `DATABASE_URL`이나 자격 증명을 출력하는 assert 메시지·로그.

### 9.2 `conftest.py` 교체 계약

1. **마이그레이션 대상 강제**: 모듈 import 시 `Settings()`로 `database_url`을 읽고 `os.environ["MIGRATION_DATABASE_URL"]`을 그 값으로 덮어쓴 뒤 `get_settings.cache_clear()`를 호출한다. `.env`의 Supabase 값은 테스트에서 절대 쓰이지 않는다. 값은 출력하지 않는다.
2. **로컬 가드**(순수 함수 `assert_local_test_database(url) -> None`): `make_url(url).host`가 `{"127.0.0.1", "localhost", "::1"}`에 없으면 `pytest.exit("테스트 DB가 로컬이 아닙니다(host 분류: remote)", returncode=2)`. URL 자체는 메시지에 넣지 않는다. `DATABASE_URL`과 마이그레이션 URL 둘 다 검사한다.
3. **`migrate_database`(session, autouse)**: 8.3을 구현한다.
   - `cfg = Config(alembic.ini)`. 환경 변수 `GAMJA_SIBLING_REVISION_DIR`이 있으면 `version_locations = migrations/versions:<그 경로>`로 지정한다.
   - `known = {r.revision for r in ScriptDirectory.from_config(cfg).walk_revisions()}`, `current = SELECT version_num FROM alembic_version`(테이블이 없으면 빈 집합).
   - `unknown = current - known`이 비어 있지 않으면 `pytest.exit("공유 DB에 이 worktree가 모르는 revision이 있습니다: <ids>. spec 06 §8.3 절차를 따르세요(stamp/downgrade 금지)", returncode=3)`.
   - 그 외에는 `command.upgrade(cfg, "0003_seller_applications")`를 실행한다. 이미 적용돼 있으면 아무 일도 하지 않는다.
   - 분류 로직은 순수 함수 `classify_revision_state(current, known) -> Literal["ok", "unknown"]`로 분리해 DB 없이 테스트한다(M4).
4. **`clean_database` 삭제.** 대신 다음을 제공한다.
   - `run_ns`(session): `f"{time.time_ns():x}{secrets.token_hex(3)}"`. 소문자 hex만 쓰므로 LIKE 와일드카드와 이메일 규칙에 안전하다. 한 실행 전체를 식별하는 용도일 뿐 **격리 단위가 아니다.**
   - `test_ns`(function): `f"{run_ns}t{next(counter):04x}"`(영숫자만, 약 27자). **테스트마다 다른 값**이므로 같은 실행 안의 테스트끼리도 목록 `total`·정렬·집계가 섞이지 않는다. 모든 데이터 식별자는 `run_ns`가 아니라 `test_ns`에서 만든다.
   - `ns_email(test_ns, label)`: `f"t4-{test_ns}-{label}@example.com"`(로컬파트 64자 이하, `example.com`은 기존 테스트에서 통과가 확인된 도메인). 같은 테스트 안의 여러 판매자는 `label`(`seller-07` 등)로 구분한다.
   - `ns_title(test_ns, text)`: `f"[{test_ns}] {text}"`. 60자를 넘으면 `text` 쪽을 잘라 60자 이하를 보장한다.
   - 목록·검색·정렬 테스트는 항상 `q=<test_ns>`로 **그 테스트의 요청만** 조회한다. 카테고리·상태 필터와 정렬은 `q`와 조합한다.
   - `owned_request_ids`(function): 테스트가 만든 요청 id를 모으는 리스트. 불변식 단정(A22)은 이 id들로만 범위를 한정한다.
   - `rollback_connection()`: `engine.connect()` → `begin()` → yield → **항상 `rollback()`**. **실패하는 INSERT(제약 위반) 또는 커밋하지 않는 경쟁 INSERT 전용**이다. DELETE는 이 안에서도 실행하지 않는다.
   - `db_engine`(session): `create_engine(database_url, poolclass=NullPool)`. 끝에서 `dispose`한다.
   - `wait_until_blocked_by(controller_pid, timeout=5.0)`: 읽기 전용 폴링(20ms 간격) `SELECT pid, wait_event_type, wait_event FROM pg_stat_activity WHERE :controller_pid = ANY(pg_blocking_pids(pid))`. 제어 커넥션(`SELECT pg_backend_pid()`로 pid 획득)이 막고 있는 백엔드가 **실제로 PG 잠금 대기**(`wait_event_type = 'Lock'`)에 들어간 것을 관측하면 그 pid를 반환한다. 제한 시간 안에 관측하지 못하면 테스트를 실패시킨다. 조건이 제어 커넥션 pid로 한정되므로 다른 세션·형제 worktree의 활동을 오인하지 않는다.
5. 기존 `client`, `post_headers` fixture는 유지한다. `AUTH_ALLOWED_ORIGINS` `setdefault`는 그대로 둔다. 테스트 셸에서 3104용 origin을 **export하지 않는다**(12.2의 기동 명령은 인라인 환경 변수를 쓴다). export하면 `post_headers`의 `http://localhost:3000`이 거부된다.

### 9.3 데이터 표식과 보존

- 테스트가 만든 모든 회원·요청·지원·채팅방은 DB에 **남는다**. 회원 이메일과 요청 제목의 `test_ns`(앞부분은 `run_ns`)로 어느 실행의 어느 테스트가 만든 데이터인지 식별할 수 있다.
- 상태 변경 테스트(S4·A9)는 **자기가 만든 요청**의 `status`만 원시 SQL로 `closed`/`matched`로 바꾸고 커밋한다. 이는 보존 규칙상 허용되는 "테스트 데이터 준비"이며 삭제가 아니다.
- cascade 동작은 **실행하지 않고 선언으로 검증한다.** 읽기 전용 `pg_constraint` 조회(`contype = 'f'`, `confdeltype = 'c'`), `sqlalchemy.inspect().get_foreign_keys()`의 `options["ondelete"] == "CASCADE"`, 오프라인 upgrade SQL의 `ON DELETE CASCADE` 문자열을 확인한다.

### 9.4 기존 테스트 전환 표 (확정 사항, 구 H1)

아래 전환은 공유 DB를 보존하면서 회귀 검증을 하기 위해 **필수로 수행하는 확정 작업**이다. 별도 승인 없이 tester가 수행한다.

| 기존 테스트 | 문제 | 전환 |
| --- | --- | --- |
| `test_auth.py` 전체 | 고정 이메일(재실행 시 409) | `ns_email(test_ns, …)`로 바꾸고, 정규화 검사는 대소문자·공백 변형을 namespace 이메일에 적용한다 |
| `test_requests.py` B10·B11·B13·B14·B16 | 전역 `total`·순서 단정 | 제목을 `ns_title(test_ns, …)`로 만들고 `q=test_ns`로 범위를 한정한다(테스트별 격리). 카테고리·상태 필터는 `q`와 조합한다 |
| B2 `requires_authentication` | 전역 `count(*) == 0` | 그 테스트의 `test_ns` 제목을 가진 행이 0건인지 확인한다 |
| B23 `deleting_user_cascades` | 실제 DELETE | **DELETE를 실행하지 않는다.** `test_purchase_request_fk_cascades_on_user_delete`로 이름을 바꾸고, `purchase_requests.buyer_id → users.id` FK의 `ON DELETE CASCADE`를 읽기 전용 메타데이터(`pg_constraint.confdeltype = 'c'`, 인스펙터 `ondelete`)로 확인한다 |
| B24 `db_check_constraints` | `engine.begin()` 안 INSERT(실패 시 롤백되므로 데이터 영향 없음) | 실패하는 INSERT이므로 유지하되 `rollback_connection`으로 통일한다 |
| B27 `migration_0002_upgrade_and_downgrade` | 공유 DB downgrade(**0003이 생기면 지원·채팅방까지 DROP**) | 인스펙터 기반 스키마 확인 + 오프라인 SQL(`sql=True`, `output_buffer`) 검증으로 교체한다 |
| `test_database_failure_…` | DB를 건드리지 않는다 | 유지한다 |

전환 전후로 테스트의 **의미**(검증하는 계약)는 바뀌지 않아야 한다. 전환 PR 리뷰에서는 테스트 이름과 검증 절 매핑을 유지하는지 확인한다.

### 9.5 오프라인 마이그레이션 검증 방법

```python
buf = io.StringIO()
cfg = Config(str(ALEMBIC_INI), output_buffer=buf)
command.upgrade(cfg, "0002_create_purchase_requests:0003_seller_applications", sql=True)
sql = buf.getvalue()
```

`env.py`의 `run_migrations_offline`은 DB에 연결하지 않는다(`literal_binds`). downgrade도 `command.downgrade(cfg, "0003_seller_applications:0002_create_purchase_requests", sql=True)`로 생성만 한다.

---

## 10. RED 테스트 매트릭스

모든 백엔드 테스트는 실제 로컬 PostgreSQL을 대상으로 하며 9장 규칙을 따른다. 새 백엔드 테스트는 `backend/tests/test_applications.py`에 두고, 동시성 테스트는 `backend/tests/test_applications_concurrency.py`로 분리한다. 동시성 헬퍼는 다음과 같다.

- `seller_clients(n)`: 판매자 n명을 **순차** 가입시킨다(Argon2 비용 때문). 각자 독립 `TestClient` 인스턴스와 쿠키 jar를 갖는다. 인스턴스마다 자체 portal 스레드를 가지므로 요청이 실제로 병렬 처리된다.
- `fire_concurrently(calls)`: `ThreadPoolExecutor(max_workers=len(calls))` + `threading.Barrier(len(calls))`. 각 스레드가 barrier를 통과한 직후 요청을 보낸다. 반환값은 `(status, body)` 목록이다.
- N 기본값은 `GAMJA_CONCURRENCY_N=16`, 허용 범위 2~40. 각 동시성 테스트는 새 요청을 만들어 쓴다.
- 결정적 경쟁 재현에는 barrier 대신 **제어 커넥션이 잠금을 쥔 채** 대상 요청을 스레드로 보낸다. "대기 중" 판정은 **스레드 생존 여부(`thread.is_alive()`)로 하지 않는다.** 스레드가 아직 DB에 도달하지 않았을 수도 있기 때문이다. 다음 둘 중 하나로 증명하며, 모두 제한 시간(기본 5초) 안에 이루어지지 않으면 실패로 처리한다.
  1. **PG 관측**: `wait_until_blocked_by(controller_pid)`(9.2)로 제어 커넥션이 막고 있는 백엔드가 `wait_event_type = 'Lock'`(행 잠금이면 `tuple`/`transactionid`) 상태임을 관측한다. 관측 후에만 제어 커넥션을 COMMIT/ROLLBACK한다.
  2. **획득 지점 동기화**: 서비스가 잠금을 **실제로 획득한 직후**(예: `lock_request_for_application`이 반환한 직후)에 monkeypatch 훅이 `acquired.set()`을 호출하고 `release.wait(timeout=5)`로 멈춘다. 테스트는 `acquired.wait(timeout=5)`가 참이어야 다음 단계로 진행한다.
- 판정 이후 대상 스레드의 결과도 `future.result(timeout=10)`처럼 제한 시간을 두고 수거한다. 무한 대기는 없다.

### 10.1 API · 권한 (A)

| # | 테스트 | 기대 | 절 |
| --- | --- | --- | --- |
| A1 | `test_apply_creates_application_and_room` | 201. `application`/`chatRoom` 필드가 계약과 일치(camelCase, 마스킹 이메일, `chatRoomId == chatRoom.id`, `chatRoom.viewerRole == "seller"`). 응답 전문에 판매자·구매자 원본 이메일 부재. DB에 지원 1행과 방 1행, 방의 `application_id` 일치 | 6.1, 4 |
| A2 | `test_apply_requires_authentication` | 쿠키 없음 → 401, 이 요청의 지원 0행 | 6.7 |
| A3 | `test_apply_rejects_bad_origin_and_content_type` | Origin 누락·`X-Requested-With` 누락 → 403 `INVALID_ORIGIN`, `text/plain` → 415 | 6.1 |
| A4 | `test_apply_validation_boundaries` (parametrize) | `offerPrice` -1 / 1,000,000,001 / 1.5 / `"1000"` / 누락, `message` `"a"` / `"  a  "` / 501자 / 공백만 / 누락 → 422 + `fields`에 해당 키와 6.6 문구 | 6.1, 6.6 |
| A5 | `test_apply_rejects_server_controlled_fields` | 본문에 `requestId`/`sellerId`/`buyerId`/`chatRoomId`/`status` → 422 | 6.1 |
| A6 | `test_apply_boundary_values_accepted` | `offerPrice` 0과 1,000,000,000, `message` 2자·500자 → 201. `message`는 trim되어 저장 | 6.1 |
| A7 | `test_apply_unknown_and_malformed_request` | 임의 UUID → 404 `NOT_FOUND`, `not-a-uuid` → 422 | 6.1 |
| A8 | `test_apply_to_own_request_forbidden` | 구매자 → 403 `SELF_APPLICATION_FORBIDDEN`, 지원·방 0행 | 5.1 |
| A9 | `test_apply_to_non_open_request_rejected` (parametrize `closed`/`matched`) | 자기 테스트 요청의 상태를 원시 SQL로 변경 → 409 `REQUEST_NOT_OPEN`, 0행 | 5.1 |
| A10 | `test_duplicate_apply_sequential` | 두 번째 → 409 `ALREADY_APPLIED`. 원래 제시가·메시지·방 id는 그대로 | D3, D8 |
| A11 | `test_application_list_visibility_by_role` | 판매자 3명 지원. owner → 3건(먼저 지원한 순, 각 `chatRoomId`), 지원자 → 본인 1건, 비참여 회원 → `[]`/`member`, 익명 → `[]`/`anonymous`, 모든 역할에서 `applicantCount == 3`. 비참여 응답에 제시가·메시지 문자열 부재 | 6.2, 6.7 |
| A12 | `test_application_list_ignores_invalid_cookie` | 형식이 잘못된 쿠키 → 200 `anonymous`. `Set-Cookie`로 쿠키를 만료시키지 않음 | 6.2 |
| A13 | `test_chat_room_access_matrix` | 구매자 200(`buyer`), 해당 판매자 200(`seller`), 다른 판매자 404, 비참여 회원 404, 익명 401, 없는 id 404, 형식 오류 422. 비참여 404와 없는 id 404의 본문이 동일 | 6.3, D9 |
| A14 | `test_rooms_are_independent_per_application` | 같은 요청의 판매자 A·B가 서로 다른 방 id를 받음. A는 B의 방을 볼 수 없음. 구매자는 둘 다 볼 수 있음 | D1 |
| A15 | `test_applicant_count_in_list_and_detail` | 지원 2건 후 목록(`q=test_ns`)과 상세의 `applicantCount == 2`, 같은 `test_ns`의 지원 없는 요청은 0, 목록 `total`은 그 테스트의 요청 수와 일치 | 6.4 |
| A16 | `test_sort_by_applicants` | `test_ns` 요청 3개(지원 0/2/1) → `sort=applicants&q=test_ns` 순서가 2,1,0. 동률은 `created_at DESC, id DESC`. 결과에 다른 테스트의 요청이 섞이지 않음 | 6.4 |
| A17 | `test_apply_does_not_touch_request_row` | 지원 전후 `purchase_requests.updated_at`·`status` 동일 | 4.4-5 |
| A18 | `test_new_endpoints_set_no_store` | POST·목록 GET·채팅방 GET(성공·오류 모두) `Cache-Control: no-store` | 6.6 |
| A19 | `test_new_endpoints_503_without_leaking_credentials` | `FailingSession` override → 3개 엔드포인트 모두 503, 응답·로그에 비밀 문자열 부재 | 5.1 |
| A20 | `test_db_constraints_reject_invalid_rows` (`rollback_connection`, 실패하는 INSERT만) | 원시 INSERT: 자기 지원(`seller_id = buyer_id`), `buyer_id` 불일치(복합 FK), 이미 API로 만든 지원과 같은 `(request, seller)`, 가격 범위 밖, 메시지 1자, 이미 방이 있는 `application_id`로 방 추가 → 각각 `IntegrityError`, 기대 제약 이름 일치. 모든 INSERT가 실패하므로 남는 행이 없음 | 4.1-4.3 |
| A21 | `test_fk_cascade_rules_are_declared` (읽기 전용, **DELETE 실행 없음**) | `pg_constraint` 조회: `fk_seller_applications_request_buyer`·`fk_seller_applications_seller`·`fk_chat_rooms_application`의 `confdeltype = 'c'`(CASCADE), 참조 대상·컬럼 순서 일치(`(request_id, buyer_id) → purchase_requests(id, buyer_id)`). 인스펙터 `get_foreign_keys()`의 `options['ondelete'] == 'CASCADE'`. 오프라인 upgrade SQL(9.5)에 세 FK의 `ON DELETE CASCADE` 절 포함 | 4.1, 4.2, 9.3 |
| A22 | `test_owned_application_room_invariant` (읽기 전용) | **`owned_request_ids`로 범위를 한정해** 확인한다(DB 전체 단정 금지): 그 요청들의 지원마다 방 정확히 1개, 방 없는 지원 0건, `seller_id = buyer_id` 0건, `seller_applications.buyer_id`가 요청의 `buyer_id`와 일치. 이 테스트 자신의 시나리오(판매자 3명 지원 + 중복·본인 지원 시도 실패)로 만든 요청을 대상으로 하며, 다른 테스트는 공용 헬퍼 `assert_owned_invariants(owned_request_ids)`로 같은 검사를 재사용한다 | 4.4 |

### 10.2 동시성 (C) — `test_applications_concurrency.py`

| # | 테스트 | 기대 | 시나리오 |
| --- | --- | --- | --- |
| C1 | `test_n_distinct_sellers_apply_concurrently` | N×201, 지원 id N개·방 id N개 모두 서로 다름, 그 요청 id의 DB 행 N, owner 목록 N건, `applicantCount == N`, 500/503 0건, `assert_owned_invariants` 통과 | S1 |
| C2 | `test_same_seller_parallel_duplicates_single_winner` (3회 반복, 매번 새 요청) | K=8: 정확히 1×201, 7×409 `ALREADY_APPLIED`, 지원 1·방 1 | S2 |
| C3 | `test_mixed_self_duplicate_and_distinct` | 구매자 2스레드 403, 판매자 A 3스레드(1×201 + 2×409), 판매자 B~E 각 201, 최종 지원 5건(구매자 행 없음) | S3 |
| C4 | `test_apply_waits_for_uncommitted_close_then_rejects` | 제어 커넥션 `BEGIN; UPDATE … status='closed'`(자기 테스트 요청, 미커밋) → 지원 스레드 시작 → `wait_until_blocked_by(controller_pid)`로 지원 백엔드의 Lock 대기 **관측** → COMMIT → 409 `REQUEST_NOT_OPEN`, 그 요청의 지원 0행 | S4 |
| C4b | `test_apply_waits_for_row_lock_then_succeeds` | 데이터를 바꾸지 않는 `BEGIN; SELECT … FROM purchase_requests WHERE id=:own FOR NO KEY UPDATE`(상태 변경과 같은 잠금 모드) → Lock 대기 관측 → COMMIT(변경 없음) → 201. UPDATE 후 롤백은 쓰지 않는다 | S4 |
| C5 | `test_status_change_blocked_while_application_in_flight` | `lock_request_for_application`이 `FOR SHARE`를 **실제로 획득해 반환한 직후** 훅이 `acquired.set()` 후 `release.wait(5)`로 멈춘다. 테스트는 `acquired.wait(5)`가 참인지 확인한 뒤 제어 커넥션에서 `SET lock_timeout='300ms'; SELECT … FOR NO KEY UPDATE`(데이터 변경 없음)를 실행해 `LockNotAvailable`(55P03)을 확인한다(잠금 보유 증명). 제어 트랜잭션은 실패한 문장이므로 롤백 → `release.set()` → 지원 201, 상태 `open` 유지 | S5 |
| C6 | `test_duplicate_waits_then_succeeds_after_first_rollback` | 제어 커넥션이 같은 `(r, s)` 지원 행을 원시 INSERT(**미커밋 INSERT**, 롤백 허용 범위) → API 지원 시작 → `wait_until_blocked_by`로 unique 인덱스 대기(`wait_event = 'transactionid'`) 관측 → ROLLBACK → 201, 그 `(r, s)` 지원 1·방 1 | S6 |
| C7 | `test_duplicate_waits_then_conflicts_after_first_commit` | 제어 커넥션이 지원+방을 원시 INSERT(미커밋) → API 지원의 Lock 대기 관측 → COMMIT → API 지원 409 `ALREADY_APPLIED`, 그 `(r, s)` 지원 1·방 1(제어 커넥션이 만든 행 유지) | S7 |
| C8 | `test_cross_request_parallel_counts` | 같은 `test_ns`의 요청 3개 × 판매자 6명 전부 동시 지원(18 스레드) → 요청별 6건, 그 3개 요청 범위에서 총 18방, `assert_owned_invariants` 통과 | S8 |
| C9 | `test_lock_timeout_returns_503_without_rows` | `get_settings` override로 `application_lock_timeout_ms=300`, 제어 커넥션이 자기 요청 행에 `SELECT … FOR UPDATE`(데이터 변경 없음) 유지 → Lock 대기 관측 → 지원 응답 503 `SERVICE_UNAVAILABLE`(`future.result(timeout=10)`), 그 요청의 지원 0행 → 제어 COMMIT → 재시도 201 | D5 |

### 10.3 롤백 · 원자성 (R)

| # | 테스트 | 기대 |
| --- | --- | --- |
| R1 | `test_room_insert_pg_failure_rolls_back_application` | `chat_rooms.create_for_application`을 monkeypatch해 존재하지 않는 `application_id`로 **실제 INSERT**(PG FK 위반 `IntegrityError`) → 503. 해당 `(request, seller)` 지원 0행, `applicantCount` 불변. 원래 함수로 되돌린 뒤 같은 판매자 재지원 201(unique 잔재 없음) |
| R2 | `test_commit_failure_rolls_back_both` | `get_db` override: 실제 세션을 감싸되 `commit()`이 `OperationalError`를 던짐 → 503, 지원·방 0행, 재시도 201 |
| R3 | `test_non_db_exception_after_insert_leaves_no_rows` | 방 INSERT 직후·commit 전에 `RuntimeError` 주입(`create_for_application`을 감싸 원래 INSERT 실행 후 raise하는 monkeypatch) → 500 `INTERNAL_ERROR`, `get_db`의 세션 close 롤백으로 지원·방 0행 |
| R4 | `test_concurrent_failures_do_not_leak_partial_rows` | C1과 같은 N 동시 지원 중 짝수 번째 판매자의 방 INSERT만 실패하도록 주입 → 성공한 판매자는 지원+방, 실패한 판매자는 둘 다 0행. 그 요청 id 범위에서 `assert_owned_invariants` 통과 |

### 10.4 마이그레이션 (M)

| # | 테스트 | 기대 |
| --- | --- | --- |
| M1 | `test_schema_objects_exist` | 인스펙터: 두 테이블, 4장 제약·인덱스 이름 전부, FK `ondelete=CASCADE`, `uq_purchase_requests_id_buyer` 존재 |
| M2 | `test_revision_graph` | `ScriptDirectory`: `0003_seller_applications`의 down이 `0002`, 이 worktree 버전 디렉터리의 모든 revision id가 32자 이하이며 유일 |
| M3 | `test_offline_sql_is_additive` | 9.5 upgrade SQL에 `CREATE TABLE app_private.seller_applications`, `CREATE TABLE app_private.chat_rooms`, `ADD CONSTRAINT uq_purchase_requests_id_buyer` 포함. `DROP`·`TRUNCATE`·`DELETE FROM`·`ALTER COLUMN`·`RENAME` 부재(FK 절의 `ON DELETE CASCADE`는 허용하므로 `DELETE FROM`으로 검사한다). downgrade SQL은 우리 객체만 DROP하고 `purchase_requests`/`users`/`auth_sessions` 테이블 DROP 부재 |
| M4 | `test_migration_guards` (순수 함수, DB 없음) | `assert_local_test_database`: supabase·임의 원격 host → exit, loopback → 통과(메시지에 URL 부재). `classify_revision_state`: `{0002}`/known → ok, `{0003_photo}`/known 미포함 → unknown |

### 10.5 프론트엔드 단위 (F) — Vitest + RTL

| # | 파일 | 테스트 | 기대 |
| --- | --- | --- | --- |
| F1 | `applicationsApi.test.ts` (신규) | `applyToRequest` | `POST /api/requests/{id}/applications`, `postInit` 헤더, `credentials:'same-origin'`, `cache:'no-store'`, 본문 `{offerPrice,message}` |
| F2 | 〃 | 201 파싱 | `{application, chatRoom}` 타입 가드 통과. 필드 누락·타입 불일치 → `INTERNAL_ERROR` |
| F3 | 〃 | 오류 code | 409 `ALREADY_APPLIED`/`REQUEST_NOT_OPEN`, 403 `SELF_APPLICATION_FORBIDDEN`이 그대로 code로 전달. 422 `fields.offerPrice/message` 파싱. `fetch` reject → `NETWORK_ERROR` |
| F4 | 〃 | `listApplications(id, {baseUrl, cookie})` | 쿠키 헤더 전달, `viewerRole` 4종 파싱, 모르는 역할 → `INTERNAL_ERROR` |
| F5 | 〃 | `getChatRoom(id, {baseUrl, cookie})` | 200 파싱, 404 → `NOT_FOUND`, 401 → `UNAUTHENTICATED` |
| F6 | `ApplyPanel.test.tsx` (신규) | 역할별 렌더 | `anonymous` → "로그인하고 지원하기" 링크 `/login?next=/requests/{id}`. `owner` → 지원 버튼 없음 + "내 구매요청" 안내. `applicant` → "지원 완료" + `/chats/{roomId}` 링크. `member`+`open` → "지원하기" 버튼. `member`+`closed`/`matched` → 비활성 "모집이 마감된 요청입니다" |
| F7 | `ApplyForm.test.tsx` (신규) | 클라이언트 검증 | 빈 제시가·음수·소수·10억 초과, 메시지 1자·501자 → 입력 아래 오류(`aria-invalid`, `aria-describedby`), API 미호출 |
| F8 | 〃 | 제출 | 성공 시 `router.push('/chats/{roomId}')` 1회. 제출 중 버튼 `disabled`, 더블클릭해도 `applyToRequest` 1회 |
| F9 | 〃 | 서버 오류 | 409 `ALREADY_APPLIED` → 안내 + `router.refresh()`. 409 `REQUEST_NOT_OPEN` → 안내 + refresh. 403 SELF → 안내. 401 → 재로그인 링크(`next` 포함) + 입력 보존. 422 → 필드 오류 표시 + 입력 보존. `NETWORK_ERROR` → 재시도 가능 |
| F10 | 〃 | 희망가 밖 안내 | `offerPrice`가 `priceMin~priceMax` 밖이면 비차단 안내 문구, 제출 가능 |
| F11 | `ApplicantList.test.tsx` (신규) | owner 목록 | 제목 "지원한 판매자 {applicantCount}명", 항목마다 `maskedEmail`·제시가·메시지·"채팅방 열기" 링크 `/chats/{chatRoomId}`. `nickname`/`region` 미사용 |
| F12 | 〃 | 비참여 | `member`/`anonymous` → 제목에 공개 count, 항목 없음, "지원 내용은 구매자와 해당 판매자만 볼 수 있어요." 안내, 0건이면 기존 빈 상태 문구 |
| F13 | `RequestDetail.test.tsx` (수정) | 기존 0건 테스트 | 새 props(`applications`, `viewerRole`, `applicantCount`)로 갱신. "지원하기 · 준비 중"·"4단계에서 열립니다" 문구 부재. 가짜 판매자 부재 유지 |
| F14 | `ChatRoomView.test.tsx` (신규) | 방 셸 | 요청 제목(`/requests/{id}` 링크), 구매자·판매자 마스킹 이메일, 제시가, 지원 메시지, "메시지 기능은 6단계에서 열립니다." 표시. `textbox`·"보내기" 버튼 부재 |
| F15 | `noMockData.test.ts` (기존) | 목업 부재 | 계속 통과(지원 목업 재도입 금지) |
| F16 | `requestsApi.test.ts` (기존) | `applicantCount` 파싱 | 0 이외 정수도 통과 |

### 10.6 통합 · UI (U) — Orca 내장 브라우저

12.3 절차로 수행한다. 각 항목에서 `orca snapshot`과 `orca screenshot`을 증거로 남긴다. 증거 파일은 저장소 밖에 저장하고 커밋하지 않는다.

| # | 시나리오 | 기대 |
| --- | --- | --- |
| U1 | 3104/8104 기동 후 `http://127.0.0.1:3104/api/auth/me` | 401 JSON(rewrite가 8104로 전달됨) |
| U2 | buyer 프로필: 가입 → `[run] …` 요청 등록 | `/requests/{uuid}`, "지원한 판매자 0명" |
| U3 | 기본(비로그인) 프로필로 상세 | "로그인하고 지원하기" 링크, 지원 폼 없음 |
| U4 | sellerA 프로필: 가입 → 상세 → 지원하기 → 제출 | `/chats/{roomId}` 이동, 방 셸 표시, 입력창 없음 |
| U5 | sellerA가 상세로 돌아옴 | "지원 완료 · 채팅방 열기" |
| U6 | sellerB 지원 | 다른 `roomId`. sellerB가 sellerA의 방 URL을 열면 404 화면 |
| U7 | buyer 상세 새로고침 | 2명, 마스킹 이메일, 방 링크 2개(서로 다름), 둘 다 열림(`viewerRole` buyer 문구). 지원 버튼 없음 |
| U8 | buyer가 지원 API를 직접 호출(`orca eval`로 동일 출처 fetch) | 403 `SELF_APPLICATION_FORBIDDEN` |
| U9 | sellerC 프로필: `orca eval`로 같은 본문 POST 5개를 `Promise.all` | 상태 목록이 정확히 201 1개 + 409 4개. 새로고침 후 방 링크 1개 |
| U10 | 홈 목록 `q=<run>` + "지원자 많은순" | 카드 "지원 3명"이 맨 앞, 상세 count와 일치 |
| U11 | 백엔드만 중지한 상태에서 상세 | 오류 블록·재시도. 가짜 지원자 없음. 확인 후 재기동 |
| U12 | 접근성 | 지원 폼 오류 `aria-invalid`/`aria-describedby`, 제출 결과 `role="alert"`/`role="status"`, 방 링크에 접근 가능한 이름 |

---

## 11. 프론트엔드 설계

### 11.1 타입 (`frontend/src/types/request.ts`, `types/application.ts` 신규)

```ts
export interface MaskedUser { id: string; maskedEmail: string }            // RequestBuyer와 동형
export type ApplicationViewerRole = 'owner' | 'applicant' | 'member' | 'anonymous';
export interface Application {
  id: string; requestId: string; seller: MaskedUser;
  offerPrice: number; message: string; chatRoomId: string; createdAt: string;
}
export interface ApplicationList { viewerRole: ApplicationViewerRole; applicantCount: number; items: Application[] }
export interface ChatRoom {
  id: string; applicationId: string; viewerRole: 'buyer' | 'seller';
  request: { id: string; title: string; status: RequestStatus; priceMin: number; priceMax: number };
  buyer: MaskedUser; seller: MaskedUser; offerPrice: number; applicationMessage: string; createdAt: string;
}
export interface ApplyPayload { offerPrice: number; message: string }
export interface ApplyResult { application: Application; chatRoom: ChatRoom }
```

`types/request.ts`의 `UserSummary`와 옛 `Applicant`는 삭제하고, `Applicant` 사용처는 `Application`으로 바꾼다. `RequestBuyer`는 `MaskedUser`의 별칭으로 남겨 기존 import를 깨지 않는다.

### 11.2 API 클라이언트 `frontend/src/lib/api/applications.ts` (신규)

- `applyToRequest(requestId, payload, signal?)`, `listApplications(requestId, opts)`, `getChatRoom(roomId, opts)`. `opts = {signal?, baseUrl?, cookie?}`는 `requests.ts`와 같다.
- `ALLOWED_FIELD_KEYS = ['offerPrice', 'message']`.
- 응답은 수동 타입 가드로 파싱하고 실패 시 `internalError(status)`를 던진다(`requests.ts` 패턴). 목업 폴백은 없다.
- `types/api.ts`의 `ApiErrorCode`와 `http.ts`의 `KNOWN_ERROR_CODES`에 6.5의 code 3개를 추가한다.

### 11.3 라우트

| 경로 | 렌더링 | 데이터 |
| --- | --- | --- |
| `/requests/[id]` (수정) | SSR `force-dynamic` | `Promise.all([getRequest, listApplications])`. 둘 다 쿠키를 전달하고 `baseUrl = resolveServerApiBase()`. 지원 목록 실패(503 등)는 페이지 전체를 실패시키지 않고 지원 영역에 오류 블록과 재시도(`router.refresh`)를 보여준다. 요청 404는 기존처럼 `notFound()` |
| `/chats/[roomId]` (신규) `page.tsx`, `loading.tsx` | SSR `force-dynamic` | `getChatRoom(roomId, {baseUrl, cookie})`. `UNAUTHENTICATED` → `redirect('/login?next=/chats/{roomId}')`(`safeNextPath` 규칙 준수). `NOT_FOUND`/형식 오류(422) → `notFound()`. 그 외 오류는 `error.tsx` 경계 |

### 11.4 컴포넌트

| 컴포넌트 | 위치 | 역할 |
| --- | --- | --- |
| `ApplyPanel` | `features/applications/components/` (client) | 상세 하단 sticky 바. `viewerRole`, `request.status`, 본인 지원(`items[0]`)으로 F6 상태를 결정. `member`+`open`에서 "지원하기"를 누르면 `ApplyForm`을 펼친다 |
| `ApplyForm` | 〃 (client) | `offerPrice`(숫자 입력, 원 단위), `message`(textarea, 글자 수 표시 `n/500`). 클라이언트 검증 규칙은 6.1과 동일. 제출 중 잠금. 성공 시 `/chats/{roomId}`로 이동. 오류 처리는 F9 |
| `ApplicantList` | `features/requests/components/` (수정) | props `{applicantCount, viewerRole, applications}`. owner는 전체 카드와 "채팅방 열기" 링크, applicant는 "내 지원" 카드 1개, member/anonymous는 count와 비공개 안내 |
| `RequestDetail` | 〃 (수정) | 비활성 버튼 영역을 `ApplyPanel`로 교체. 구매자 aside는 그대로 |
| `ChatRoomView` | `features/chat/components/` (신규) | 방 헤더(요청 제목 링크, 상태 배지, 희망가), 참여자 2명(마스킹 이메일, "나" 표시는 `viewerRole`로), 제시가·지원 메시지, 메시지 영역 자리에 "메시지 기능은 6단계에서 열립니다." 빈 상태 |

화면 문구와 스타일은 기존 `Card`/`Button`/`Badge`/`EmptyState`와 potato·leaf 색 토큰을 재사용한다. 형제 worktree가 `RequestDetail.tsx`에 사진 영역을 추가할 수 있으므로, **`<article>` 내부 구조는 건드리지 않고** 하단 sticky 바와 `ApplicantList` 호출부만 바꾼다(13.2).

### 11.5 인증 상태 표시 원칙

- 지원 가능 여부는 **SSR의 `viewerRole`**로 판단한다. 클라이언트 `AuthProvider` 상태와 어긋나더라도(예: 쿠키 만료) 서버 응답이 최종이다. 제출 시 401이면 재로그인 안내를 보여준다.
- 로그인·로그아웃 뒤에는 `router.refresh()`로 SSR 데이터를 갱신한다. 구현 전 재확인 결과 기존 `HeaderAuth`에는 refresh가 없으므로 로그아웃 성공 시 갱신을 추가하고 모의 인증 회귀 테스트로 검증한다. 비공개 지원·방 정보가 인증 변경 후 남지 않게 한다.

---

## 12. 로컬 실행 · 포트 격리 · Orca UI 검증

### 12.1 포트

| worktree | frontend | backend |
| --- | --- | --- |
| item4 (이 문서, `curriculum-04-seller-applications`) | **3104** | **8104** |
| item5 (`curriculum-05-request-photos`) | 3105 | 8105 |

기본 포트 3000/8000은 쓰지 않는다. `scripts/stop.sh`는 **이 worktree의** 상태 파일(`scripts/.state/service.json`)에 기록된 프로세스만 종료한다. 다른 포트의 프로세스를 종료하지 않는다.

### 12.2 환경 변수 · 출처 · 서버 측 API URL

- **CORS**: 추가하지 않는다. 브라우저는 `http://127.0.0.1:3104/api/*`(동일 출처)만 호출하고, Next rewrite(`next.config.ts`)가 FastAPI로 프록시한다.
- **`AUTH_ALLOWED_ORIGINS`**(백엔드 POST Origin 검사): 기동할 때만 **인라인**으로 덮어쓴다. `.env`는 수정하지 않는다. pydantic-settings에서는 프로세스 환경 변수가 `.env`보다 우선한다.
  `["http://127.0.0.1:3104","http://localhost:3104"]`
  Next는 `--hostname 127.0.0.1`로 바인딩되므로 브라우저는 `http://127.0.0.1:3104`로 연다. `localhost`는 IPv6 `::1`로 해석될 수 있어 접속이 실패할 수 있다.
- **`BACKEND_API_ORIGIN`**(Next rewrite + SSR `resolveServerApiBase`): `service.py`가 `--backend-port`로 `http://127.0.0.1:8104`를 주입한다(276행). 프로세스 환경 변수가 `frontend/.env.local`의 `:8000`보다 우선하므로 rewrite와 SSR 호출이 모두 8104로 간다. SSR의 지원 목록·채팅방 호출도 이 값을 쓴다.
- **Vercel**: 변경 없음. 운영 SSR은 `BACKEND_SERVICE_ORIGIN` 바인딩을 쓰고, 브라우저 `/api/*`는 `vercel.json` rewrite가 backend 서비스로 보낸다. 새 경로 `/api/chat-rooms/*`도 `/api/:path*` 규칙에 포함된다.
- **`SESSION_COOKIE_SECURE=false`**(로컬 http) 유지.
- **쿠키는 포트로 격리되지 않는다.** `gamja_session`은 host `127.0.0.1` 단위이므로 3104와 3105 탭이 같은 브라우저 프로필이면 세션을 공유한다. 두 백엔드가 같은 DB를 쓰므로 세션도 양쪽에서 유효하다. 다른 worktree의 로그아웃에 영향받지 않도록 **item4 전용 Orca 브라우저 프로필**을 쓴다(12.3).

기동·중지(대상 worktree 루트에서, 의존성 설치 후):

```sh
# 최초 1회: (cd backend && uv sync) && (cd frontend && npm ci)
AUTH_ALLOWED_ORIGINS='["http://127.0.0.1:3104","http://localhost:3104"]' \
  ./scripts/start.sh --frontend-port 3104 --backend-port 8104
./scripts/stop.sh
```

- 앱은 시작 시 마이그레이션하지 않는다(backend README). 스키마 적용은 8.3 절차나 가드가 있는 pytest `migrate_database`로만 한다. **`uv run alembic upgrade head`를 직접 실행하지 않는다.** `.env`의 `MIGRATION_DATABASE_URL`이 Supabase를 가리키기 때문이다. 수동 적용이 꼭 필요하면 `MIGRATION_DATABASE_URL`을 로컬 `DATABASE_URL` 값으로 인라인 지정하고(값 출력 금지) 명시 target `0003_seller_applications`로만 올린다.
- pytest는 별도 셸에서 `cd backend && uv run pytest tests/test_applications.py tests/test_applications_concurrency.py`로 실행한다. 기존 스위트는 9.4 전환이 끝난 뒤에만 실행한다.

### 12.3 Orca CLI UI 검증 절차 (ui tester)

UI 검사는 `orca` CLI의 내장 브라우저 명령만 사용한다(SDD 스킬 규칙). 정확한 플래그는 `orca <command> --help`로 확인한다. 이번 조사에서 확인한 명령은 `tab profile create|set|clone`, `tab create`, `tab list`, `goto`, `snapshot`, `click --element`, `fill --element --value`, `keypress`, `eval --expression`, `screenshot --format png`, `wait`, `reload`다.

1. 프로필 준비: `gamja-item4-buyer`, `gamja-item4-seller-a`, `gamja-item4-seller-b`, `gamja-item4-seller-c`를 만든다(기존 프로필은 삭제하지 않음). 비로그인 확인은 새 프로필 `gamja-item4-visitor`로 한다.
2. 각 프로필 탭에서 `goto http://127.0.0.1:3104/…` → `snapshot`으로 ref 확보 → `fill`/`click` → `wait` → `snapshot`/`screenshot`.
3. 가입 이메일은 `ui4-<run>-buyer@example.com` 형식이다. 비밀번호는 증거나 로그에 남기지 않는다.
4. U8·U9의 API 호출은 해당 프로필 탭에서 `orca eval`로 동일 출처 `fetch('/api/requests/<id>/applications', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-Requested-With':'gamja-market'}, body: …})`를 실행하고 상태 코드 배열만 반환받는다. 브라우저가 Origin 헤더를 `http://127.0.0.1:3104`로 붙이므로 12.2의 허용 목록이 필요하다.
5. 증거(스냅샷 텍스트·PNG)는 저장소 밖(예: `$TMPDIR/gamja-item4-ui/`)이나 Orca artifact에 저장한다. worktree에 커밋하지 않는다.
6. 종료할 때는 `./scripts/stop.sh`만 실행한다. 생성한 회원·요청·지원·방 데이터는 **삭제하지 않는다**.

---

## 13. 구현 순서와 워커 경계

### 13.1 순서 (각 단계 RED 확인 → GREEN)

0. (사람 검토 통과 후) 의존성 설치(`uv sync`, `npm ci`). DB 변경 없음.
1. **tester**: 9.2 `conftest.py` 교체 + 9.4 기존 테스트 전환 → 테스트를 실행하기 전에 가드 단위 테스트 M4만 먼저 실행해 로컬 가드를 확인한다. 그다음 전환된 기존 스위트를 GREEN으로 확인한다(아직 0003이 없으므로 가드 target을 임시로 `0002`에 맞추거나 target 상수를 `ScriptDirectory`의 최신 로컬 revision으로 계산한다. 방식은 tester가 선택하되 `head`/`heads`/`stamp`는 금지).
2. **tester**: 10.1~10.4 백엔드 RED와 10.5 프론트 RED를 작성하고, 실패 이유가 "미구현"인지 확인한다.
3. **backend**: 0003 migration + 모델 → 8.3 절차로 공유 DB에 적용(`alembic_version`을 먼저 읽는다) → M1~M3 GREEN.
4. **backend**: 스키마·repository·service·router, `applicantCount`/정렬 → A·C·R GREEN.
5. **front**: 타입·API 클라이언트 → F1~F5, 컴포넌트·라우트 → F6~F16 GREEN.
6. **ui tester**: 12장 절차로 U1~U12를 수행하고 증거를 보고한다.

### 13.2 형제 worktree와의 충돌 hotspot

| 파일 | 충돌 가능성 | 완화 |
| --- | --- | --- |
| `backend/migrations/versions/` | revision 분기 | 8장. id·파일명 고정, 병합 revision은 나중 PR이 추가 |
| `backend/app/db/models.py` | `PurchaseRequest.__table_args__` | 한 줄만 추가, 새 모델은 파일 끝에 |
| `backend/app/main.py` | router include, no-store prefix, 422 맵 | include는 기존 줄 뒤에 추가, prefix 튜플에 항목만 추가, 422 분기는 함수 맨 앞의 독립 블록 |
| `backend/app/api/errors.py`, `frontend/src/types/api.ts`, `frontend/src/lib/api/http.ts` | code 목록 | 목록 끝에만 추가 |
| `backend/tests/conftest.py` | 형제 설계(07 §9.2)도 이 파일을 교체한다(`run_tag`, `ensure_additive_schema`, `alembic_version` 미접근). 우리 설계는 가드된 `upgrade 0003_seller_applications`를 쓴다 | 두 교체 모두 TRUNCATE 제거와 namespace 원칙이 같다. 병합 시 하나로 합친다: 로컬 가드(9.2-1·2) + 형제의 `ensure_additive_schema` + 우리 revision 적용. 병합 후에는 단일 head `upgrade head`로 정리한다. 형제 M1("실행 전후 `alembic_version` 동일")은 우리 worker가 같은 시각에 0003을 올리면 흔들릴 수 있으므로, 0003 적용 시점을 코디네이터에게 알린다 |
| `frontend/src/features/requests/components/RequestDetail.tsx`, `app/requests/[id]/page.tsx` | 형제가 사진 영역 추가 | `<article>` 내부는 수정하지 않는다 |
| `frontend/src/types/request.ts` | 형제가 사진 타입 추가 가능 | `UserSummary`/`Applicant` 블록만 교체 |

### 13.3 공유 DB 동시 사용 규칙 (코디네이터에게 전달)

- 두 worktree 중 어느 쪽도 TRUNCATE가 남아 있는 기존 `conftest.py`로 pytest를 실행하지 않는다. 실행하면 상대 worktree의 데이터까지 CASCADE로 삭제된다.
- 공유 DB의 스키마 변경은 8.3 절차로만 한다. 적용 전후에 `alembic_version`을 읽기 전용으로 기록해 보고한다.

---

## 14. 확정 기술 결정과 권장 제품 기본값

사람 검토 대상은 이 문서 전체다. 아래 항목은 개별 승인 게이트가 아니다. 검토자가 문서 검토 중에 바꾸지 않으면 **표시된 값으로 구현한다.**

### 14.1 확정된 기술 결정 (승인된 기술 선택, 게이트 아님)

| # | 항목 | 확정 내용 |
| --- | --- | --- |
| T1 (구 H1) | 기존 테스트의 안전한 전환 | 4단계 범위에 **포함한다.** `test_auth.py`/`test_requests.py`를 9.4대로 `test_ns` 기반으로 전환하고 DELETE·downgrade 테스트를 읽기 전용 검증으로 바꾼다. 테스트가 검증하는 계약은 바꾸지 않는다 |
| T2 (구 H7) | 형제 photo worktree와의 통상적인 마이그레이션 호환 | 개발 중: 우리는 로컬 가드 아래 `upgrade 0003_seller_applications`로 올린다. 형제는 `alembic_version`에 접근하지 않는 멱등 DDL을 쓴다(07 설계). 모르는 revision을 만나면 8.3의 읽기 전용 참조 절차를 쓴다. 통합 기본값: **나중에 병합되는 PR이 병합 revision(DDL 없음)을 추가한다.** 형제 07의 "나중 병합 쪽 re-parent" 규칙도 호환되므로, 형제가 먼저 그 규칙으로 병합했다면 그대로 따른다(8.4). stamp·downgrade·reset은 어떤 경우에도 하지 않는다. 형제 revision id를 32자 이하로 줄이는 것은 코디네이터가 형제에게 전달한다 |
| T3 | 테스트 데이터 원칙 | DELETE·TRUNCATE·DROP 실행 없음, `test_ns`로 격리, 소유 id 범위 단정, 잠금 대기는 PG 관측 또는 획득 지점 동기화로 증명(9장, 10장) |

### 14.2 권장 제품 기본값 (검토자가 바꾸지 않으면 채택)

| # | 항목 | **기본값(채택)** | 대안 |
| --- | --- | --- | --- |
| H2 | 중복 지원 응답 | **409 `ALREADY_APPLIED`** | 200 + 기존 지원 반환(멱등). 프론트는 단순해지지만 "1건만 생성" 판정이 응답 코드로 드러나지 않는다 |
| H3 | 비참여자의 채팅방 접근 | **404** | 403 `FORBIDDEN`(디버깅은 쉬우나 방 존재가 노출된다) |
| H4 | 제시가를 희망가 범위로 제한하는가 | **제한하지 않음**(UI 안내만) | 범위 밖이면 422 |
| H5 | 지원 메시지 길이 | **2~500자** | 10~1000자(요청 설명과 동일) |
| H6 | 본인 지원 DB 강제 방식 | **복합 FK + CHECK**(`purchase_requests`에 UNIQUE 1개 추가) | 트리거 함수 또는 서비스 검사만(기존 테이블은 전혀 건드리지 않지만 DB 불변식이 없다) |
| H8 | 지원 상세 공개 범위 | **구매자 + 해당 판매자만**, 제3자는 count만 | 제시가를 공개해 경쟁을 유도(프라이버시·흥정 관점에서 비권장) |
| H9 | 동시성 테스트 규모 | **기본 N=16, 상한 40** | 더 큰 N은 수동 부하 테스트로 분리 |

### 한계와 이월 사항

- 지원 목록 페이지네이션 없음(6.2).
- 운영 Supabase pooler 커넥션 상한에서의 동시성 수치는 검증하지 않는다. 로컬 PG에서 정확성만 증명한다.
- 지원 철회·수정, 지원 `status` 컬럼, 요청 상태 전이 API는 7단계에서 **추가 컬럼·새 revision**으로 도입한다. 이 문서의 `FOR SHARE` 규약은 7단계의 상태 변경이 `UPDATE`로 행 잠금을 잡는다는 전제에 기대므로, 7단계 설계는 이 전제를 유지해야 한다.
- 채팅 메시지 테이블은 6단계에서 `room_id → chat_rooms(id)` FK로 추가한다. 참여자 판정은 6.3의 조인을 재사용한다.

---

## 부록 A. 이번 설계 작업의 안전 기록

- 수정한 파일: 이 문서 1개(대상 worktree). 원본 checkout과 형제 worktree는 수정하지 않았다.
- DB: `docker exec … psql`로 `SELECT`만 실행했다(`alembic_version`, 행 수, 테이블 목록, `SHOW` 설정). 쓰기·삭제·스키마 변경은 없었다.
- 테스트·개발 서버: 실행하지 않았다.
- 비밀 값: `.env` 파일은 host 분류만 확인했으며 자격 증명은 출력하거나 기록하지 않았다.


## 구현 전 보충 확인 (2026-09-26)

- 기존 인증의 로그아웃·세션 교체·만료 세션 정리는 세션 행을 삭제한다. 데이터 보존 지침에 따라 해당 삭제 경로의 회귀 검증은 모의 세션/저장소로 수행하고 실제 공유 DB 통합 검증과 구분해 보고한다. 구매요청·지원·채팅방 검증 계정은 독립 쿠키 저장소를 사용하며 로그아웃으로 정리하지 않는다. 운영 인증 동작 자체는 바꾸지 않는다.
- 서버 실행 스크립트는 지정 포트가 다른 worktree에 점유된 경우 그 프로세스를 중지할 수 있다. 실행 전에 3104/8104가 비어 있는지 확인하고, 점유 상태에서는 스크립트를 실행하지 않는다.
