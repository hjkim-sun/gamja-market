# 02. 회원가입·로그인 — FastAPI와 이메일·비밀번호 인증

> 기준: `curriculum.md` 2단계 및 2026-09-10 코드 조사. 기존 설계서는 `01-project-foundation.md` 한 개이므로 다음 순번은 02다.
> 이 문서는 후속 구현 계약이다. 현재 구현 완료를 뜻하지 않으며, 이번 작업은 이 Markdown 한 개만 추가한다.

## 1. 목표와 범위

- 이메일·비밀번호·비밀번호 확인 세 필드로 가입한다. 두 비밀번호가 정확히 일치해야 하며 클라이언트 사전 검증과 서버 재검증을 모두 수행한다. 정규화 이메일이 중복되지 않고 입력이 유효하면 인증 메일이나 승인 대기 없이 회원 생성과 자동 로그인을 완료한다.
- FastAPI가 가입, 로그인, 현재 회원 조회, 로그아웃을 담당한다. 새로고침 후에도 유효한 세션으로 로그인 상태를 복원한다.
- Supabase는 운영 PostgreSQL 용도로만 사용한다. Supabase Auth, 이메일 인증, SMTP, OAuth, 소셜 로그인, 역할 선택, 프로필 입력은 도입하지 않는다.
- 비밀번호 재설정, 회원 탈퇴, 프로필 변경은 이번 단계에 추가하지 않는다.
- 기존 구매요청 목록·상세·등록 폼은 공개 목업 화면으로 유지한다. 구매요청 영속화·보호 라우트, 판매자 지원, 사진, 채팅, 매칭, 후기 등 3단계 이후 기능을 구현하지 않는다.

> 사람 검토 반영: 커리큘럼의 이메일·비밀번호 가입에 오입력 방지용 `password_confirmation`을 추가한다. 확인값은 새 회원 속성이 아니며 로그인은 이메일·비밀번호 두 필드만 유지한다.

## 2. 현재 코드 근거와 결정

| 조사한 진입점 | 현재 상태 | 이번 단계의 결정 |
| --- | --- | --- |
| `frontend/package.json` | Next.js 15.5.24, React 19.1.0, TypeScript, Tailwind, Vitest/RTL; 인증·API 클라이언트 라이브러리 없음 | 기존 의존성과 fetch/React Context로 구현 |
| `frontend/src/app/layout.tsx` | 서버 루트 레이아웃, Suspense 내부 Header, main/Footer | 클라이언트 AuthProvider로 Header와 main을 감싸고 레이아웃 자체는 서버 컴포넌트 유지 |
| `frontend/src/components/layout/Header.tsx` | 클라이언트 컴포넌트; 로그인 비활성·모바일 숨김; URL 검색과 등록 링크 동작 | 로그인/회원가입 또는 이메일/로그아웃 표시, 모바일에서도 접근 가능 |
| `frontend/src/app/page.tsx` | mockRequests로 목록 렌더링 | 목업과 공개 접근 유지 |
| `frontend/src/app/requests/[id]/page.tsx` | 정적 params, 목업 상세·지원자, notFound | 변경 없음 |
| `frontend/src/app/requests/new/page.tsx`, `features/requests/components/RequestForm.tsx` | 공개 등록 폼, 클라이언트 검증 후 저장 없음 안내 | 로그인 여부와 무관하게 동일 동작 유지 |
| `frontend/src/types/request.ts`, `lib/mock/users.ts` | UserSummary에 nickname/region 존재 | 실제 AuthUser는 별도 타입; 목업 회원을 DB로 이관하거나 가짜 프로필을 생성하지 않음 |
| `frontend/next.config.ts` | reactStrictMode만 설정 | `/api/auth/:path*`를 FastAPI로 전달하는 rewrite 추가 |
| `frontend/tests/`, `vitest.config.ts` | jsdom, RTL; 포맷·목업·등록 폼 테스트 | 같은 도구로 인증 UI/상태 테스트 추가 |
| `backend/` | 디렉토리 자체가 없음; 모델·라우터·DB 설정·마이그레이션·테스트 없음 | FastAPI/uv 기반 백엔드부터 생성 |
| 루트 `docker-compose.yml` | 미추적 사용자 파일; PostgreSQL 16, 서비스 postgres, DB gamja_market, 사용자 gamja, 포트 5432, 영속 볼륨·healthcheck | 기존 컨테이너를 사용하며 파일/볼륨/자격증명을 임의 변경하지 않음 |
| 루트 `.gitignore`, `.mcp.json` | 조사 시 미추적 사용자 파일 | 이번 문서 작업에서 변경하지 않음; 민감 설정 내용을 문서에 복사하지 않음 |

기존 01 설계서의 “UserSummary가 실제 회원 테이블과 매핑” 문구는 현재 커리큘럼의 이메일·비밀번호만 입력한다는 요구와 충돌할 수 있다. 이 단계에서는 `AuthUser { id, email }`만 도입하고 목업 `UserSummary`와 연결하지 않는 것으로 결정한다.

## 3. 통신과 책임 구조

```text
브라우저 → 동일 출처 /api/auth/* → Next.js rewrite → FastAPI /api/auth/* → PostgreSQL
               HttpOnly 세션 쿠키                   회원/세션 검증
```

- 로컬 브라우저 출처는 `http://localhost:3000`, FastAPI는 `http://127.0.0.1:8000`이다. 브라우저는 백엔드 주소를 직접 호출하지 않는다.
- 프론트는 상대 경로 fetch를 `credentials: 'same-origin'`, `cache: 'no-store'`로 호출한다. POST에는 `Content-Type: application/json`, `X-Requested-With: gamja-market`를 보낸다.
- Next.js는 전달만 담당한다. 회원 생성·해싱·세션 발급·폐기·인증 판단을 Route Handler나 Server Action으로 중복 구현하지 않는다.
- rewrite는 경로와 Cookie/Set-Cookie, Origin, 상태 코드, Cache-Control을 보존해야 한다. 백엔드 URL에 `/api/auth`를 이중으로 붙이지 않는다. 설정 예: source `/api/auth/:path*`, destination `${BACKEND_API_ORIGIN}/api/auth/:path*`.
- 모든 인증 응답(오류 포함)에 `Cache-Control: no-store`를 설정한다. CDN과 Next.js 캐시를 거치며 회원 정보나 Set-Cookie가 공유되지 않는지 통합 검증한다.
- 상태 변경 POST는 FastAPI 공통 의존성에서 Origin이 `AUTH_ALLOWED_ORIGINS`의 정확한 출처 중 하나인지, 위 사용자 정의 헤더가 일치하는지 검사한다. 누락·`null`·다른 출처는 403이다. 로그인 CSRF도 막기 위해 가입/로그인에도 적용한다.
- POST의 미지원 Content-Type은 415이다. Origin/헤더 검사를 먼저 수행한다. CLI/테스트도 명시적으로 허용 Origin과 헤더를 전달한다.
- CORS는 활성화하지 않는다. 브라우저 교차 출처 호출은 지원하지 않으며, `*` credential 허용을 추가하지 않는다. 프록시를 통과한 Host나 임의 X-Forwarded-Host를 Origin 허용 근거로 쓰지 않는다.
- 운영도 동일 출처 프록시 구조를 사용한다. 외부 백엔드의 쿠키 Domain을 설정하지 않아 브라우저가 프론트 출처의 쿠키로 저장하게 한다.

## 4. 입력 및 API 계약

### 4.1 입력 규칙

- 가입 JSON은 문자열 `email`, `password`, `password_confirmation`을 필수로 받는다. 로그인 JSON은 문자열 `email`, `password`만 받으며 확인값을 보내면 추가 필드 오류다. 누락·null·다른 타입·알 수 없는 필드는 422 `VALIDATION_ERROR`로 거절한다.
- 이메일: 먼저 양끝 공백 제거, ASCII 이메일만 허용하고 전체 소문자화, 최대 254자. 이메일 구문은 `email-validator`로 검사하되 `check_deliverability=False`로 DNS/메일함 존재 검사를 하지 않는다. 표시 이름·국제화 주소는 이번 단계에서 허용하지 않는다.
- 정규화 예: `  Buyer@Example.com  ` → `buyer@example.com`. Gmail 점 제거, `+tag` 삭제 같은 공급자별 변환은 하지 않는다. 내부 공백은 오류다.
- 서버가 정규화의 최종 권위다. 프론트는 공백/필수/기본 이메일 형태 검증으로 편의를 제공하고 서버의 422를 필드에 반영한다.
- 비밀번호: 가입/로그인 모두 Unicode 코드 포인트 기준 8~128자. 영문/숫자/특수문자 조합을 강제하지 않는다. trim, 소문자화, Unicode 정규화, 자동 잘라내기를 하지 않고 입력 그대로 해싱·검증한다. 프론트 길이는 `Array.from(value).length`로 센다.
- 가입의 `password_confirmation`에도 같은 8~128자 규칙을 적용한다. 각 필드의 타입·필수·길이 검증이 먼저이며 실패 시 422 `VALIDATION_ERROR`다. 필드 검증을 통과한 뒤 원문 `password === password_confirmation`을 비교한다. 공백·대소문자·Unicode 조합을 변환하지 않는다.
- 클라이언트는 제출 시 필드 검증과 일치 검증이 모두 통과한 경우에만 세 필드로 가입 API를 호출한다. FastAPI도 클라이언트를 신뢰하지 않고 동일 검증을 중복 이메일 조회·해싱·회원/세션 생성보다 먼저 강제한다. 불일치는 422 `PASSWORD_MISMATCH`이며 어떠한 회원/세션 생성이나 기존 세션 변경도 하지 않는다.
- 중복 이메일은 가입 요청에서 검사한다. 별도 중복 확인 API·버튼은 만들지 않는다. 기존 계정 여부가 중복 응답으로 드러나는 것은 이 커리큘럼의 명시적 요구에 따른 결정이다.

### 4.2 공통 응답

성공 회원 객체는 다음 형태로 고정하고 비밀번호 원문·확인값·비밀번호 해시·세션 토큰·내부 DB 정보를 포함하지 않는다. 확인값을 추가해도 가입 성공은 기존과 같은 201 및 회원 객체·세션 쿠키다.

```json
{"user":{"id":"e8cdebea-9b66-40fc-b230-bbe773df461d","email":"buyer@example.com"}}
```

오류는 FastAPI 기본 `detail` 배열 대신 다음 형태로 통일한다. 프론트는 message 문자열 비교가 아니라 code로 분기한다.

```json
{"error":{"code":"EMAIL_ALREADY_EXISTS","message":"이미 가입된 이메일입니다.","fields":{"email":"이미 가입된 이메일입니다."}}}
```

- `fields`는 항상 객체이며 필드 오류가 없으면 `{}`이다. 허용 키는 `email`, `password`, `password_confirmation`; JSON 구문 오류·추가 필드는 상단 오류로 표시한다.
- 422 핸들러는 입력값을 그대로 포함하는 Pydantic 오류를 직렬화하지 않는다. 특히 password 및 password_confirmation 입력·DB 예외 메시지는 응답과 로그에서 제외한다.

비밀번호 불일치의 HTTP 상태는 422이며 code와 message를 다음과 같이 고정한다. 클라이언트 사전 검증도 동일 메시지를 확인 필드 아래 표시한다.

```json
{"error":{"code":"PASSWORD_MISMATCH","message":"비밀번호가 일치하지 않습니다.","fields":{"password_confirmation":"비밀번호가 일치하지 않습니다."}}}
```

### 4.3 엔드포인트

| 메서드·경로 | 요청 | 성공 | 주요 오류 |
| --- | --- | --- | --- |
| `POST /api/auth/signup` | `{"email":"Buyer@Example.com","password":"potato-pass-123","password_confirmation":"potato-pass-123"}` | 201, 공통 회원 객체, 새 세션 Set-Cookie | 409 EMAIL_ALREADY_EXISTS; 422 VALIDATION_ERROR 또는 PASSWORD_MISMATCH |
| `POST /api/auth/login` | `{"email":"Buyer@Example.com","password":"potato-pass-123"}` | 200, 공통 회원 객체, 새 세션 Set-Cookie | 401 INVALID_CREDENTIALS; 422 VALIDATION_ERROR |
| `GET /api/auth/me` | 본문 없음, 쿠키로 인증 | 200, 공통 회원 객체 | 401 UNAUTHENTICATED |
| `POST /api/auth/logout` | `{}`, 현재 쿠키 | 204, 본문 없음, 쿠키 만료 | DB 폐기 실패 시 503; 세션 없음/만료/이미 폐기는 204 |

공통 오류: 403 `INVALID_ORIGIN`(Origin/사용자 정의 헤더 검증 실패), 415 `UNSUPPORTED_MEDIA_TYPE`, 503 `SERVICE_UNAVAILABLE`(DB 연결·일시적 장애), 500 `INTERNAL_ERROR`(예상하지 못한 서버 오류). 403/415는 POST에 적용한다. JSON 파싱 실패도 422 `VALIDATION_ERROR`로 통일한다.

- 로그인 시 없는 이메일과 비밀번호 불일치는 동일한 401 `INVALID_CREDENTIALS`, “이메일 또는 비밀번호를 확인해 주세요.”를 사용한다. 구문 오류는 422다.
- 로그인 실패나 가입 중복은 기존 유효 세션을 바꾸지 않는다.
- `/me`는 쿠키 없음·형식 오류·토큰 미발견·만료 모두 동일한 401과 쿠키 만료를 반환한다. DB 장애는 401로 숨기지 않는다.
- 로그아웃 성공은 DB에서 현재 세션을 폐기한 뒤에만 반환한다. DB 장애라면 성공으로 간주하거나 UI를 강제 비로그인 처리하지 않는다.
- 자동 재시도는 GET에만 고려하고 POST는 자동 재시도하지 않는다. 가입 응답 유실 후 재요청에서 409가 오면 로그인 링크로 복구할 수 있다.

## 5. 데이터 모델과 마이그레이션

### 5.1 스키마

애플리케이션 전용 PostgreSQL 스키마 `app_private`를 만들고 아래 두 테이블만 둔다. Supabase 공개 Data API에 이 스키마를 노출하지 않으며 anon/authenticated 역할에 접근 권한을 주지 않는다. FastAPI 전용 DB 연결로만 접근한다.

| 테이블 | 컬럼 | 제약/의미 |
| --- | --- | --- |
| `app_private.users` | `id UUID` | PK, Python uuid4 생성 |
| | `email VARCHAR(254)` | NOT NULL, 정규화 값만 저장, UNIQUE 이름 `uq_users_email` |
| | `password_hash TEXT` | NOT NULL, Argon2id 인코딩 해시 |
| | `created_at TIMESTAMPTZ` | NOT NULL, 서버/DB UTC 생성 시각 |
| `app_private.auth_sessions` | `token_hash CHAR(64)` | PK, 토큰 SHA-256 hex |
| | `user_id UUID` | NOT NULL, users.id FK, ON DELETE CASCADE, 조회 인덱스 |
| | `created_at TIMESTAMPTZ` | NOT NULL, UTC |
| | `expires_at TIMESTAMPTZ` | NOT NULL, UTC, 인덱스, created_at보다 큰 값 |

- users.email에 `email = lower(btrim(email))` CHECK를 추가한다. API 구문 검증과 DB UNIQUE가 함께 중복을 차단한다. 표시용 원본 이메일은 별도로 저장하지 않는다.
- `password_confirmation`은 요청 검증에만 사용하며 DB 컬럼·별도 해시를 만들지 않는다. 검증 후에는 password의 Argon2id 해시만 저장한다. 이번 확인 필드 추가로 모델·마이그레이션은 바뀌지 않는다.
- `nickname`, `region`, `role`, `email_verified`, OAuth 식별자, 구매요청 테이블은 만들지 않는다.
- 세션 폐기는 행 삭제로 구현한다. 만료 행은 조회 시 항상 거절하고 해당 행을 삭제할 수 있다. 만료 청소의 실행 여부가 인증 보안을 좌우하지 않으며 별도 스케줄러는 이번 단계에 필요 없다.

### 5.2 트랜잭션·경합

- 가입: 정규화/필드 검증 → 두 비밀번호 원문 일치 검증 → 중복 사전 조회 → 해싱 → 회원 INSERT와 세션 INSERT를 한 트랜잭션으로 commit → 쿠키 응답.
- 사전 조회만 믿지 않는다. 동시 가입에서 `uq_users_email` unique violation만 rollback 후 409로 변환한다. 다른 IntegrityError를 중복 오류로 위장하지 않는다.
- 세션 생성 실패 시 회원 생성도 rollback한다. commit 이전에 성공 응답이나 쿠키를 반환하지 않는다.
- 로그인: 회원 조회/해시 검증 → 새 세션 저장과 현재 요청이 가진 기존 세션 삭제를 한 트랜잭션으로 처리 → commit → 쿠키 교체. 다른 기기 세션은 유지한다.
- 가입 성공 시에도 기존 쿠키 세션이 있으면 같은 트랜잭션에서 폐기한다. 사용자 제공 토큰을 새 세션 식별자로 재사용하지 않는다.
- 로그아웃: 전달된 토큰 해시에 해당하는 행만 DELETE하고 commit한다. 재호출은 멱등적이다.

### 5.3 도구와 실행

- Python 3.12, uv; FastAPI, uvicorn, Pydantic Settings, SQLAlchemy 2.x, psycopg 3, Alembic, `pwdlib[argon2]`, email-validator를 사용한다. 테스트는 pytest/httpx. 후속 구현에서 호환 버전을 `pyproject.toml`과 `uv.lock`에 고정한다.
- 동기 SQLAlchemy Session을 요청별로 생성/종료하고 동기 라우트를 사용한다. 전역 Session 공유·메모리 세션 저장소·앱 시작 시 `create_all`을 사용하지 않는다.
- `backend/alembic.ini`, `backend/migrations/env.py`, `backend/migrations/versions/0001_create_auth_tables.py`를 생성한다. Alembic metadata에 스키마 모델을 등록하고 autogenerate 결과는 제약/인덱스까지 검토한다.
- upgrade는 전용 스키마→users→auth_sessions 순서, downgrade는 역순으로 이 revision 소유 테이블만 제거한다. 운영 downgrade는 회원 데이터를 삭제하므로 개발의 폐기 가능한 테스트 DB에서만 검증한다.
- 루트에서 `docker compose up -d postgres`; backend에서 `uv sync`, `uv run alembic upgrade head`, `uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`으로 시작한다. 현 docker-compose.yml의 연결 값은 로컬 환경 파일에 넣고 URL 비밀번호를 인코딩한다.
- 개발과 운영 모두 동일 Alembic revision을 적용한다. `MIGRATION_DATABASE_URL`은 운영 direct 또는 session 연결, 런타임 `DATABASE_URL`은 운영 연결 환경에 맞춰 사용한다. 초기는 psycopg session 연결과 SQLAlchemy NullPool로 단순화한다.
- 운영은 TLS(`sslmode=require`)와 별도 migration/runtime DB 권한을 사용한다. migration 계정이 DDL을 담당하고 runtime은 두 테이블의 SELECT/INSERT/DELETE 및 스키마 USAGE만 가진다. 배포 전 migration을 일회 실행하고 요청/프로세스 시작마다 실행하지 않는다.

## 6. 비밀번호와 세션

- `pwdlib`의 Argon2id 해싱을 사용한다. salt는 라이브러리에 맡기며 직접 암호화·평문 저장하지 않는다. 초기 비용은 memory 65536 KiB, time 3, parallelism 4로 명시하고 배포 환경에서 처리 시간을 확인한다.
- 존재하지 않는 이메일 로그인도 미리 생성한 같은 비용의 더미 해시를 검증하여 계정 존재에 따른 큰 시간 차이를 줄인다. password와 password_confirmation 원문, Cookie/Set-Cookie, 요청 본문은 로그·분석 이벤트·예외 추적에 남기지 않는다. 확인값은 요청 검증 이후 저장소나 사용자 객체에 전달하지 않는다.
- 세션 원문은 `secrets.token_urlsafe(32)`로 생성한다. 브라우저 쿠키에만 전달하고 DB에는 SHA-256 해시만 저장한다. 토큰은 고엔트로피이므로 비밀번호용 Argon2를 적용할 필요가 없다.
- 쿠키명 `gamja_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, Domain 생략. 운영 HTTPS는 `Secure=true`, 로컬 HTTP만 false. `Max-Age=604800`으로 7일 고정 만료를 사용한다.
- DB의 `expires_at`이 최종 권위다. UTC 현재 시각이 만료 시각 이상이면 즉시 401이다. 사용 중 만료 연장/refresh token/JWT는 도입하지 않는다.
- 삭제 쿠키는 같은 이름/Path/Domain 정책으로 `Max-Age=0` 및 과거 Expires를 지정하고 HttpOnly/SameSite/Secure 설정을 유지한다.
- 현재 회원 의존성은 쿠키 형식/길이 검사 → 해시 → 세션과 회원 조회 → 만료 검사 순서다. 로그아웃된 원문 토큰을 재사용해도 401이어야 한다.
- 세션은 DB에 있어 프로세스 재시작이나 복수 인스턴스에서도 유지된다. HTTPS, Origin 검사, 서버 측 폐기까지 이번 구현의 완료 조건에 포함한다.

## 7. 프론트 라우트·UI·상태

### 7.1 구성과 화면

| 파일 | 책임 |
| --- | --- |
| `src/types/auth.ts` | AuthUser, AuthResponse, SignupRequest(세 필드), LoginRequest(두 필드), ApiError 및 PASSWORD_MISMATCH 포함 오류 code 타입 |
| `src/lib/api/auth.ts` | signup/login/me/logout fetch와 응답 파싱; 204 본문을 JSON으로 읽지 않음 |
| `src/features/auth/AuthProvider.tsx` | Context, useAuth, 상태 복원과 변경 요청 동기화 |
| `src/features/auth/components/SignupForm.tsx` | 이메일·비밀번호·비밀번호 확인 가입 폼, 요청 전 일치 검증 |
| `src/features/auth/components/LoginForm.tsx` | 이메일·비밀번호 로그인 폼 |
| `src/app/signup/page.tsx`, `src/app/login/page.tsx` | 서버 페이지 셸, metadata, 클라이언트 폼 배치 |
| 기존 `src/app/layout.tsx`, `components/layout/Header.tsx` | Provider 연결, 인증 UI·로그아웃 연결 |
| 기존 `next.config.ts`, 새 `.env.example` | 백엔드 rewrite와 비공개 서버 환경 예시 |

- `/signup`: 이메일·비밀번호·비밀번호 확인, “회원가입” 제출 버튼, 로그인 링크. 성공하면 응답 user를 Context에 넣고 `router.replace('/')`한다. 별도 이메일 인증 화면이나 프로필 입력을 보여주지 않는다.
- `/login`: 이메일·비밀번호, “로그인” 버튼, 회원가입 링크. 성공 후 동일하게 `/`로 이동한다. 이번 단계는 redirect/next 쿼리 처리를 하지 않는다.
- 이미 인증된 상태에서 두 페이지에 접근하면 복원 완료 후 `/`로 이동한다. 복원 중에는 로그인 폼을 깜빡이며 노출하지 않는다.
- 이메일 input은 type=email, autoComplete=email; 가입의 password와 password_confirmation은 모두 type=password, autoComplete=new-password이며 각각 “비밀번호”, “비밀번호 확인” label과 고유 id/name을 가진다. 로그인 비밀번호는 type=password, autoComplete=current-password다. 붙여넣기·암호 관리자를 허용한다.
- 기존 Button, Tailwind 색상·카드 스타일을 재사용한다. label 연결, aria-invalid/aria-describedby, 오류 role=alert, 성공/로딩 role=status를 적용한다. 320px에서도 두 인증 경로와 로그아웃에 접근할 수 있게 한다.
- 가입 폼 제출 시 두 비밀번호가 다르면 요청을 보내지 않고 `password_confirmation` 아래 “비밀번호가 일치하지 않습니다.”를 role=alert로 표시한다. 확인 input의 aria-invalid와 aria-describedby를 오류 id에 연결하고 첫 오류 필드로 초점을 옮긴다. 기존 일치 오류가 표시된 뒤 어느 비밀번호든 수정하면 다시 비교해 일치할 때 오류를 해제하며, 최종 제출에서 항상 재검증한다. 로컬 오류에서는 수정할 수 있도록 폼의 일시적 입력값을 유지하고 인증/제출 중 상태로 전환하지 않는다.
- 제출 중 중복 클릭을 막고 버튼에 진행 상태를 표시한다. 409는 이메일 아래, 401은 폼 상단, 422는 fields와 상단, 네트워크/5xx는 재시도 안내로 표현한다. 서버 응답이나 네트워크 실패 후 이메일은 유지하고 비밀번호 입력값은 지운다(가입은 두 입력 모두, 로그인은 하나). 서버 `PASSWORD_MISMATCH`도 확인 필드에 같은 메시지와 접근성 속성으로 표시하며 수정 후 재제출할 수 있다. 성공·페이지 이탈 시에도 두 비밀번호 입력 상태를 폐기한다.
- Header는 비로그인 시 로그인/회원가입 링크, 인증 시 이메일(긴 값은 레이아웃 안에서 줄임)과 로그아웃 버튼을 표시한다. 검색 동작과 구매요청 등록 링크는 유지한다.

### 7.2 상태 전이

Context는 `status: 'loading' | 'authenticated' | 'anonymous' | 'error'`, `user: AuthUser | null`, `error`를 가진다. 초기 loading에서 `/me` 200은 authenticated, 401은 anonymous, 통신/5xx 실패는 error로 간다. error에서 “로그인 상태를 확인할 수 없습니다”와 재시도 동작을 제공한다.

- 회원 정보는 메모리에만 유지한다. 두 비밀번호 원문은 폼의 일시적 입력 상태와 요청에만 두며 AuthProvider나 사용자 객체에 저장하지 않는다. localStorage/sessionStorage에 인증 토큰·비밀번호·확인값을 저장하지 않으며 쿠키를 JavaScript로 읽지 않는다.
- 가입/로그인 성공 응답으로 즉시 상태를 갱신한다. 실패하면 기존 인증 상태를 덮어쓰지 않는다.
- 로그아웃은 성공 204 후 user를 지우고 anonymous로 바꾼다. 실패하면 사용자 상태를 유지하면서 재시도 안내를 보여준다.
- 초기 `/me`와 로그인/로그아웃의 응답 역전으로 상태가 되살아나지 않도록 요청 세대 번호 또는 AbortController로 오래된 복원 응답을 무시한다. React StrictMode의 effect 재실행도 정리한다.
- 탭 focus/visibility 복귀 시 `/me`를 재확인하여 다른 탭의 로그아웃과 만료를 반영한다. 고정 주기 폴링은 만들지 않는다. 서버의 인증 판단은 언제나 쿠키/DB에 근거한다.
- UI 인증 상태는 편의 표시다. 이번 단계에는 보호할 구매요청 API가 없으므로 인증 미들웨어로 공개 목업 경로를 막지 않는다.

## 8. 환경설정과 실행 경계

| 위치 | 변수 | 개발/운영 계약 |
| --- | --- | --- |
| frontend `.env.local` | `BACKEND_API_ORIGIN` | 개발 `http://127.0.0.1:8000`, 운영 실제 FastAPI HTTPS origin; trailing slash 없음, NEXT_PUBLIC 접두사 없음 |
| backend `.env` | `DATABASE_URL` | SQLAlchemy `postgresql+psycopg://...` 런타임 URL; 개발 기존 Docker 설정, 운영 Supabase PostgreSQL |
| backend `.env` | `MIGRATION_DATABASE_URL` | DDL 가능 direct/session URL; 개발 DATABASE_URL과 동일 가능 |
| backend `.env` | `AUTH_ALLOWED_ORIGINS` | JSON 배열; 개발 `["http://localhost:3000"]`, 운영 정확한 프론트 HTTPS 출처만 |
| backend `.env` | `SESSION_COOKIE_SECURE` | 개발 false, 운영 true |
| backend `.env` | `SESSION_TTL_SECONDS` | 기본 604800; 테스트만 짧게 조정 |

- backend Settings에서 필수값·양수 TTL·운영 Secure 설정을 검증한다. frontend는 backend origin 누락을 개발/빌드 시작 시 명확히 알린다.
- `.env.example`에는 플레이스홀더만 넣고 실제 `.env`, `.env.local`, `.venv`, 로그, 테스트 캐시가 추적되지 않도록 후속 구현 담당자가 현재 ignore 규칙을 점검한다. 루트 사용자 파일 편집은 조정자와 소유 경계를 정한 뒤 별도 수행한다.
- `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, SMTP, OAuth client secret, JWT secret은 필요하지 않다. DB 자격증명은 프론트로 보내지 않는다.
- 기존에 FastAPI 배포 설정이 없으므로 Vercel 배포가 이미 동작한다고 가정하지 않는다. 후속 백엔드는 배포 가능한 FastAPI 진입점과 실행 안내를 제공하고, 통합 담당자는 실제 배포 주소·DB 네트워크·프록시 쿠키 보존을 확인한다. 이번 문서 작업은 외부 배포를 실행하지 않는다.
- Vercel preview도 사용하는 경우 정확한 preview 출처를 해당 환경에 등록한다. 모든 vercel.app 출처를 일괄 허용하지 않는다. rewrite 환경 변경 시 재빌드/재배포가 필요하다.

## 9. 구현 소유 경계와 독립 실행 체크리스트

API 경로, JSON 이름, 오류 code, 쿠키명, 정규화·비밀번호 정책은 이 문서가 공통 계약이다. 변경이 필요하면 조정자가 문서를 먼저 갱신하여 양측이 서로 다른 계약을 구현하지 않게 한다.

### 백엔드 담당 — `backend/**`

- [ ] uv 프로젝트·의존성/lock·환경 예시·로컬 실행 README 생성.
- [ ] `app/main.py`: FastAPI 생성, 라우터 등록, 공통 오류/캐시 처리.
- [ ] `app/api/auth.py`, `app/api/deps.py`: 네 엔드포인트, Origin 검사, 현재 회원 의존성.
- [ ] `app/schemas/auth.py`: 가입 세 필드/로그인 두 필드 스키마 분리, 확인값 필수·길이·원문 일치 서버 검증, 422 PASSWORD_MISMATCH와 안전한 fields 매핑.
- [ ] 불일치 요청이 해싱·DB 조회/쓰기·세션 변경 전에 거절되고 두 비밀번호 원문이 저장/로그/응답에 남지 않는지 검증.
- [ ] `app/core/config.py`, `app/core/security.py`: Settings, Argon2id, 토큰/쿠키 정책.
- [ ] `app/db/session.py`, `app/db/models.py`: 요청별 Session, 두 모델/제약.
- [ ] `app/repositories/users.py`, `sessions.py`: DB 조회/쓰기; `app/services/auth.py`: 트랜잭션·가입·로그인·폐기 책임.
- [ ] Alembic 초기 revision 작성 및 빈 PostgreSQL DB에서 upgrade 검증.
- [ ] pytest에서 계약/경합/세션 폐기/보안 오류 검증. OpenAPI `/openapi.json`과 curl 예시 제공.
- [ ] 프론트 없이 8000 포트에 쿠키 jar와 Origin/사용자 정의 헤더를 붙인 curl로 가입→me→로그아웃→401 수행.

### 프론트 담당 — `frontend/**`

- [ ] 위 파일 표의 타입/API wrapper/Context/두 폼/두 페이지 작성. 가입 요청에는 password_confirmation을 포함하고 로그인에는 보내지 않음.
- [ ] 가입 두 비밀번호 입력과 접근성 연결, 제출 전 일치 검증, 불일치 시 fetch 미호출, 수정 후 오류 해제, 서버 PASSWORD_MISMATCH 표시/재시도 구현.
- [ ] Header와 layout 연결, 모바일 인증 버튼과 로딩/실패/재시도 상태 구현.
- [ ] `next.config.ts` rewrite와 `.env.example` 작성; `.env.local` 실제 값은 추적하지 않음.
- [ ] 독립 작업 시 fetch를 테스트에서 stub하여 계약의 201/200/204/401/409/422/5xx 구현; 앱 런타임 가짜 회원/세션은 만들지 않음.
- [ ] RTL 테스트, 기존 테스트, lint, build 수행. 구매요청 목업 동작 회귀 없음 확인.
- [ ] 백엔드 준비 후 상대 경로 요청이 실제 세션 쿠키를 주고받는지 통합 담당자와 확인.

### 통합 담당 — 공유 설정/실행 검증

- [ ] 기존 docker-compose.yml·ignore 등 사용자 변경을 보존하고 추가 변경의 소유자를 지정한다.
- [ ] 환경값 연결, migration 선행, 두 서버 실행, 브라우저에서 가입→새로고침→로그아웃→재로그인 확인.
- [ ] 실제 배포 환경에서는 HTTPS 쿠키, Origin, no-store와 프록시 전달을 확인한다.
- [ ] 프론트는 backend 파일을, 백엔드는 frontend 파일을 변경하지 않는다. 이 문서 작성자는 앱 구현 파일을 변경하지 않는다.

## 10. 테스트 계획과 완료 조건

| 계층 | 시나리오 | 기대 결과 |
| --- | --- | --- |
| 백엔드 입력 | 공백/대문자 이메일 가입 후 소문자 로그인 | 단일 정규화 이메일 저장, 로그인 성공 |
| 백엔드 입력 | 잘못된 이메일, 내부 공백, 254자 초과, 추가 필드, null, 잘못된 JSON | 422 공통 오류; password 원문 미노출 |
| 백엔드 입력 | password와 password_confirmation 각각 7/8/128/129자, 확인값 누락/null/숫자 | 필드 오류는 422 VALIDATION_ERROR 및 해당 fields 키; 가입 불가 |
| 백엔드 확인 | 유효한 길이의 두 값 불일치 API 직접 호출, 중복 이메일과 불일치 동시 발생 | 422 PASSWORD_MISMATCH 및 지정 message/fields; 중복 조회·해싱·DB 쓰기·쿠키 변경 없음 |
| 백엔드 확인 | 두 값의 대소문자·양끝 공백·Unicode 조합만 다름, 완전히 같은 Unicode 값 | 변환 없이 다르면 불일치; 유효하고 같으면 201 및 기존 성공 객체·세션 쿠키 |
| 백엔드 로그인 입력 | email/password만 전송, 확인값 추가 전송 | 정상 두 필드 로그인 허용; 확인값 추가는 422 VALIDATION_ERROR |
| 민감정보 | 정상/불일치/필드 오류 요청의 응답·로그·저장 모델 검사 | 두 비밀번호 원문·확인값 유출 없음; password_hash만 저장 |
| 백엔드 회원 | 동일 이메일 반복/대소문자 변경 가입 | 첫 요청 201, 이후 409, 행 하나 |
| 백엔드 경합 | 별도 DB 연결 두 개로 정규화 동일 이메일 동시 가입 | 정확히 하나 201, 하나 409; 500·고아 세션 없음 |
| 백엔드 원자성 | 가입 중 세션 INSERT 또는 commit 실패 주입 | 회원/세션 모두 rollback, 성공 쿠키 없음 |
| 백엔드 해싱 | 동일 비밀번호로 서로 다른 이메일 두 계정 생성 | 평문 미저장, salt로 다른 Argon2id 해시, 둘 다 검증 성공 |
| 백엔드 로그인 | 미가입 이메일/틀린 비밀번호 | 동일 401 code/message; 실패로 기존 세션 미변경 |
| 백엔드 세션 | 발급/재로그인/기존 쿠키 교체/여러 기기 | 토큰 회전, 현재 이전 토큰 무효, 다른 기기는 유효 |
| 백엔드 세션 | 쿠키 없음/변조/만료 경계/삭제된 회원 | me 401, 만료 쿠키; 인증 정보 누출 없음 |
| 백엔드 로그아웃 | 정상/반복/무쿠키 호출 및 원문 토큰 재사용 | 204·빈 본문·쿠키 만료; 재사용 me 401 |
| 백엔드 장애 | me DB 장애, logout 삭제/commit 장애 | 503, 무조건 비로그인 또는 성공으로 위장하지 않음 |
| 백엔드 출처 | 잘못된/누락/null Origin, 헤더 누락, 다른 Content-Type | 403 또는 허용 Origin/헤더 하에서 415 |
| DB | 새 DB upgrade head 2회; 폐기 DB downgrade/upgrade | 두 테이블·제약·인덱스 일치, 반복 upgrade 안전 |
| 프론트 | 가입 세 필드·로그인 두 필드 제출, 중복 클릭, 409/401/422/네트워크 실패 | 분리된 API 요청, 필드/상단 안내, 실패 후 가입 두 비밀번호 지움, 재시도 가능 |
| 프론트 확인 | 빈 확인값·불일치 후 제출, 어느 비밀번호든 수정 후 재제출 | fetch 호출 0회, 확인 오류/초점/ARIA 연결; 일치 후에만 세 필드 요청 1회 |
| 프론트 확인 | 서버 422 PASSWORD_MISMATCH 응답을 stub | 확인 필드 오류 표시, 인증 상태 유지, 재입력 후 재시도 |
| 프론트 상태 | me 지연 중 로그인/로그아웃, StrictMode 재마운트 | 오래된 응답으로 상태 역전 없음 |
| 프론트 상태 | me 401 대 503, logout 실패, 탭 복귀 | 비로그인과 확인 실패 구분, 실패 시 상태 보존, 재검증 |
| 프론트 회귀 | 기존 목록·검색·상세·404·등록 폼 | 공개 목업 유지, 등록은 여전히 저장 없음 |
| 브라우저 통합 | 가입 직후 홈, 새로고침, 로그아웃, 새로고침, 재로그인 | 즉시 가입/자동 로그인, 쿠키 복원, 서버 폐기 확인 |
| 브라우저 통합 | 320/768/1440px, 키보드 조작 | 인증 동작 접근 가능, 오류 연결, 가로 넘침 없음 |
| 운영 통합 | HTTPS 프록시 경유 로그인/me/logout | HttpOnly/Secure/SameSite/Path, Set-Cookie·no-store 보존 |

백엔드 테스트는 SQLite로 UNIQUE/경합을 대체하지 않고 PostgreSQL에서 실행한다. 시간 의존 테스트는 주입 가능한 UTC clock으로 만료 경계를 검증하고 실제 7일을 기다리지 않는다.

후속 검증 명령은 frontend에서 `npm run test`, `npm run lint`, `npm run build`, backend에서 `uv run pytest`, `uv run alembic upgrade head`다. 이 설계 문서만 작성한 현재 작업에서 앱 테스트나 migration이 통과했다고 주장하지 않는다.

## 11. 기술 참고와 문서 자체 점검

- [FastAPI 비밀번호 해싱 안내](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/): pwdlib/Argon2 사용 근거로만 참고한다. 해당 문서의 OAuth2/JWT 흐름은 채택하지 않는다.
- [Next.js external rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites): 외부 FastAPI에 동일 출처 경로를 전달하는 구조의 근거다. 설치된 Next.js 15.5.24에서 헤더/쿠키 보존은 통합 테스트로 확인한다.
- [Supabase PostgreSQL 연결 안내](https://supabase.com/docs/guides/database/connecting-to-postgres): 운영 DB direct/session 연결 및 마이그레이션 연결 선택의 근거다. 실제 배포 네트워크에 맞는 연결 문자열은 운영 설정 단계에서 지정한다.

자체 점검: 02 순번과 기존 경로를 확인했고, 현재 없는 backend 파일은 모두 신규 구현 대상으로 표시했다. 가입 입력 세 개와 로그인 입력 두 개, 클라이언트 요청 전 일치 검증·서버 재검증·422 PASSWORD_MISMATCH·확인값 비저장 및 관련 테스트, 이메일 정규화·동시 중복 방어, 즉시 가입과 자동 로그인, 서버 로그아웃·세션 만료, 요청/응답/오류, 모델/마이그레이션, 프론트 상태, 환경 및 담당별 독립 체크리스트를 포함했다. 3단계 이후의 실기능과 Supabase Auth/이메일 인증/OAuth는 포함하지 않았으며 기존 사용자 변경은 수정하지 않는다.
