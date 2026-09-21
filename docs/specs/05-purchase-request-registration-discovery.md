# 05. 구매요청 등록 & 탐색 — DB 영속화와 프론트·백엔드 통합

> 기준: `curriculum.md` **3단계**("구매자가 원하는 물건+희망가 등록, 목록 조회. front/backend 결과물 통합 지점")와 2026-09-21 코드 조사.
> `docs/specs`의 기존 문서는 `01`~`04`이므로 다음 순번은 `05`다. 문서 번호는 커리큘럼 단계 번호와 별개이며, 본 문서가 다루는 커리큘럼 단계는 3단계다.
> 이 문서는 **후속 구현 계약**이다. 현재 구현 완료를 뜻하지 않으며, 이번 설계 작업은 이 Markdown 한 개만 추가한다. 운영 코드와 테스트는 수정하지 않는다.
>
> **사람 검토 반영(2026-09-21)**: 두 가지 결정이 적용됐다. (1) 3단계에서 구매요청·회원·지원자 **애플리케이션 목업을 전부 제거**한다. `lib/mock/` 디렉터리 세 파일을 모두 삭제하고, 판매자 지원 영역은 목업 폴백 없이 정직한 0건·4단계 예정 상태로 렌더한다. (2) 3단계 범위를 **등록(create)·목록(list)·상세(detail) 읽기 경로로 한정**한다. 수정·삭제, `PATCH`/`DELETE` 엔드포인트, 소유자 액션 UI와 관련 테스트는 이후 작업으로 미룬다. DB 기반 검색·필터·정렬 동작은 그대로 유지한다.

---

## 1. 목표와 범위

### 1.1 이 단계에서 하는 것

- 로그인한 회원이 구매요청을 등록하면 PostgreSQL에 **영속화**된다. 새로고침·다른 브라우저·다른 회원에게도 동일하게 보인다.
- 구매요청 **목록 조회**(검색어·카테고리·상태·정렬·페이지네이션)와 **상세 조회**를 FastAPI가 제공하고 Next.js가 렌더링한다.
- 목록·상세는 **비로그인 공개**다. 등록만 인증을 요구한다.
- 프론트엔드의 애플리케이션 목업 데이터(`lib/mock/requests.ts`, `lib/mock/users.ts`, `lib/mock/applicants.ts`) **세 파일을 모두 삭제**하고 실제 API 호출로 교체한다. **목업 폴백(fallback)을 두지 않는다.** API가 실패하면 목업이 아니라 오류 상태를 보여준다.
- 판매자 지원 영역은 목업을 채우지 않고 **실제 0건 상태**로 렌더한다. `applicantCount`는 서버가 `0`을 반환하고, 상세의 지원자 목록은 빈 배열로 기존 빈 상태 문구를 그대로 보여준다(5.5).

### 1.2 이 단계에서 하지 않는 것 (Out of Scope)

| 항목 | 도입 시점 |
| --- | --- |
| 구매요청 **수정·삭제**: `PATCH`/`DELETE` 엔드포인트, `/requests/[id]/edit` 라우트, 소유자 액션 UI, 관련 테스트 | **이후 작업**(3단계 이후 별도 설계) |
| 판매자 지원(applicant) 등록·조회 API, 지원 시 채팅방 생성 | 4단계 |
| 사진 업로드 (Supabase Storage, `thumbnailUrl` 실제 값) | 5단계 |
| 구매자-판매자 채팅(폴링) | 6단계 |
| 매칭 확정과 `matched`/`closed` 자동 상태 전이 | 7단계 |
| 거래완료·후기 | 8단계 |

- **수정·삭제는 3단계에 포함하지 않는다.** 3단계의 쓰기 경로는 `POST /api/requests` 하나뿐이다. 한 번 등록한 요청은 이 단계에서 변경·삭제할 수 없다. 스키마의 `updated_at` 컬럼과 상태 전이용 `status` 값은 이후 단계를 위해 미리 두지만, 3단계 API는 이들을 변경하는 경로를 제공하지 않는다(3.1, 4.3).
- **사진 업로드는 3단계에 포함하지 않는다.** 등록 폼의 사진 영역은 현재처럼 비활성 상태로 유지하고, `thumbnail_url`은 스키마에만 `NULL` 허용 컬럼으로 존재한다. 등록 API는 이 필드를 입력으로 받지 않는다.
- 2단계 인증 설계(`docs/specs/02-email-password-auth.md`)를 **변경하지 않는다.** 세션 쿠키, Origin/`X-Requested-With` 검사, 오류 계약, `app_private` 스키마, `AuthProvider` 동작을 그대로 재사용한다.
- **판매자 지원 목업을 유지하지 않는다.** `lib/mock/applicants.ts`도 이번 단계에서 삭제한다. 지원 기능 자체는 4단계이며, 그때까지 화면은 0건 상태를 정직하게 보여준다(7.1, 5.5).
- 구매자 닉네임·지역 프로필은 도입하지 않는다. 2단계 회원은 `id`와 `email`만 가진다(3.2 참조).

---

## 2. 현재 코드 근거와 결정

조사한 모든 진입점과 그에 따른 결정이다. 각 행은 실제 파일을 확인한 결과다.

### 2.1 프론트엔드

| 조사한 진입점 | 현재 상태 (확인된 사실) | 이번 단계의 결정 |
| --- | --- | --- |
| `frontend/src/app/page.tsx:4,26` | `import { mockRequests, requestCategories } from '@/lib/mock/requests'` 후 `<RequestBrowser requests={mockRequests} categories={requestCategories} />` | 서버 컴포넌트에서 `GET /api/requests`를 호출해 결과를 전달. 목업 import 제거 |
| `frontend/src/app/requests/[id]/page.tsx:5-6,13,18,24,28` | `getRequestById`, `mockRequests`, `getApplicantsByRequestId`를 import. `generateStaticParams()`가 `mockRequests`를 순회하고, `generateMetadata`/본문이 `getRequestById(id)` 사용 | `GET /api/requests/{id}` 호출로 교체. `generateStaticParams`는 **삭제**(DB 데이터는 빌드 시점에 알 수 없음). 404는 `notFound()` 유지. 지원자는 빈 배열로 교체(5.5) |
| `frontend/src/lib/mock/requests.ts` (전체 205줄) | `mockRequests` 12건, `requestCategories`, `getRequestById()` | **파일 삭제.** 카테고리는 `features/requests/categories.ts` 고정 상수로 이동(4.1) |
| `frontend/src/lib/mock/users.ts` (전체) | `mockUsers` 9명(`minji`…`sellerC`), 닉네임·지역 보유 | **파일 삭제.** 소비자는 `requests.ts`와 `applicants.ts` 둘뿐이며 둘 다 함께 삭제된다(7.1) |
| `frontend/src/lib/mock/applicants.ts` (전체 75줄) | `mockUsers`를 import해 `mockApplicants`(21건)/`getApplicantsByRequestId()` 구성 | **파일 삭제.** 상세 화면은 빈 배열을 넘겨 `ApplicantList`의 기존 0건 상태를 그대로 쓴다(5.5). 지원 기능은 4단계 |
| `frontend/src/features/requests/components/ApplicantList.tsx` | `applicants: Applicant[]` prop. 0건이면 "아직 지원한 판매자가 없어요" 빈 상태를 이미 렌더함 | **컴포넌트 변경 없음.** 목업 배열 대신 빈 배열을 받으면 그대로 정직한 0건 상태가 된다 |
| `frontend/src/types/request.ts` | `RequestStatus`, `ProductCondition`, `UserSummary{id,nickname,region}`, `PurchaseRequest`, `Applicant` | `PurchaseRequest.buyer`를 `UserSummary`에서 새 `RequestBuyer{id,maskedEmail}`로 교체. `Applicant`/`UserSummary` 타입 정의는 4단계 지원 API를 위해 **타입만 남긴다**(데이터는 없음) |
| `frontend/src/features/requests/components/RequestBrowser.tsx` | 클라이언트 컴포넌트. `useSearchParams`로 `category`/`status`/`sort`/`q`를 읽고 **클라이언트에서 filter+sort**(`useMemo`), `router.replace`로 URL 갱신 | 필터·정렬·검색을 **서버로 이관**한다. `RequestBrowser`는 URL만 갱신하고 표시 데이터는 props로 받는다(5.3) |
| `frontend/src/features/requests/components/RequestFilterBar.tsx` | `categories: string[]`, `openOnly`, `sort`(`latest`/`price`/`applicants`), `resultCount` props | 인터페이스 유지. `resultCount`는 클라이언트 배열 길이가 아니라 서버 `total`을 받는다 |
| `frontend/src/features/requests/components/RequestList.tsx` | `requests.length === 0`이면 `EmptyState`("조건에 맞는 구매요청이 없어요") | 유지. 단 "필터 결과 없음"과 "전체 데이터 없음"을 구분(6.2) |
| `frontend/src/features/requests/components/RequestCard.tsx` | `request.thumbnailUrl`, `formatPriceRange`, `formatRelativeTime`, `request.region`, `request.applicantCount` 사용 | 변경 없음. API 응답이 동일 필드를 제공한다(4.2) |
| `frontend/src/features/requests/components/RequestDetail.tsx` | `request.buyer.nickname`, `request.buyer.region`을 aside에 표시. 하단 "지원하기 · 준비 중" 비활성 버튼 | 구매자 표시를 이메일 마스킹으로 교체(5.5). 지원 버튼은 4단계이므로 비활성 유지. **소유자 수정·삭제 UI는 추가하지 않는다**(이후 작업) |
| `frontend/src/features/requests/components/RequestForm.tsx` | 클라이언트 검증만 수행. 성공 시 `setSubmitted(true)`로 "아직 저장 기능이 없습니다(3단계 예정)" 안내. 사진 버튼 `disabled` + "5단계에서 지원" | `POST /api/requests` 호출로 교체. 안내 문구 제거. 검증 규칙은 그대로 서버 계약과 일치시킨다(4.1). 사진 버튼은 그대로 비활성. **등록 전용**이며 수정 모드는 만들지 않는다 |
| `frontend/src/lib/api/auth.ts` | `AUTH_BASE='/api/auth'`, `REQUESTED_WITH='gamja-market'`, `request()`가 `credentials:'same-origin'`·`cache:'no-store'`, `toApiError()`/`fallbackCode()`/`networkError()` | 동일 패턴으로 `lib/api/requests.ts`를 새로 만든다. 공통 로직은 `lib/api/http.ts`로 추출(5.2). **`auth.ts`의 동작은 변경하지 않는다** |
| `frontend/src/types/auth.ts` | `ApiErrorCode` 10종, `AuthFieldName`, `ApiError` 클래스 | `ApiError`/`ApiErrorBody`를 `types/api.ts`로 이동해 재사용하고, `types/auth.ts`는 re-export로 기존 import 경로를 보존한다 |
| `frontend/src/features/auth/AuthProvider.tsx` | `status`(`loading`/`authenticated`/`anonymous`/`error`), `user`, `refresh/signup/login/logout` | 그대로 사용. 등록 폼의 인증 게이트가 이 `status`를 읽는다(5.4). AuthProvider 자체는 변경하지 않는다 |
| `frontend/src/features/auth/components/GuestOnly.tsx` | 인증 상태면 `/`로 `router.replace`, 복원 중엔 안내 문구 | 반대 방향의 `RequireAuth`를 같은 패턴으로 추가한다(5.4) |
| `frontend/src/components/layout/Header.tsx` | 검색 폼이 `router.push('/?q=...')`. `/requests/new` 링크는 인증 여부와 무관하게 항상 노출 | 변경 없음. 링크는 유지하고 `/requests/new` 페이지에서 게이트한다 |
| `frontend/next.config.ts` | rewrite가 **`/api/auth/:path*` 한 개뿐**. `VERCEL==='1'`이면 rewrite 없음 | **`/api/:path*`로 확장이 필요하다.** 이것이 없으면 로컬에서 `/api/requests`가 Next.js 404가 된다(3.4) |
| `vercel.json` | `rewrites`의 `/api/:path*` → backend service. 이미 전체 `/api/*` 대상 | 변경 불필요. 운영에서는 `/api/requests`가 그대로 FastAPI로 전달된다 |
| `frontend/src/lib/format.ts` | `formatPrice`, `formatPriceRange`, `formatRelativeTime`, `formatDateTime` | 변경 없음 |
| `frontend/src/components/ui/Badge.tsx` | `RequestStatus` 3종 → `구해요`/`매칭됨`/`마감` | 변경 없음 |

### 2.2 백엔드

| 조사한 진입점 | 현재 상태 (확인된 사실) | 이번 단계의 결정 |
| --- | --- | --- |
| `backend/app/main.py` | `app.include_router(auth_router)`. `auth_no_store` 미들웨어가 **`/api/auth/`로 시작하는 경로에만** `Cache-Control: no-store` 설정. `RequestValidationError` 핸들러의 `allowed = {"email","password","password_confirmation"}` | `requests_router` 등록. 검증 핸들러의 필드 화이트리스트를 라우터별로 분기(4.5). 캐시 정책은 3.3 |
| `backend/app/api/deps.py:44-51` | `require_auth_post_request`가 Origin ∈ `settings.auth_allowed_origins` 및 `X-Requested-With == 'gamja-market'` 검사, 미충족 시 403 `INVALID_ORIGIN`. Content-Type이 `application/json`이 아니면 415 | **이름과 동작 모두 그대로 재사용**한다. 3단계의 쓰기는 `POST` 하나뿐이라 시그니처를 바꿀 이유가 없다 |
| `backend/app/api/deps.py:54-85` | `get_current_user`가 쿠키 토큰 → `get_session_user` → 만료 검사 → `User` 반환, 실패 시 401 `UNAUTHENTICATED` + 쿠키 만료 | 등록(`POST`)에 `Depends(get_current_user)`로 재사용. 추가로 **선택적** 인증 의존성 `get_optional_user`를 신설(4.3) |
| `backend/app/api/errors.py` | `ERROR_MESSAGES` 9종, `error_response()`, `ApiError(HTTPException)` | `NOT_FOUND` 1종만 추가한다. 소유권·상태 충돌 코드는 수정·삭제와 함께 이후 작업으로 미룬다(4.5) |
| `backend/app/db/models.py` | `Base`, `User`(schema `app_private`), `AuthSession`. `User.id`가 `UUID(as_uuid=True)` | 같은 `Base`에 `PurchaseRequest` 모델 추가. 스키마는 `app_private` 유지(3.1) |
| `backend/app/db/session.py` | `create_session_factory()` + `NullPool`, `get_db()` 제너레이터 | 변경 없음. 그대로 사용 |
| `backend/app/repositories/users.py`, `sessions.py` | 얇은 함수형 repository. `db.scalar(select(...))` 수준, 커밋하지 않음 | 동일 규약으로 `repositories/requests.py` 추가(3.5) |
| `backend/app/services/auth.py` | 예외(`EmailAlreadyExists`/`InvalidCredentials`/`ServiceUnavailable`) 정의, `SQLAlchemyError` → `rollback()` + `_log_database_failure()` + `ServiceUnavailable`. 자격증명·연결문자열을 로그에 남기지 않음 | 동일 패턴으로 `services/requests.py`. `_log_database_failure`는 `core/db_logging.py`로 추출해 공유(3.5) |
| `backend/app/schemas/auth.py` | `AuthInput(extra='forbid')`, `StrictStr`, `field_validator` | 동일 스타일로 `schemas/requests.py`. `extra='forbid'`와 strict 타입을 유지 |
| `backend/migrations/versions/0001_create_auth_tables.py` | `CREATE SCHEMA IF NOT EXISTS app_private` 후 `users`/`auth_sessions` 생성. `down_revision = None` | 새 revision `0002_create_purchase_requests`, `down_revision = "0001_create_auth_tables"`(3.6) |
| `backend/migrations/env.py` | `config.set_main_option("sqlalchemy.url", get_settings().migration_database_url)`, `include_schemas=True`, `target_metadata = Base.metadata` | 변경 없음. 새 모델이 같은 `Base`이므로 자동 반영 |
| `backend/tests/conftest.py` | 세션 스코프 `migrate_database`(alembic upgrade head), 함수 스코프 `clean_database`가 `TRUNCATE app_private.auth_sessions, app_private.users CASCADE`, `client`, `post_headers` fixture | `TRUNCATE` 대상에 `app_private.purchase_requests` 추가 필요. `post_headers`는 그대로 재사용 |
| `backend/tests/test_auth.py` (99줄) | 실제 DB에 대한 통합 테스트. `assert_error()` 헬퍼가 status/`no-store`/`code`/`fields` dict를 확인 | **수정하지 않는다.** 새 `tests/test_requests.py`가 같은 헬퍼 스타일을 따른다 |
| `backend/app/core/config.py` | `Settings`에 `database_url`, `auth_allowed_origins`, `session_cookie_*`. `extra='ignore'` | 신규 설정 없음. 기본 페이지 크기 등은 코드 상수로 둔다 |

---

## 3. 시스템 설계

### 3.1 DB 스키마

`app_private` 스키마에 테이블 하나를 추가한다. 2단계의 `app_private.users`를 그대로 참조한다.

```
app_private.purchase_requests
├── id             uuid        PK, default gen_random_uuid() 아님 — 애플리케이션이 uuid4 생성 (users와 동일 방식)
├── buyer_id       uuid        NOT NULL, FK → app_private.users(id) ON DELETE CASCADE
├── title          varchar(60)  NOT NULL
├── description    text         NOT NULL
├── category       varchar(30)  NOT NULL
├── condition      varchar(10)  NOT NULL
├── price_min      integer      NOT NULL
├── price_max      integer      NOT NULL
├── region         varchar(50)  NOT NULL
├── status         varchar(10)  NOT NULL DEFAULT 'open'  -- 3단계는 항상 'open'. 전이 경로 없음
├── thumbnail_url  text         NULL        -- 5단계 전까지 항상 NULL. 3단계 API는 입력받지 않음
├── created_at     timestamptz  NOT NULL DEFAULT now()
└── updated_at     timestamptz  NOT NULL DEFAULT now()  -- 3단계는 created_at과 항상 동일
```

제약과 인덱스 — `users` 테이블이 `ck_users_email_normalized` 같은 CHECK를 두는 방식을 따른다.

| 이름 | 종류 | 정의 | 이유 |
| --- | --- | --- | --- |
| `ck_purchase_requests_price_range` | CHECK | `price_min >= 0 AND price_max >= price_min` | 애플리케이션 검증을 DB가 최종 보증 |
| `ck_purchase_requests_price_max_bound` | CHECK | `price_max <= 1000000000` | integer overflow와 비현실적 입력 차단 |
| `ck_purchase_requests_status` | CHECK | `status IN ('open','matched','closed')` | `RequestStatus`와 1:1 |
| `ck_purchase_requests_condition` | CHECK | `condition IN ('any','new','like_new','used')` | `ProductCondition`과 1:1 |
| `ck_purchase_requests_title_len` | CHECK | `char_length(btrim(title)) BETWEEN 2 AND 60` | 폼 검증과 동일 경계 |
| `ck_purchase_requests_description_len` | CHECK | `char_length(btrim(description)) BETWEEN 10 AND 1000` | 폼 검증과 동일 경계 |
| `ck_purchase_requests_updated_after_created` | CHECK | `updated_at >= created_at` | `auth_sessions`의 `ck_auth_sessions_expiry_after_created`와 같은 취지 |
| `ix_purchase_requests_created_at_id` | INDEX | `(created_at DESC, id DESC)` | 기본 정렬 + 키셋 페이지네이션 |
| `ix_purchase_requests_buyer_id` | INDEX | `(buyer_id)` | 내 요청 조회, FK 삭제 성능 |
| `ix_purchase_requests_category` | INDEX | `(category)` | 카테고리 필터 |
| `ix_purchase_requests_status` | INDEX | `(status)` | `status=open` 필터 |

`updated_at`과 `status`는 컬럼으로 만들되 3단계에는 **이를 변경하는 API 경로가 없다.** 수정·삭제(이후 작업)와 매칭 상태 전이(7단계)가 도입될 때 migration 없이 바로 쓰기 위해 지금 정의해 둔다. 3단계에서 `updated_at`은 삽입 시각으로 고정되고 `status`는 항상 `'open'`이다.

**`applicant_count`는 컬럼으로 두지 않는다.** 4단계에서 지원 테이블이 생기기 전까지 실제 지원 건수는 언제나 0이므로, 3단계 API는 `applicantCount: 0`을 **계산된 상수**로 응답한다. 컬럼을 미리 만들면 4단계에서 집계와 이중 관리가 된다. 이 결정은 4단계에서 `applicants` 테이블 + `COUNT` 집계 또는 비정규화 컬럼으로 대체한다.

`ENUM` 타입 대신 `varchar + CHECK`를 쓰는 이유: 7단계에서 상태 전이가 추가될 때 `ALTER TYPE`보다 CHECK 교체가 migration으로 다루기 쉽다.

### 3.2 구매자 표시 정보

2단계 회원은 `id`, `email`, `password_hash`, `created_at`만 가진다(`app/db/models.py`의 `User`). 닉네임·지역 컬럼이 없다.

- **닉네임·지역 프로필을 도입하지 않는다.** 2단계 설계가 "역할이나 프로필은 받지 않는다"고 못박았고, 이를 되돌리면 2단계 인증 설계를 변경하게 된다.
- **목업 회원을 DB로 이관하지 않는다.** 2단계 설계서가 이미 "목업 회원을 DB로 이관하거나 가짜 프로필을 생성하지 않는다"고 결정했다.
- 상세 화면의 구매자 표시는 **이메일 로컬파트 마스킹**을 쓴다. 서버가 마스킹을 수행하고 전체 이메일은 응답에 넣지 않는다.
  - 규칙: `@` 앞 부분에서 첫 2자를 남기고 나머지를 `*`로 치환, 도메인은 그대로. 로컬파트가 1자면 그 1자 + `*`.
  - 예: `buyer@example.com` → `bu***@example.com`, `a@example.com` → `a*@example.com`
  - 자기 자신의 요청을 볼 때도 같은 마스킹을 쓴다. 뷰어에 따라 응답이 달라지면 캐시·테스트가 복잡해진다.
- 요청 목록/상세의 "거래 지역"은 회원 프로필이 아니라 **구매요청의 `region` 필드**다. 이미 폼과 목업에 존재한다.

### 3.3 요청 경로와 캐시

- 브라우저는 백엔드 주소를 직접 호출하지 않는다. 2단계와 동일하게 **동일 출처 상대 경로**만 쓴다.
- 새 경로 접두사는 **`/api/requests`**다. `/api/auth`와 형제 관계다.
- 로컬: `frontend/next.config.ts`의 rewrite를 `/api/auth/:path*`에서 **`/api/:path*`**로 넓힌다. 운영: `vercel.json`이 이미 `/api/:path*`를 backend로 보낸다.
- 캐시 정책:
  - `main.py`의 `auth_no_store` 미들웨어는 `/api/auth/`에만 적용된다. 이를 **변경하지 않고**, 구매요청 응답의 캐시 헤더는 라우터에서 명시한다.
  - 모든 `/api/requests*` 응답에 `Cache-Control: no-store`를 설정한다. 목록에 소유권 기반 필드(`isOwner`)가 포함되고 세션 쿠키로 값이 달라지므로 공유 캐시에 남기지 않는다.
  - Next.js 측 fetch는 `cache: 'no-store'`를 쓴다(`lib/api/auth.ts`와 동일).
- 3단계의 상태 변경은 **`POST /api/requests` 하나뿐**이며, 기존 `require_auth_post_request`의 Origin + `X-Requested-With: gamja-market` + `Content-Type: application/json` 검사를 그대로 통과해야 한다. 의존성 함수는 **이름과 동작을 모두 그대로 둔다** — 본문 없는 메서드를 위한 매개변수화는 `DELETE`를 도입하는 이후 작업에서 한다.
- CORS는 활성화하지 않는다.

### 3.4 서버 컴포넌트에서의 호출

목록·상세 페이지는 서버 컴포넌트다. 서버에서 `fetch('/api/requests')` 상대 경로는 동작하지 않으므로:

- 서버 컴포넌트는 **절대 URL**로 FastAPI를 호출한다. 기준 origin은 로컬 `BACKEND_API_ORIGIN`, Vercel에서는 backend service origin이다. 이 값을 `lib/api/serverBase.ts` 한 곳에서 결정한다.
- 목록/상세는 공개 데이터이므로 서버 컴포넌트 호출에 **쿠키를 전달하지 않는다.** 따라서 서버 렌더 결과에는 `isOwner`가 항상 `false`다.
- 3단계에는 소유자 전용 UI가 없으므로 `isOwner`를 읽는 화면도 없다. 이 필드는 **응답 계약에만 존재**하며, 수정·삭제 UI를 도입하는 이후 작업이 곧바로 쓸 수 있도록 지금 정의해 둔다(4.2).
- 해당 origin을 결정할 수 없으면 페이지는 목업으로 되돌아가지 않고 오류 상태를 렌더링한다.

### 3.5 백엔드 레이어 경계

2단계가 확립한 `api → services → repositories → db` 경계를 그대로 따른다.

| 레이어 | 파일 | 책임 | 하지 않는 일 |
| --- | --- | --- | --- |
| API | `app/api/requests.py` | 라우팅, 의존성(인증·Origin), 도메인 예외 → `ApiError` 변환, 상태 코드, `Cache-Control` | SQL, 커밋, 비즈니스 규칙 |
| Schema | `app/schemas/requests.py` | Pydantic 입출력 모델, 정규화(trim), 필드 단위 검증 | DB 접근 |
| Service | `app/services/requests.py` | 트랜잭션 경계(`commit`/`rollback`), `SQLAlchemyError` → `ServiceUnavailable`, 이메일 마스킹 | HTTP 개념(status code, 헤더) |
| Repository | `app/repositories/requests.py` | `select`/`insert` 구성과 실행 | `commit()`, 예외 변환 |

- repository 함수는 `services/auth.py`가 `repositories/users.get_by_email`을 쓰는 방식과 동일하게 **커밋하지 않는다.**
- `services/auth.py:26-56`의 `_log_database_failure`를 `app/core/db_logging.py`로 이동하고 `services/auth.py`는 그 함수를 import한다. 로그 내용과 포맷은 그대로다(연결 문자열·자격증명 미기록).
- 도메인 예외: `RequestNotFound`, 그리고 `auth`와 공유하는 `ServiceUnavailable`(`app/services/errors.py`로 이동, `services/auth.py`는 re-export로 기존 import 경로 보존). 소유권·상태 충돌 예외는 수정·삭제를 도입하는 이후 작업에서 추가한다.

### 3.6 마이그레이션

- 새 revision 파일: `backend/migrations/versions/0002_create_purchase_requests.py`
- `revision = "0002_create_purchase_requests"`, `down_revision = "0001_create_auth_tables"`
- `upgrade()`는 `app_private.purchase_requests` 테이블과 3.1의 CHECK·인덱스를 생성한다. `0001`이 이미 `CREATE SCHEMA IF NOT EXISTS app_private`를 수행했으므로 스키마 생성은 반복하지 않는다.
- `downgrade()`는 인덱스 → 테이블 순으로 drop한다. **`DROP SCHEMA`를 하지 않는다**(`users`/`auth_sessions`가 남아 있다).
- 시드 데이터를 넣지 않는다. 목업 12건을 DB에 심지 않는다. 빈 DB에서 시작해 화면의 빈 상태(6.2)로 대응한다.
- 배포 절차는 `04-login-register-deployment-fix.md`의 3번 항목과 동일하다. 런타임 서비스 시작과 분리해 `uv run alembic upgrade head`를 수행한다.

---

## 4. API 계약

### 4.1 입력 규칙과 카테고리

현재 `RequestForm.tsx`의 클라이언트 검증 경계를 서버 계약으로 승격한다. 두 곳이 같은 값을 쓴다.

| 필드 | 타입 | 규칙 | 근거 |
| --- | --- | --- | --- |
| `title` | string | trim 후 2~60자 | `RequestForm.tsx` "제목은 2자 이상 60자 이하", `input maxLength={60}` |
| `category` | string | 아래 고정 목록 중 하나 | `RequestForm.tsx`의 `categories` 배열 |
| `description` | string | trim 후 10~1000자 | `RequestForm.tsx` "10자 이상 1000자 이하", `textarea maxLength={1000}` |
| `priceMin` | integer | 0 이상, 1,000,000,000 이하 | `input type=number min="0"` |
| `priceMax` | integer | 0 이상, 1,000,000,000 이하, `priceMin` 이상 | "최대가는 최소가보다 크거나 같아야 합니다." |
| `condition` | string | `any` / `new` / `like_new` / `used` | `RequestForm.tsx`의 `conditions`, `types/request.ts`의 `ProductCondition` |
| `region` | string | trim 후 1~50자 | "거래 지역을 입력해 주세요." (현재 길이 상한 없음 → 50자로 확정) |

- **고정 카테고리 목록**: `디지털기기`, `가전`, `가구/인테리어`, `의류`, `도서`, `기타`. 현재 `RequestForm.tsx`의 목록과 정확히 같다. 목업에서 파생하던 `requestCategories`(`mock/requests.ts:200`)를 대체한다.
  - 목록 화면의 필터 칩은 DB의 distinct 값이 아니라 이 **고정 목록**을 쓴다. 데이터가 비어도 필터 UI가 사라지지 않고, 등록 폼과 필터가 항상 일치한다.
  - 서버는 `GET /api/requests/categories`가 아니라 **프론트 상수** `frontend/src/features/requests/categories.ts`에 둔다. 백엔드도 동일 목록을 `app/schemas/requests.py`에 갖는다. 두 곳의 불일치는 테스트로 막는다(8.2의 F27).
- 위 7개 필드는 **모두 필수**다. 3단계의 쓰기는 전체 본문을 받는 `POST` 하나뿐이므로 부분 전달(partial update) 개념이 없다.
- 입력은 JSON만 받는다. `extra='forbid'`이므로 알 수 없는 필드는 422다. `status`, `thumbnailUrl`, `buyerId`, `applicantCount`, `createdAt`, `updatedAt`은 **입력으로 받지 않는다**(보내면 422).
- 문자열은 서버가 trim한 값을 저장한다. 서버가 정규화의 최종 권위다.
- JSON 필드명은 프론트 타입과 동일하게 **camelCase**를 쓴다(`priceMin`). Pydantic `alias_generator`로 내부 snake_case와 매핑한다. 2단계 auth는 `password_confirmation`처럼 snake_case를 쓰지만, 그 계약은 변경하지 않고 새 라우터에만 camelCase를 적용한다. 혼란을 피하기 위해 이 차이를 API 문서와 스키마 주석에 명시한다.

### 4.2 응답 모델

```jsonc
// PurchaseRequestSummary (목록 항목)
{
  "id": "0f8c...-uuid",
  "title": "아이패드 프로 11인치 M2 구합니다",
  "category": "디지털기기",
  "condition": "like_new",
  "priceMin": 650000,
  "priceMax": 850000,
  "region": "서울 강남구",
  "status": "open",
  "thumbnailUrl": null,
  "applicantCount": 0,
  "createdAt": "2026-09-21T08:30:00+00:00",
  "isOwner": false
}

// PurchaseRequestDetail = Summary + 아래 필드
{
  "description": "…",
  "updatedAt": "2026-09-21T08:30:00+00:00",
  "buyer": { "id": "…-uuid", "maskedEmail": "bu***@example.com" }
}
```

- `RequestCard.tsx`가 소비하는 필드(`thumbnailUrl`, `priceMin/Max`, `region`, `status`, `applicantCount`, `createdAt`, `title`)를 모두 포함한다. 목록 응답에 `description`을 넣지 않는다 — 카드가 쓰지 않는다.
- `createdAt`은 ISO 8601 UTC(`+00:00`)다. `formatRelativeTime`/`formatDateTime`은 `new Date(iso)`를 쓰므로 타임존 오프셋과 무관하게 동작한다. 목업은 `+09:00`이었으나 표시 결과는 같다.
- `applicantCount`는 3단계에서 항상 `0`이다(3.1). 지원 기능이 없으므로 이 값을 목업으로 부풀리지 않는다.
- `status`는 3단계에서 항상 `"open"`이고, `updatedAt`은 `createdAt`과 같다. 변경 경로가 없기 때문이다(3.1).
- `isOwner`는 요청의 세션 회원이 `buyer_id`와 같을 때만 `true`다. 쿠키가 없으면 항상 `false`. 3단계에는 이 값을 쓰는 UI가 없으며(3.4), 이후 소유자 액션 작업을 위한 계약이다.
- `buyer.maskedEmail`만 노출한다. 전체 이메일은 어떤 응답에도 넣지 않는다.

### 4.3 엔드포인트

3단계가 제공하는 엔드포인트는 아래 **세 개가 전부**다.

| 메서드 | 경로 | 인증 | 성공 | 설명 |
| --- | --- | --- | --- | --- |
| GET | `/api/requests` | 선택 | 200 | 목록. 검색·필터·정렬·페이지네이션 |
| GET | `/api/requests/{id}` | 선택 | 200 | 상세 |
| POST | `/api/requests` | **필수** | 201 | 등록. 응답은 Detail |

`PATCH /api/requests/{id}`와 `DELETE /api/requests/{id}`는 **이번 단계에서 구현하지 않는다.** 라우터에 등록하지 않으므로 해당 메서드는 FastAPI 기본 405를 반환한다. 이들은 수정·삭제를 다루는 이후 작업의 범위다(1.2).

**`GET /api/requests` 쿼리 파라미터** — 현재 `RequestBrowser.tsx`가 URL에서 읽는 이름을 그대로 쓴다.

| 파라미터 | 값 | 기본값 | 근거 |
| --- | --- | --- | --- |
| `q` | 문자열, trim 후 1~60자 | 없음 | `Header.tsx`의 검색 폼과 `RequestBrowser.tsx:26` |
| `category` | 고정 목록 중 하나 | 없음(전체) | `RequestBrowser.tsx:22` |
| `status` | `open` | 없음(전체) | `RequestBrowser.tsx:23`의 `searchParams.get('status') === 'open'` |
| `sort` | `latest` / `price` / `applicants` | `latest` | `RequestBrowser.tsx:16,25`의 `validSorts` |
| `page` | 1 이상 정수 | `1` | 신규 |
| `pageSize` | 1~50 정수 | `12` | 신규. 목업이 12건이었고 3열 그리드(`RequestList.tsx`)에 맞음 |

- `q`는 `title`에 대한 **대소문자 무시 부분 일치**다. 현재 클라이언트 동작(`title.toLocaleLowerCase('ko-KR').includes(query)`)과 같다. `description`은 검색하지 않는다 — 기존 동작을 바꾸지 않는다. SQL은 `lower(title) LIKE '%' || lower(:q) || '%'`이며 `%`, `_`, `\`를 이스케이프한다.
- 정렬: `latest` → `created_at DESC, id DESC`. `price` → `price_max DESC, created_at DESC, id DESC`(현재 `b.priceMax - a.priceMax`와 동일). `applicants` → 3단계에서는 모든 값이 0이므로 `latest`와 동일한 순서로 폴백하되 파라미터는 **허용**한다(4단계에서 의미가 생긴다). 모든 정렬에 `id`를 tie-breaker로 넣어 페이지 경계에서 항목이 중복·누락되지 않게 한다.
- 알 수 없는 `sort`/`status` 값은 422가 아니라 **기본값으로 처리**한다. 현재 `RequestBrowser.tsx`가 `validSorts.includes()`로 조용히 폴백하므로 동작을 유지한다. 반면 `page`/`pageSize`가 범위를 벗어나면 422다(의도적 입력이므로).
- 목록 응답 봉투:

```jsonc
{
  "items": [ /* PurchaseRequestSummary[] */ ],
  "total": 37,
  "page": 1,
  "pageSize": 12
}
```

`total`은 필터 적용 후의 전체 건수다. `RequestFilterBar.tsx`의 `resultCount`에 이 값을 넣는다.

- **`GET`의 선택적 인증**: 신규 의존성 `get_optional_user`는 쿠키가 없거나 세션이 유효하지 않으면 `None`을 반환하고 **401을 던지지 않는다.** 단 `get_current_user`와 달리 세션 쿠키를 만료시키지 않는다 — 공개 GET이 로그인 상태를 지우면 안 된다. DB 오류는 여기서도 503이다.
- **`POST` 본문**: 4.1의 7개 필드를 모두 받는다. `buyer_id`는 세션에서, `status`는 `'open'`으로, `created_at`/`updated_at`은 `now()`로 서버가 채운다. 응답은 방금 저장된 행의 Detail이다.

### 4.4 인증·소유권 규칙

| 상황 | 결과 |
| --- | --- |
| 비로그인 + 목록/상세 GET | 200. `isOwner: false` |
| 로그인 + 목록/상세 GET | 200. 본인 요청에만 `isOwner: true` |
| 비로그인 + `POST` | 401 `UNAUTHENTICATED` |
| 만료·위조 세션 + `POST` | 401 `UNAUTHENTICATED` |
| 존재하지 않는 id + 상세 GET | 404 `NOT_FOUND` |
| Origin/`X-Requested-With` 누락 + `POST` | 403 `INVALID_ORIGIN` (기존 계약) |
| `PATCH`/`DELETE` 요청 | 405 (라우터에 미등록. 이후 작업) |

- 3단계에 **소유권으로 거부되는 경로가 없다.** 쓰기는 등록 하나뿐이고, 등록은 세션 회원 본인의 행을 만드는 동작이므로 타인 소유 자원을 건드릴 여지가 없다. 소유권 기반 거부(403/404 선택, 상태 충돌 409)는 수정·삭제를 도입하는 이후 작업에서 설계한다.
- `buyer_id`는 **항상 서버에서** `get_current_user`가 반환한 `User.id`로 채운다. 요청 본문이나 쿼리의 `buyerId`를 신뢰하지 않는다(입력에 존재하지도 않는다. 보내면 422).
- `isOwner`는 조회 응답의 정보 필드일 뿐 권한 판정이 아니다. 3단계에는 이 값에 따라 달라지는 동작이 없다.
- 판매자 지원 기능이 없으므로 "판매자" 역할 개념은 이 단계에 도입하지 않는다.

### 4.5 오류 계약

2단계 계약(`{"error": {"code", "message", "fields"}}`)을 그대로 쓴다. `app/api/errors.py`의 `ERROR_MESSAGES`에 **1개만** 추가한다.

| code | status | 메시지 | 발생 |
| --- | --- | --- | --- |
| `NOT_FOUND` | 404 | `요청을 찾을 수 없습니다.` | 상세 조회 시 없는 id |

`FORBIDDEN`(403)과 `CONFLICT_STATE`(409)는 **이번 단계에서 추가하지 않는다.** 3단계에는 이들을 발생시키는 경로가 없고(4.4), 쓰이지 않는 코드를 미리 심으면 프론트 `ApiErrorCode`와 테스트가 실재하지 않는 분기를 떠안는다. 수정·삭제를 도입하는 이후 작업이 그 시점의 404/403 선택과 함께 정의한다.

기존 `VALIDATION_ERROR`, `UNAUTHENTICATED`, `INVALID_ORIGIN`, `UNSUPPORTED_MEDIA_TYPE`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`는 코드·메시지를 **변경하지 않는다.**

**필드 오류**: `main.py`의 `validation_error_handler`는 현재 `allowed = {"email","password","password_confirmation"}`로 필드를 걸러낸다. 비밀번호 값이 Pydantic의 `input`/`ctx`를 통해 새어나가지 않게 하기 위한 장치다. 구매요청에는 비밀번호가 없지만 **같은 안전장치를 유지**한다:

- 핸들러를 경로 기준으로 분기한다. `/api/requests`로 시작하면 허용 필드는 `{title, category, description, priceMin, priceMax, condition, region, page, pageSize, q, sort, status}`다. 목록 쿼리 파라미터(`page`/`pageSize`)도 422를 낼 수 있으므로 포함한다.
- 값은 여전히 직렬화하지 않고 고정 메시지만 넣는다. 다만 구매요청은 사용자에게 무엇이 잘못됐는지 알려야 하므로 필드별 메시지를 `RequestForm.tsx`의 현재 문구와 일치시킨다.

| field | message |
| --- | --- |
| `title` | `제목은 2자 이상 60자 이하로 입력해 주세요.` |
| `category` | `카테고리를 선택해 주세요.` |
| `description` | `원하는 스펙은 10자 이상 1000자 이하로 입력해 주세요.` |
| `priceMin` | `최소가는 0원 이상으로 입력해 주세요.` |
| `priceMax` | `최대가는 최소가보다 크거나 같아야 합니다.` |
| `condition` | `희망 상태를 선택해 주세요.` |
| `region` | `거래 지역을 입력해 주세요.` |

프론트는 `message` 문자열이 아니라 **`code`로 분기**하고, `fields`의 값은 해당 입력 아래에 그대로 표시한다(`types/auth.ts`의 기존 주석과 동일한 원칙).

---

## 5. 프론트엔드 설계

### 5.1 라우트

라우트는 **기존 세 개 그대로**이며 새 라우트를 추가하지 않는다.

| 경로 | 렌더링 | 인증 | 변경 |
| --- | --- | --- | --- |
| `/` | 서버 컴포넌트 + 클라이언트 필터 | 공개 | 목업 → `GET /api/requests` |
| `/requests/[id]` | 서버 컴포넌트 | 공개 | 목업 → `GET /api/requests/{id}`. `generateStaticParams` 삭제 |
| `/requests/new` | 클라이언트 | **로그인 필요** | 목업 안내 → `POST /api/requests` |

- `/` 와 `/requests/[id]`는 `export const dynamic = 'force-dynamic'`으로 요청마다 렌더한다. DB 데이터가 정적 생성 대상이 아니고, 필터 파라미터가 URL에서 오기 때문이다.
- **`/requests/[id]/edit`은 만들지 않는다.** 수정 라우트와 삭제 동작은 이후 작업이다(1.2).

### 5.2 API 클라이언트

- `frontend/src/lib/api/http.ts` — **신규**. `lib/api/auth.ts`의 `request`/`toApiError`/`fallbackCode`/`networkError`/`isRecord`를 옮긴 공용 모듈. `credentials: 'same-origin'`, `cache: 'no-store'`, POST의 `X-Requested-With: gamja-market` 규약을 유지한다.
- `frontend/src/lib/api/auth.ts` — `http.ts`를 쓰도록 내부만 정리한다. **export 시그니처와 동작은 변경하지 않는다.** 기존 `tests/authApi.test.ts`가 그대로 통과해야 한다.
- `frontend/src/lib/api/requests.ts` — **신규**. 함수는 **세 개뿐**이며 엔드포인트 표(4.3)와 1:1이다.
  - `listRequests(params, opts)` → `{ items, total, page, pageSize }`
  - `getRequest(id, opts)` → `PurchaseRequestDetail`
  - `createRequest(payload)` → `PurchaseRequestDetail`
  - `updateRequest`/`deleteRequest`는 **만들지 않는다.** 호출할 엔드포인트가 없다.
  - 응답은 `readUser()`와 같은 방식으로 **런타임 형태 검증**을 거친다. 필수 필드가 없거나 타입이 다르면 `INTERNAL_ERROR`로 던진다. 목업으로 대체하지 않는다.
- `frontend/src/lib/api/serverBase.ts` — **신규**. 서버 컴포넌트용 절대 URL 해석(3.4).
- `frontend/src/types/api.ts` — **신규**. `ApiError`, `ApiErrorBody`, `ApiErrorCode`를 옮긴다. `types/auth.ts`는 이 모듈을 re-export해 기존 import 경로(`@/types/auth`)를 깨지 않는다. `ApiErrorCode`에는 `NOT_FOUND` **하나만** 추가한다(4.5). `fallbackCode()`의 404 → `NOT_FOUND` 매핑도 함께 넣는다.

### 5.3 목록 데이터 흐름

현재 `RequestBrowser`가 클라이언트에서 filter+sort를 수행한다. 전체 데이터가 메모리에 있다는 전제이므로 DB 페이지네이션과 양립하지 않는다.

```
/ (server component)
  searchParams { q, category, status, sort, page }
      │
      ▼
  listRequests(...)  ── 절대 URL, 쿠키 미전달 ──▶  GET /api/requests?...
      │
      ▼
  <RequestBrowser items total page pageSize categories ... />   (client)
      │  URL만 갱신 (router.replace/push)
      ├─▶ <RequestFilterBar resultCount={total} ... />
      └─▶ <RequestList requests={items} />  →  <RequestCard />
```

- `RequestBrowser`에서 `useMemo` 기반 filter/sort를 **제거**한다. URL 갱신 로직(`updateParam`)과 `validSorts` 폴백은 유지한다.
- 필터 변경은 `router.replace`(현재 동작 유지), 페이지 이동은 `router.push`다. 필터를 바꾸면 `page`를 삭제해 1페이지로 돌아간다.
- `categories`는 `features/requests/categories.ts`의 고정 상수를 쓴다(4.1).
- 페이지네이션 UI는 `RequestList` 아래에 "이전 / n / 다음" 형태로 추가한다. `total <= pageSize`면 렌더하지 않는다.

### 5.4 등록 폼과 인증 게이트

- `frontend/src/features/auth/components/RequireAuth.tsx` — **신규**. `GuestOnly.tsx`를 뒤집은 형태다.
  - `status === 'loading'` → "로그인 상태를 확인하고 있어요…" (`role="status"`)
  - `status === 'anonymous'` → `router.replace('/login?next=/requests/new')`
  - `status === 'error'` → 리다이렉트하지 않는다. 복원 실패를 비로그인으로 단정하면 안 된다(`AuthProvider`의 기존 원칙). 오류 안내 + `refresh()` 재시도 버튼을 보여준다.
  - `status === 'authenticated'` → children
- `/login`의 `next` 파라미터 처리: 로그인 성공 후 `next`가 **앱 내부 상대 경로**(`/`로 시작하고 `//`가 아님)일 때만 그 경로로 이동한다. 아니면 `/`로 간다. 이 검증이 없으면 오픈 리다이렉트가 된다.
- `RequestForm`의 변경:
  - `submitted` 상태와 "아직 저장 기능이 없습니다(3단계 예정)" 안내를 **제거**한다.
  - 클라이언트 검증(현재 로직)을 **그대로 유지**하고, 통과하면 `createRequest()`를 호출한다.
  - 제출 중에는 submit 버튼을 `disabled`로 두고 레이블을 "등록 중…"으로 바꾼다. 중복 제출을 막는다.
  - 성공: `router.push('/requests/{id}')` + `router.refresh()`. 등록한 요청 상세로 바로 이동한다.
  - 실패: `ApiError.fields`를 필드 오류에 병합하고, `fields`가 비어 있으면 폼 상단에 `role="alert"` 요약을 보여준다. 입력값은 지우지 않는다.
  - `UNAUTHENTICATED`(세션이 중간에 만료된 경우): "다시 로그인해 주세요" 안내와 `/login?next=/requests/new` 링크를 보여준다. 입력값은 유지한다.
  - 사진 업로드 버튼은 **현재 그대로 비활성**으로 둔다. "사진 업로드 · 5단계에서 지원" 문구를 유지한다.
  - **수정 모드를 만들지 않는다.** `mode`/`initialValues` props를 도입하지 않고 등록 전용 컴포넌트로 유지한다. 수정 UI는 이후 작업에서 이 폼을 재사용하도록 확장한다.

### 5.5 상세 화면

- `RequestDetail`의 구매자 aside에서 `request.buyer.nickname` / `request.buyer.region`을 `buyer.maskedEmail`로 교체한다. 지역은 요청의 `region`으로 이미 dl에 표시되고 있으므로 aside에서는 뺀다.
- **소유자 전용 수정·삭제 버튼을 추가하지 않는다.** `RequestDetail`은 서버 컴포넌트로 그대로 두고, 소유 여부에 따라 달라지는 UI를 도입하지 않는다. 이는 이후 작업이다(1.2).
- 하단 "지원하기 · 준비 중" 비활성 버튼과 "판매자 지원 기능은 4단계에서 열립니다." 문구는 **유지**한다.
- **판매자 지원 영역의 정직한 0건 상태**:
  - `app/requests/[id]/page.tsx`는 `getApplicantsByRequestId()` 대신 **빈 배열 `[]`**을 `RequestDetail`에 넘긴다. 목업 import를 제거한다.
  - `ApplicantList`는 **수정하지 않는다.** 이미 `applicants.length === 0`일 때 "아직 지원한 판매자가 없어요 / 좋은 판매자가 곧 찾아올 거예요."를 렌더하고, 제목도 "지원한 판매자 0명"이 된다.
  - 표시되는 0은 목업의 부재가 아니라 **실제 지원 건수**다. `applicantCount: 0`(4.2)과 정확히 일치한다.
  - 4단계에서 이 자리에 지원 API 결과를 연결한다. 그때까지 가짜 지원자를 만들지 않는다.

---

## 6. 로딩 · 빈 상태 · 오류 상태

### 6.1 로딩

| 화면 | 방식 |
| --- | --- |
| `/` 첫 렌더 | `app/loading.tsx`(신규) 또는 기존 `RequestBrowserFallback`의 스켈레톤(`page.tsx:7-9`)을 Suspense fallback으로 유지 |
| `/` 필터·페이지 전환 | `useTransition`의 `isPending`으로 목록에 `aria-busy="true"`와 흐림 처리. 이전 결과를 계속 보여준다(깜빡임 방지) |
| `/requests/[id]` | `app/requests/[id]/loading.tsx`(신규) 카드 스켈레톤 |
| 폼 제출 | 버튼 `disabled` + "등록 중…" |
| 인증 복원 중 | `RequireAuth`의 `role="status"` 안내(5.4) |

### 6.2 빈 상태

`RequestList.tsx`는 현재 한 가지 문구만 쓴다. 두 경우를 구분한다.

| 경우 | 판정 | 문구 |
| --- | --- | --- |
| 필터 결과 없음 | `total === 0` && 필터·검색어 있음 | 현재 문구 유지: "조건에 맞는 구매요청이 없어요" / "검색어나 필터를 바꾸면 더 많은 요청을 볼 수 있어요." + "필터 초기화" 링크 |
| 데이터 자체 없음 | `total === 0` && 필터·검색어 없음 | "아직 등록된 구매요청이 없어요" / "첫 번째 구매요청을 등록해 보세요." + `/requests/new` 링크 |
| 상세: 없는 id | 404 `NOT_FOUND` | `notFound()` → 기존 `app/not-found.tsx` |

상세 화면의 판매자 지원 영역도 같은 원칙을 따른다. 지원자가 0명이면 `ApplicantList`의 기존 빈 상태("아직 지원한 판매자가 없어요")를 그대로 보여준다(5.5).

빈 상태에서 **목업 데이터를 채우지 않는다.** 빈 DB도, 지원자 0명도 정상 상태다.

### 6.3 오류

| 상황 | 화면 |
| --- | --- |
| 목록 fetch 실패 (503 / `NETWORK_ERROR` / 형태 불일치) | 목록 자리에 `role="alert"` 오류 블록 + "다시 시도" 버튼(`router.refresh()`). **목업으로 대체하지 않는다** |
| 상세 fetch 실패 (404 외) | 동일한 오류 블록. 404만 `notFound()` |
| 등록 422 | `fields`를 입력별 오류로 표시. 입력값 보존 |
| 등록 401 | 재로그인 안내 + `next` 포함 링크. 입력값 보존 |
| 등록 403 `INVALID_ORIGIN` | "요청을 처리할 수 없습니다. 새로고침 후 다시 시도해 주세요." |
| 503 / 500 | "잠시 후 다시 시도해 주세요." + 재시도 버튼 |
| `app/error.tsx` | 서버 컴포넌트에서 던져진 예외의 최후 방어선(신규) |

- 오류 문구는 서버의 `message`를 우선 쓰고, 없으면 `code`별 프론트 기본 문구를 쓴다. 분기는 항상 `code` 기준이다.
- 어떤 오류 경로에서도 목업 데이터로 폴백하지 않는다.

---

## 7. 목업 데이터 제거 목록

3단계가 끝나면 **`frontend/src/lib/mock/` 디렉터리 전체가 사라진다.** 애플리케이션 목업 데이터는 하나도 남기지 않는다.

### 7.1 삭제하는 파일

| 파일 | 현재 export | 사용처(확인됨) | 대체 |
| --- | --- | --- | --- |
| `frontend/src/lib/mock/requests.ts` (205줄) | `mockRequests`(12건), `requestCategories`, `getRequestById()` | `app/page.tsx:4,26`, `app/requests/[id]/page.tsx:6,13,18,24`, `tests/mockData.test.ts:4` | `lib/api/requests.ts`(DB 조회) + `features/requests/categories.ts`(고정 상수) |
| `frontend/src/lib/mock/users.ts` (14줄) | `mockUsers`(9명: 구매자 6 + 판매자 3) | `lib/mock/requests.ts:3`, `lib/mock/applicants.ts:3` | 없음. 두 소비자가 모두 삭제되므로 대체 불필요. 구매자 표시는 서버의 `buyer.maskedEmail`(3.2) |
| `frontend/src/lib/mock/applicants.ts` (75줄) | `mockApplicants`(21건), `getApplicantsByRequestId()` | `app/requests/[id]/page.tsx:5,28` | 없음. 상세 페이지가 빈 배열 `[]`을 넘기고 `ApplicantList`의 기존 0건 빈 상태를 쓴다(5.5) |
| `frontend/tests/mockData.test.ts` (37줄) | — (테스트) | 목업 12건의 다양성·지원자 수 일치 검증 | **파일 삭제.** 검증 대상이 모두 사라진다 |

세 소스 파일을 모두 지우면 `frontend/src/lib/mock/` 디렉터리도 함께 제거된다. 삭제 후 `src/` 어디에도 `lib/mock` import가 남지 않아야 하며, 이를 F26이 기계적으로 검증한다.

### 7.2 수정하는 사용처

| 파일:줄 | 현재 | 변경 후 |
| --- | --- | --- |
| `app/page.tsx:4` | `import { mockRequests, requestCategories } from '@/lib/mock/requests'` | `import { listRequests } from '@/lib/api/requests'` + `import { requestCategories } from '@/features/requests/categories'` |
| `app/page.tsx:26` | `<RequestBrowser requests={mockRequests} categories={requestCategories} />` | `<RequestBrowser items={...} total={...} page={...} pageSize={...} categories={requestCategories} />` |
| `app/requests/[id]/page.tsx:5` | `import { getApplicantsByRequestId } from '@/lib/mock/applicants'` | **import 삭제** |
| `app/requests/[id]/page.tsx:6` | `import { getRequestById, mockRequests } from '@/lib/mock/requests'` | `import { getRequest } from '@/lib/api/requests'` |
| `app/requests/[id]/page.tsx:12-14` | `generateStaticParams()`가 `mockRequests` 순회 | **함수 삭제** |
| `app/requests/[id]/page.tsx:18,24` | `getRequestById(id)` | `await getRequest(id)`. `NOT_FOUND`면 `notFound()` |
| `app/requests/[id]/page.tsx:28` | `const applicants = getApplicantsByRequestId(request.id)` | `const applicants: Applicant[] = []` — 지원 API가 생기는 4단계까지 실제 0건(5.5) |
| `types/request.ts` | `PurchaseRequest.buyer: UserSummary` | `buyer: RequestBuyer{id, maskedEmail}`. `Applicant`/`UserSummary` **타입 선언은 유지**한다(`ApplicantList`의 prop 타입으로 여전히 필요). 목업 데이터만 사라진다 |

`tests/SignupForm.test.tsx`, `tests/HeaderAuth.test.tsx`, `tests/authApi.test.ts`, `tests/LoginForm.test.tsx`, `tests/AuthProvider.test.tsx`도 grep에 "mock"으로 걸리지만, 이는 `vi.mock`/`vi.fn` 사용이며 **목업 데이터와 무관하다. 수정하지 않는다.**

### 7.3 지원자 목업을 제거해도 기능이 줄지 않는 이유

목업 지원자를 지우면 화면이 비어 보일 수 있다는 우려가 있으나, 실제로는 **어느 쪽이든 화면이 같다.**

- 목업 지원자 id는 `request-001` 형태이고 DB가 발급하는 요청 id는 UUID다. 따라서 `getApplicantsByRequestId(uuid)`는 목업을 남겨두더라도 **언제나 빈 배열**을 반환한다. 목업을 유지하는 선택은 화면에 아무것도 더해주지 못하면서 죽은 코드만 남긴다.
- `ApplicantList`는 이미 0건 빈 상태를 갖추고 있다(`applicants.length === 0` 분기). 컴포넌트를 고칠 필요 없이 빈 배열만 넘기면 된다.
- 표시되는 "지원한 판매자 0명"은 **사실이다.** 지원 테이블도 API도 없으므로 실제 지원 건수는 0이고, 목록 카드의 `applicantCount: 0`(4.2)과도 일치한다. 목업을 남기면 카드의 0과 상세의 목업 숫자가 어긋날 위험만 생긴다.
- 상세 하단의 "판매자 지원 기능은 4단계에서 열립니다." 문구와 비활성 "지원하기 · 준비 중" 버튼이 사용자에게 이 상태의 이유를 설명한다(5.5).

---

## 8. RED 테스트 매트릭스

TDD 기준이다. 아래 테스트는 **구현 전에 작성되어 실패(RED)해야 한다.** 각 항목은 위 계약의 어느 절을 검증하는지 명시한다.

### 8.1 백엔드 — `backend/tests/test_requests.py` (신규)

`tests/conftest.py`의 `client`/`post_headers` fixture와 `test_auth.py`의 `assert_error()` 스타일을 따른다. 실제 PostgreSQL에 대한 통합 테스트다. 선행 조건으로 `conftest.py`의 `clean_database`가 `app_private.purchase_requests`도 TRUNCATE하도록 확장한다.

| # | 테스트 | 기대 | 검증 절 |
| --- | --- | --- | --- |
| B1 | `test_create_request_persists_and_returns_detail` | 가입 후 POST 201, 응답 Detail 필드 일치, `status='open'`, `applicantCount=0`, `thumbnailUrl=null`, DB에 1행 | 4.1, 4.2 |
| B2 | `test_create_request_requires_authentication` | 쿠키 없이 POST → 401 `UNAUTHENTICATED` + DB 0행 | 4.4 |
| B3 | `test_create_request_rejects_missing_origin_header` | Origin 없음 → 403 `INVALID_ORIGIN`; `X-Requested-With` 없음 → 403 | 3.3 |
| B4 | `test_create_request_rejects_non_json_content_type` | `Content-Type: text/plain` → 415 | 3.3 |
| B5 | `test_create_request_validation_boundaries` | title 1자/61자, description 9자/1001자, region 51자, 잘못된 category/condition → 각각 422 `VALIDATION_ERROR` + 해당 `fields` 키 | 4.1, 4.5 |
| B6 | `test_create_request_rejects_price_range_inversion` | `priceMin > priceMax` → 422, `fields.priceMax` 존재 | 4.1 |
| B7 | `test_create_request_rejects_negative_and_oversized_price` | `priceMin=-1` → 422; `priceMax=1_000_000_001` → 422 | 4.1 |
| B8 | `test_create_request_rejects_server_controlled_fields` | 본문에 `status`/`buyerId`/`thumbnailUrl`/`applicantCount`/`id` 포함 → 각각 422 (extra forbid) | 4.1 |
| B9 | `test_create_request_trims_strings` | `"  아이패드  "` 입력 → 저장·응답 모두 trim된 값 | 4.1 |
| B10 | `test_list_requests_is_public_and_paginated` | 쿠키 없이 GET 200, `items`/`total`/`page`/`pageSize` 봉투, 15건 생성 시 기본 12건 + `total=15`, page 2에 3건 | 4.3 |
| B11 | `test_list_requests_filters_by_category_status_and_query` | `category=가전`, `status=open`, `q=아이패드`(대소문자 무시 부분일치) 각각 필터 적용, 조합도 동작 | 4.3 |
| B12 | `test_list_query_escapes_like_wildcards` | `q=%` 또는 `q=_`가 전체 매칭되지 않음 | 4.3 |
| B13 | `test_list_requests_sorting` | `sort=price` → `price_max` 내림차순; `sort=latest` → `created_at` 내림차순; `sort=applicants` → 오류 없이 200 | 4.3 |
| B14 | `test_list_requests_pagination_is_stable` | 동일 `created_at`을 가진 2건에서 page1+page2 합집합에 중복·누락 없음 (`id` tie-breaker) | 4.3 |
| B15 | `test_list_requests_rejects_invalid_pagination` | `page=0`, `pageSize=0`, `pageSize=51`, `page=abc` → 422 | 4.3 |
| B16 | `test_list_requests_falls_back_on_unknown_sort_and_status` | `sort=bogus` → `latest` 결과와 동일 200; `status=bogus` → 전체 반환 | 4.3 |
| B17 | `test_list_and_detail_expose_is_owner_by_session` | 소유자 쿠키로 GET → `isOwner=true`; 다른 회원/비로그인 → `false` | 4.2, 4.4 |
| B18 | `test_detail_returns_masked_buyer_email_only` | `buyer.maskedEmail == "bu***@example.com"`, 응답 전문에 원본 이메일 문자열 부재 | 3.2, 4.2 |
| B19 | `test_detail_returns_404_for_unknown_and_malformed_id` | 임의 UUID → 404 `NOT_FOUND`; `not-a-uuid` → 422 `VALIDATION_ERROR` | 4.4 |
| B20 | `test_detail_response_has_open_status_and_equal_timestamps` | `status='open'`, `updatedAt == createdAt`. 3단계에 변경 경로가 없음을 고정 | 3.1, 4.2 |
| B21 | `test_patch_and_delete_are_not_implemented` | `PATCH`/`DELETE /api/requests/{id}` → **405**. 수정·삭제가 이 단계에 없음을 계약으로 고정 | 4.3 |
| B22 | `test_request_endpoints_set_no_store` | 목록·상세·등록 응답 모두 `Cache-Control: no-store` | 3.3 |
| B23 | `test_deleting_user_cascades_requests` | `users` 행 삭제 시 해당 `purchase_requests` 행도 사라짐 (`ON DELETE CASCADE`) | 3.1 |
| B24 | `test_db_check_constraints_reject_invalid_rows` | 원시 SQL로 `price_max < price_min`, `status='bogus'`, `condition='bogus'` INSERT → `IntegrityError` | 3.1 |
| B25 | `test_database_failure_returns_503_without_leaking_credentials` | DB 세션이 `SQLAlchemyError`를 던지도록 하면 503 `SERVICE_UNAVAILABLE`, 응답·로그에 연결 문자열 부재 | 3.5 |
| B26 | `test_existing_auth_contract_is_unchanged` | 기존 `tests/test_auth.py` 전체가 그대로 통과 (회귀) | 1.2 |
| B27 | `test_migration_0002_upgrade_and_downgrade` | `alembic upgrade head` 후 테이블·인덱스·제약 존재; `downgrade`로 테이블만 사라지고 `users`/`auth_sessions`는 잔존 | 3.6 |

`FORBIDDEN`·`CONFLICT_STATE`를 검증하는 테스트는 없다. 3단계에 그 코드를 발생시키는 경로가 없기 때문이다(4.5).

### 8.2 프론트엔드 단위 — `frontend/tests/` (Vitest + RTL)

| # | 파일 | 테스트 | 기대 | 검증 절 |
| --- | --- | --- | --- | --- |
| F1 | `requestsApi.test.ts` (신규) | `listRequests`가 쿼리스트링을 계약대로 조립 | `q`/`category`/`status`/`sort`/`page`/`pageSize`가 URL에 반영, 빈 값은 생략 | 4.3 |
| F2 | `requestsApi.test.ts` | POST 요청 헤더 | `X-Requested-With: gamja-market`, `Content-Type: application/json`, `credentials:'same-origin'`, `cache:'no-store'` | 3.3 |
| F3 | `requestsApi.test.ts` | 404 응답 → `ApiError.code === 'NOT_FOUND'` | | 4.5 |
| F4 | `requestsApi.test.ts` | 422 → `VALIDATION_ERROR` + `fields` 파싱 | | 4.5 |
| F5 | `requestsApi.test.ts` | `fetch` reject → `NETWORK_ERROR`, status 0 | | 5.2 |
| F6 | `requestsApi.test.ts` | 필수 필드 누락/타입 불일치 응답 → `INTERNAL_ERROR`로 던짐, **목업을 반환하지 않음** | | 5.2, 6.3 |
| F7 | `requestsApi.test.ts` | 모듈이 `updateRequest`/`deleteRequest`를 **export하지 않음** | 수정·삭제 클라이언트 부재를 고정 | 5.2 |
| F8 | `authApi.test.ts` (기존) | 기존 인증 API 테스트 전부 통과 | 리팩터링 회귀 방지 | 5.2 |
| F9 | `RequestForm.test.tsx` (기존 수정) | 클라이언트 검증 3건(빈 폼 / 가격 역전 / 정상) | 기존 문구 유지. 단 정상 케이스는 `createRequest` 호출을 기대하고 "아직 저장 기능이 없습니다"를 **기대하지 않음** | 5.4 |
| F10 | `RequestForm.test.tsx` | 성공 시 `/requests/{id}`로 `router.push` | | 5.4 |
| F11 | `RequestForm.test.tsx` | 서버 422 `fields`가 해당 입력 아래 표시, 입력값 보존 | | 6.3 |
| F12 | `RequestForm.test.tsx` | 제출 중 버튼 `disabled` + 중복 클릭이 요청을 1회만 보냄 | | 5.4 |
| F13 | `RequestForm.test.tsx` | 401 → 재로그인 안내와 `/login?next=` 링크, 입력값 보존 | | 6.3 |
| F14 | `RequestForm.test.tsx` | 사진 업로드 버튼이 여전히 `disabled` | "사진 업로드 · 5단계에서 지원" 문구 유지 | 1.2 |
| F15 | `RequestBrowser.test.tsx` (신규) | 카테고리 칩 클릭 시 URL에 `category` 반영 + `page` 제거 | | 5.3 |
| F16 | `RequestBrowser.test.tsx` | 정렬 변경 시 `sort` 반영, `latest`는 파라미터 제거(기존 동작) | | 5.3 |
| F17 | `RequestBrowser.test.tsx` | 전달받은 `items`를 **재정렬·재필터하지 않고** 순서 그대로 렌더 | 클라이언트 필터 제거 검증 | 5.3 |
| F18 | `RequestBrowser.test.tsx` | `resultCount`에 서버 `total`이 표시됨(`items.length` 아님) | | 5.3 |
| F19 | `RequestBrowser.test.tsx` | `total <= pageSize`면 페이지네이션 미렌더, 초과 시 렌더 + 다음 페이지 URL | | 5.3 |
| F20 | `RequestList.test.tsx` (신규) | 필터 있음 + 0건 → "조건에 맞는" 문구; 필터 없음 + 0건 → "아직 등록된" 문구 + 등록 링크 | | 6.2 |
| F21 | `RequireAuth.test.tsx` (신규) | `loading` → 안내; `anonymous` → `/login?next=...`로 replace; `error` → 리다이렉트 없이 재시도 버튼; `authenticated` → children | | 5.4 |
| F22 | `RequireAuth.test.tsx` | `next`가 `//evil.com`, `https://evil.com`이면 로그인 후 `/`로 이동 (오픈 리다이렉트 차단) | | 5.4 |
| F23 | `RequestDetail.test.tsx` (신규) | 구매자 영역에 `maskedEmail` 표시, 원본 이메일 문자열 부재 | | 5.5 |
| F24 | `RequestDetail.test.tsx` | 소유자 액션 부재 | 소유자 세션이어도 "수정"·"삭제" 버튼이 **렌더되지 않음** | 5.5 |
| F25 | `RequestDetail.test.tsx` | 지원자 0건 정직 표시 | `applicants={[]}` → "지원한 판매자 0명" + "아직 지원한 판매자가 없어요" 렌더, 가짜 판매자 이름 부재 | 5.5, 6.2 |
| F26 | `noMockData.test.ts` (신규, `mockData.test.ts` 대체) | 목업 전면 제거의 기계적 보증 | `src/lib/mock/` 아래 `requests.ts`·`users.ts`·`applicants.ts`가 **모두 존재하지 않음**; `src/` 전체에서 `lib/mock` import가 **0건** | 7.1 |
| F27 | `categories.test.ts` (신규) | 카테고리 목록 일치 | 프론트 `requestCategories`가 백엔드 허용 목록(고정 배열로 복사)과 동일 | 4.1 |
| F28 | `format.test.ts` (기존) | 기존 포맷터 테스트 전부 통과 | 회귀 | 2.1 |

수정·삭제 UI 테스트(`updateRequest` 호출, 삭제 확인 다이얼로그, 소유자 버튼 노출)는 이 매트릭스에 없다. 해당 기능이 3단계 범위 밖이기 때문이다(1.2). F7과 F24는 그 부재를 **적극적으로 고정**해 범위가 조용히 넓어지는 것을 막는다.

### 8.3 통합·UI 시나리오

실제 FastAPI + PostgreSQL + Next.js를 기동한 상태(`scripts/start.sh`, `docs/specs/03-service-shell.md`)에서 수행한다.

| # | 시나리오 | 기대 |
| --- | --- | --- |
| I1 | `/api/requests`가 로컬에서 Next.js를 거쳐 FastAPI에 도달 | 200 JSON. rewrite가 `/api/auth`만이 아니라 `/api/:path*`를 덮는지 확인 (2.1의 `next.config.ts` 항목) |
| I2 | 비로그인으로 `/` 접속 | 200. 등록된 요청이 있으면 카드 표시, 없으면 "아직 등록된 구매요청이 없어요" |
| I3 | 비로그인으로 `/requests/new` 접속 | `/login?next=/requests/new`로 이동 |
| I4 | 로그인 → 등록 → 상세 이동 | 폼 제출 201, `/requests/{uuid}`로 이동, 입력한 제목·희망가·지역·스펙이 그대로 표시 |
| I5 | 등록 후 새로고침 및 로그아웃 상태에서 재조회 | 동일 요청이 목록·상세에 그대로 존재 (영속화 확인) |
| I6 | 다른 브라우저(다른 세션)에서 목록 조회 | 같은 요청이 보이고, 소유자든 아니든 **수정·삭제 버튼이 어디에도 없음** |
| I7 | 상세 화면의 판매자 지원 영역 | "지원한 판매자 0명" + "아직 지원한 판매자가 없어요". **가짜 판매자 이름·제시가가 보이지 않음** |
| I8 | 목록 카드의 지원자 수 | 모든 카드가 "지원 0명". 카드와 상세의 숫자가 일치 |
| I9 | 검색어 + 카테고리 + "구해요만 보기" + 정렬 조합 | URL 파라미터가 서버 쿼리로 전달되고 결과 개수가 `total`과 일치. 새로고침해도 동일 결과 (서버 필터링 확인) |
| I10 | 13건 이상 등록 후 페이지 이동 | 1페이지 12건 + 2페이지 나머지, 중복·누락 없음 |
| I11 | 백엔드 중지 상태에서 `/` 접속 | 오류 블록과 재시도 버튼. **목업 12건이 보이지 않음** |
| I12 | 세션 만료 후 폼 제출 | 401 안내, 입력값 보존, 재로그인 후 `next`로 복귀 |
| I13 | `curl -X PATCH` / `-X DELETE`로 상세 경로 호출 | 405. 수정·삭제 경로가 존재하지 않음을 확인 |
| I14 | 2단계 인증 회귀 | 가입 → 새로고침 → 로그아웃 → 재로그인이 `04-login-register-deployment-fix.md`의 검증 결과와 동일하게 동작 |
| I15 | 접근성 | 폼 오류가 `aria-invalid`/`aria-describedby`로 연결, 오류 요약이 `role="alert"`, 로딩이 `role="status"`, 페이지네이션 버튼에 접근 가능한 이름 |

---

## 9. 구현 순서 제안

1. `0002` 마이그레이션 + `PurchaseRequest` 모델 + `conftest.py`의 TRUNCATE 확장 → B23/B24/B27 RED
2. 백엔드 schema/repository/service/router(`GET` 2 + `POST` 1) + `get_optional_user` + `NOT_FOUND` 코드 → B1~B22, B25 RED
3. `next.config.ts` rewrite 확장 → I1
4. `types/api.ts`/`http.ts` 추출 + `lib/api/requests.ts`(함수 3개) → F1~F8 RED
5. 목록 페이지 전환 + `lib/mock/requests.ts`·`users.ts` 삭제 → F15~F20, F27 RED
6. 상세 페이지 전환 + `lib/mock/applicants.ts` 삭제 + 지원자 빈 배열 + 구매자 마스킹 표시 → F23~F25 RED
7. `mockData.test.ts` 삭제 + `noMockData.test.ts` 추가 → F26 RED (여기서 `lib/mock/` 디렉터리가 완전히 사라진다)
8. `RequireAuth` + 등록 폼 연동 → F9~F14, F21, F22 RED
9. 로딩·빈 상태·오류 컴포넌트 정리 → 6장, I11
10. 통합 시나리오 I2~I15 수행

각 단계는 테스트를 먼저 작성해 RED를 확인한 뒤 구현한다. 수정·삭제 관련 단계는 이 순서에 없다 — 이후 작업에서 별도로 설계·구현한다.

---

## 10. 열린 사항

구현 워커가 이 설계를 벗어나지 않고 처리할 수 있으나, 검토자가 다르게 결정할 수 있는 지점이다.

1. **`next.config.ts`의 rewrite 확장 범위** — `/api/:path*` 전체로 넓히면 이후 단계의 모든 API가 자동 프록시된다. 대신 `/api/requests/:path*`를 별도로 추가하는 보수적 선택도 가능하다. 본 설계는 `vercel.json`이 이미 `/api/:path*`를 쓰므로 **로컬과 운영의 동작을 일치시키는 쪽**을 택했다.
2. **camelCase JSON** — 2단계 auth는 snake_case(`password_confirmation`)다. 본 설계는 프론트 타입과의 마찰을 줄이기 위해 새 라우터만 camelCase로 간다. 전체 일관성을 우선한다면 snake_case로 통일하고 프론트에서 변환하는 대안이 있다.
3. **구매자 표시** — 이메일 마스킹 대신 "구매자" 같은 익명 라벨만 쓰는 선택지도 있다. 마스킹은 동일 구매자의 여러 요청을 식별할 수 있게 해준다.
4. **`isOwner`를 3단계에 넣을지** — 3단계에는 이 필드를 읽는 UI가 없다(3.4). 응답에서 빼고 수정·삭제 작업에서 추가하는 선택도 가능하다. 본 설계는 소유권 판정 로직을 서버 한 곳에 미리 고정해 두는 편이 이후 작업의 계약 변경을 줄인다고 보고 **남기는 쪽**을 택했다.

### 이후 작업으로 이월된 설계 결정

수정·삭제를 도입할 때 함께 정해야 하며, 이 문서는 **의도적으로 정하지 않았다.**

- 남의 요청에 대한 `PATCH`/`DELETE`를 404로 숨길지 403 `FORBIDDEN`으로 드러낼지
- `matched`/`closed` 상태에서의 변경 차단(`CONFLICT_STATE` 409)과 7단계 상태 전이의 관계
- `PATCH`를 부분 전달로 받을지 전체 교체(`PUT`)로 받을지
- 본문 없는 `DELETE`를 위한 Origin 검사 의존성 분리
- 수정 라우트(`/requests/[id]/edit`)와 삭제 확인 UX
