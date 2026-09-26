# 07. 구매요청 사진 첨부 — Supabase Storage 연동

> 기준: `curriculum.md` **5단계**("Supabase Storage 연동, 구매요청에 사진 첨부")와 2026-09-26 코드 조사(`hjkim-sun/curriculum-05-request-photos` 워크트리, 기준 커밋 `bab6411`).
> 문서 번호 `06`은 동시에 진행 중인 4단계(판매자 지원) 설계가 사용한다. 본 문서는 `07`이며, 문서 번호는 커리큘럼 단계 번호와 별개다.
> 이 문서는 **후속 구현 계약**이다. 구현 완료를 뜻하지 않으며, 이번 설계 작업은 이 Markdown 한 개만 추가한다. 운영 코드·테스트·환경 파일은 수정하지 않았다.
> **사람 검토 승인**: 2026-09-26 사용자 “진행해” 승인. 이 설계를 기준으로 tester → backend/front → ui tester 순서로 구현·검증한다. 12장의 선택은 본 설계의 권장안을 따른다.
>
> **개정(2026-09-26, 코디네이터 검토 반영)**: (1) Vercel Functions 요청 본문 한도 4.5MB에 맞춰 장당 원본 한도를 **3MiB(3,145,728바이트)**로 낮춤 (2) **Pillow 디코딩 검증 + EXIF 방향 보정·메타데이터 제거 재인코딩**을 채택해 EXIF 결정 사항을 해소, 20MP·애니메이션 거부 (3) 사용자별 활성 업로드 한도를 **사용자 행 잠금** 트랜잭션으로 보장 (4) 확정 커밋 결과가 불확실할 때 **행을 새로 읽은 뒤에만** 보상 삭제, 타임아웃 뒤 늦은 쓰기를 대비한 유예 재삭제 (5) 행에 **저장소 백엔드 이름공간**(`storage_backend`, `storage_bucket`) 기록 (6) 다중 사진 잠금을 **`ORDER BY id`**로 고정. (7) alembic `version_num VARCHAR(32)`에 맞춰 revision ID를 **`0004_request_photos`**로 단축.

---

## 1. 목표와 범위

### 1.1 이 단계에서 하는 것

- 로그인한 구매자가 구매요청을 등록할 때 **사진을 0~5장** 첨부할 수 있다.
- 사진은 **Supabase Storage**(운영)에 저장된다. 브라우저는 Supabase에 직접 접근하지 않으며, 모든 업로드는 FastAPI를 거친다. Supabase 비밀 키는 **백엔드 서버에만** 존재한다.
- 목록 카드는 첫 번째 사진을 썸네일로, 상세 화면은 모든 사진을 갤러리로 보여준다.
- 사진이 없는 기존(레거시) 구매요청은 지금과 똑같이 카테고리 이모지 자리표시를 보여준다.
- 기존 JSON 등록 계약(`POST /api/requests`, `application/json`)을 **깨지 않고** 선택 필드 `photoIds`만 추가한다.
- 업로드 실패, 보상(compensation) 실패, 등록되지 않고 버려진 업로드를 DB 상태로 추적하고 정리할 수 있게 한다.
- 공유 로컬 DB에서 안전하게 검증할 수 있도록 **파괴적 테스트 fixture를 비파괴 방식으로 교체**한다(9장).

### 1.2 이 단계에서 하지 않는 것

| 항목 | 이유 / 도입 시점 |
| --- | --- |
| Supabase Auth, Supabase 클라이언트 SDK의 브라우저 사용 | 커리큘럼 원칙. 인증은 기존 FastAPI 세션 쿠키 |
| 브라우저 → Storage 직접 업로드(signed upload URL, TUS) | 업로드 전에 바이트를 검증할 수 없음(3.1) |
| 등록 후 사진 추가·교체·삭제·순서 변경 | 구매요청 수정 기능 자체가 없음(05 문서 1.2). 이후 작업 |
| 판매자 지원·채팅에 사진 첨부 | 4·6단계 범위. 본 단계는 구매요청 사진만 다룸 |
| 서버 측 리사이즈·썸네일 생성 | 원본 해상도를 유지한다(디코딩 검증과 메타데이터 제거를 위한 **같은 포맷 재인코딩**만 수행, 5.2) |
| Supabase Image Transformations | 유료 플랜 기능. 원본을 그대로 제공 |
| 정기 정리 작업 자동 실행(Vercel Cron 등) | 정리 명령만 제공하고 실행은 수동(6.4, 12장) |

---

## 2. 현재 코드 근거

| 위치 | 현재 상태 | 본 설계에 미치는 영향 |
| --- | --- | --- |
| `backend/app/db/models.py` `PurchaseRequest.thumbnail_url` | `Text NULL`, API가 한 번도 쓰지 않음(항상 `NULL`) | **컬럼을 건드리지 않는다.** 응답의 `thumbnailUrl`은 사진 테이블에서 계산한다(4.4) |
| `backend/app/api/deps.py` `require_auth_post_request` | Origin + `X-Requested-With: gamja-market` + `Content-Type: application/json` 강제 | 이름·동작을 그대로 두고, 이미지 업로드와 DELETE용 **새 의존성**을 추가한다(5.1) |
| `backend/app/schemas/requests.py` `PurchaseRequestCreate` | `extra="forbid"`, camelCase alias | `photo_ids`(alias `photoIds`) 선택 필드 추가. 누락 시 `[]` |
| `backend/app/main.py` `validation_error_handler` | 경로별 허용 필드 목록 + 고정 메시지 | `/api/requests` 허용 필드에 `photoIds` 추가 |
| `backend/app/main.py` `auth_no_store` | `/api/auth/`, `/api/requests` 접두사에 `no-store` | `/api/request-photos`는 이 접두사에 걸리지 않는다(`requests` ≠ `request-`). 라우터에서 명시한다 |
| `backend/app/api/errors.py` `ERROR_MESSAGES` | 코드 10개 | 4개 추가(5.5) |
| `backend/pyproject.toml` | `httpx`가 dev 의존성에만 있음 | Storage REST 호출용으로 **런타임 의존성에 `httpx` 추가**, 이미지 디코딩·재인코딩용으로 **런타임 의존성에 `Pillow` 추가**. `python-multipart`는 추가하지 않는다 |
| `backend/tests/conftest.py` | autouse `TRUNCATE ... CASCADE`, 세션 시작 시 `alembic upgrade head` | 공유 DB에서 **데이터 삭제**와 **알 수 없는 stage4 revision으로 인한 실패** 위험. 9장에서 교체 |
| `backend/tests/test_requests.py` | 빈 DB 가정 `total` 단언, `DELETE FROM users`, `0002` downgrade 테스트 | 9.3에서 비파괴 방식으로 변환 |
| `frontend/src/features/requests/components/RequestForm.tsx` | "사진 업로드 · 5단계에서 지원" 비활성 버튼 | `PhotoPicker`로 교체(7.2) |
| `frontend/src/features/requests/components/RequestCard.tsx` | `thumbnailUrl`이 있으면 `<img>` 렌더(이미 구현) | 그대로 활용, `loading="lazy"`만 추가 |
| `frontend/src/lib/api/requests.ts` `parseSummary` | `thumbnailUrl`을 임의 문자열로 허용 | URL 스킴 검증 추가(7.1) |
| `vercel.json` | `/api/:path*` → backend 서비스 | 변경 없음. 업로드도 같은 경로로 전달된다 |
| `frontend/next.config.ts` | 로컬 `/api/:path*` → `BACKEND_API_ORIGIN` rewrite | 변경 없음. raw body POST도 그대로 프록시된다 |

---

## 3. 핵심 결정

### 3.1 업로드 방식: FastAPI 경유 raw body 업로드 (채택)

| 선택지 | 판단 |
| --- | --- |
| **A. 브라우저 → FastAPI(raw bytes) → Supabase Storage** | **채택.** 저장 전에 크기·디코딩 가능 여부·개수·소유자를 서버가 모두 검증하고 메타데이터를 제거한다. 비밀 키가 서버 밖으로 나가지 않는다. Vercel Functions 공식 제한 문서(https://vercel.com/docs/functions/limitations)의 **요청 본문 4.5MB 한도**를 넘지 않도록 요청당 1장, 원본 **3MiB(3,145,728바이트)** 이하로 제한한다(Supabase 표준 업로드 권장 크기 6MB 이하도 만족) |
| B. 서버가 signed upload URL 발급 → 브라우저가 Storage에 직접 업로드 | 기각. 업로드된 바이트를 저장 **후에야** 검증할 수 있어 다운로드 재검증·삭제 경로가 추가된다. 브라우저가 스토리지 경로와 2시간짜리 업로드 토큰을 알게 된다 |
| C. `multipart/form-data`로 구매요청과 사진을 한 번에 등록 | 기각. 기존 JSON 등록 계약이 바뀌고, 등록 트랜잭션 안에서 외부 Storage 호출과 보상이 필요해진다 |

- 요청 본문은 **파일 바이트 그 자체**다(`Content-Type: image/jpeg|image/png|image/webp`). `multipart` 파서(`python-multipart`)를 도입하지 않고, 원본 파일명도 받지 않는다(경로 조작·개인정보 노출 여지 제거).
- 한 번의 요청에 **사진 1장**. 여러 장은 프런트가 순차 업로드한다.

### 3.2 2단계 흐름: 선 업로드 → 등록 시 연결

```
[브라우저]                         [FastAPI]                          [Supabase Storage]
 파일 선택 ─ POST /api/request-photos (raw bytes) ─▶ 검증 → DB 행(uploading) 커밋
                                                   └─ PUT 객체 ───────────────▶ 저장
                                                   ◀─ 성공 ───────────────────
                                                   DB 행 pending 커밋
 ◀──────────── 201 { id, ... } ───────────────────
 등록 제출 ─ POST /api/requests (JSON + photoIds) ─▶ 한 DB 트랜잭션:
                                                     구매요청 INSERT
                                                     사진 행 잠금·소유/상태 확인
                                                     attached로 UPDATE
 ◀──────────── 201 상세 ──────────────────────────  (Storage 호출 없음)
```

- **등록(create)은 순수 DB 트랜잭션**이다. Storage를 호출하지 않으므로 등록 단계에는 DB/Storage 불일치와 보상 로직이 없다. 불일치 가능성은 업로드 단계와 폐기 단계로 한정되고, 두 단계 모두 "DB 행을 먼저 기록 → Storage 작업 → DB 확정" 순서로 추적 가능하게 만든다(6장).
- `photoId`는 서버가 생성한 UUIDv4다. **ID를 안다고 권한이 생기지 않는다.** 등록·삭제 때마다 `uploader_id = 세션 사용자`를 DB에서 확인한다. 브라우저에 Storage 토큰이나 경로를 주지 않는다. 이것이 과제의 "소유자 범위 업로드 토큰/ID"에 대한 답이다.

### 3.3 버킷 공개 여부: 공개 버킷 + 추측 불가 경로 (채택)

- 구매요청 목록·상세는 **비로그인 공개**이므로 첨부 사진에도 사용자별 접근 제한이 없다. Supabase 공식 문서(Smart CDN, "Signed URLs and CDN caching")는 사용자별 제한이 없는 자산에 **공개 버킷을 권장**한다. 서명 URL은 요청마다 토큰이 달라 CDN·브라우저 캐시가 적중하지 않는다.
- 공개 URL은 `{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}` 형식이며 **서버가 문자열로 조립**한다. 목록·상세 조회 경로에서 Storage API를 호출하지 않으므로 **Storage 장애가 조회 API를 503으로 만들지 않는다.**
- 공개 버킷의 위험과 완화:
  - 등록 전 `pending` 사진도 URL을 알면 열람 가능하다 → 경로는 `photos/{uuid4}.{ext}`로 추측 불가(122비트)하고, 업로드 응답에 URL을 **돌려주지 않는다**(미리보기는 브라우저 `URL.createObjectURL`). 목록 API(`storage.objects` 조회)는 RLS 정책이 없으므로 익명에게 열리지 않는다(버킷 정책을 추가하지 않는다).
  - 버려진 업로드 → 정리 명령이 객체를 삭제한다(6.4).
- 대안(비공개 버킷 + 서명 URL)은 12장에 기록한다.

### 3.4 저장소 드라이버 3종

| 드라이버 | 용도 | 비고 |
| --- | --- | --- |
| `disabled` (기본값) | 설정이 없을 때 | 업로드 `503 PHOTO_STORAGE_UNAVAILABLE`. 사진 없는 등록·조회는 정상 동작. 조회 응답은 `photos: []`, `thumbnailUrl: null` |
| `local` | 로컬 개발·UI 검증(**모의 검증**) | 파일시스템 저장 + 개발 전용 파일 제공 엔드포인트(5.4). HTTPS origin 설정과 함께 쓰면 설정 검증 실패(운영 차단) |
| `supabase` | 운영·실제 연동 검증 | `httpx`로 Storage REST 호출 |

테스트는 드라이버 인터페이스를 구현한 **in-memory fake**(실패 주입 가능)를 FastAPI dependency override로 주입한다. `supabase` 드라이버 자체는 `httpx.MockTransport`로 요청 형태만 검증한다. **실제 Supabase 호출은 자동 테스트에서 하지 않는다**(10장).

---

## 4. 데이터 모델

### 4.1 새 테이블 `app_private.purchase_request_photos`

기존 테이블은 **ALTER하지 않는다.** 새 테이블 하나만 추가한다(추가형 호환 마이그레이션).

| 컬럼 | 타입 | 제약 | 설명 |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | 서버 생성 UUIDv4. 응답의 `photoId` |
| `uploader_id` | `uuid` | NOT NULL, FK `app_private.users(id)` ON DELETE CASCADE | 업로드한 회원 |
| `request_id` | `uuid` | NULL, FK `app_private.purchase_requests(id)` ON DELETE CASCADE | 연결된 구매요청. 연결 전 `NULL` |
| `status` | `varchar(10)` | NOT NULL, CHECK IN (`uploading`,`pending`,`attached`,`discarded`) | 6.1 상태 머신 |
| `storage_backend` | `varchar(10)` | NOT NULL, CHECK IN (`memory`,`local`,`supabase`) | 객체가 저장된 **백엔드 이름공간**. `memory`는 자동 테스트 fake 전용(운영 설정으로는 선택 불가) |
| `storage_bucket` | `varchar(63)` | NULL | `supabase`일 때 버킷 이름(필수), 그 외 `NULL` |
| `storage_path` | `text` | NOT NULL, UNIQUE | `photos/{id}.{ext}`. 버킷 이름은 포함하지 않음 |
| `content_type` | `varchar(20)` | NOT NULL, CHECK IN (`image/jpeg`,`image/png`,`image/webp`) | **Pillow로 디코딩해 판정한 포맷**(= 재인코딩 결과 포맷) |
| `byte_size` | `integer` | NOT NULL, CHECK `BETWEEN 1 AND 3145728` | **정규화(재인코딩) 결과** 바이트 수 |
| `width` | `integer` | NOT NULL, CHECK `> 0` | EXIF 방향 보정 후 너비 |
| `height` | `integer` | NOT NULL, CHECK `> 0` | EXIF 방향 보정 후 높이 |
| `sort_order` | `smallint` | NULL, CHECK `BETWEEN 0 AND 4` | 연결 시 `photoIds` 배열 순서. 0이 대표(썸네일) |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | 만료 판단 기준 |
| `updated_at` | `timestamptz` | NOT NULL, default `now()` | |
| `discarded_at` | `timestamptz` | NULL | `discarded`로 전환된 시각. 늦은 쓰기 대비 유예 판단 기준(6.4) |
| `object_deleted_at` | `timestamptz` | NULL | Storage 객체 삭제가 **확인된** 시각. `NULL`이면 객체가 남아 있을 수 있음 |

CHECK 제약(이름 고정 — 테스트가 이름으로 검사한다):

- `ck_request_photos_status`: status 열거
- `ck_request_photos_backend`: storage_backend 열거
- `ck_request_photos_bucket`: `(storage_backend = 'supabase') = (storage_bucket IS NOT NULL)`
- `ck_request_photos_content_type`: content_type 열거
- `ck_request_photos_byte_size`: 1 ~ 3,145,728
- `ck_request_photos_pixels`: `width > 0 AND height > 0 AND width::bigint * height <= 20000000`
- `ck_request_photos_sort_order`: `sort_order IS NULL OR sort_order BETWEEN 0 AND 4`
- `ck_request_photos_attached_link`: `(status = 'attached') = (request_id IS NOT NULL AND sort_order IS NOT NULL)`
- `ck_request_photos_discarded_at`: `(status = 'discarded') = (discarded_at IS NOT NULL)`
- `ck_request_photos_deleted_only_discarded`: `object_deleted_at IS NULL OR status = 'discarded'`

인덱스:

- `uq_request_photos_storage_path` (UNIQUE `storage_path`)
- `uq_request_photos_request_sort` UNIQUE (`request_id`, `sort_order`) `WHERE status = 'attached'` — 한 요청 안 순서 중복 방지
- `ix_request_photos_request_id` (`request_id`) `WHERE status = 'attached'` — 목록·상세 조회
- `ix_request_photos_uploader_status` (`uploader_id`, `status`, `created_at`) — 업로드 한도 계산
- `ix_request_photos_cleanup` (`storage_backend`, `storage_bucket`, `status`, `created_at`) `WHERE object_deleted_at IS NULL` — 정리 명령

**백엔드 이름공간 규칙**: 서버는 설정된 드라이버에서 "현재 이름공간" `(storage_backend, storage_bucket)`을 정한다(`local` → `('local', NULL)`, `supabase` → `('supabase', SUPABASE_STORAGE_BUCKET)`, 테스트 fake → `('memory', NULL)`). 업로드는 현재 이름공간으로 행을 기록하고, 등록 연결·조회 URL 생성·삭제·정리는 **현재 이름공간과 일치하는 행만** 다룬다. 공유 로컬 DB의 `local`·`memory` 행은 `supabase` 드라이버에서 실제 Supabase 자산으로 취급되지 않으며(조회 시 숨김, 연결 시 422, 정리 대상 제외), 반대도 같다. 사용자 활성 업로드 한도는 이름공간과 무관하게 센다(단순·보수적).

요청당 최대 5장은 DB가 아니라 서비스 계층(스키마 `max_length=5` + 순서 CHECK 0~4 + 부분 UNIQUE)이 보장한다. 순서 CHECK와 UNIQUE 조합만으로도 attached 6장은 DB에서 불가능하다.

`purchase_requests.thumbnail_url`: **읽지도 쓰지도 않는다.** 삭제·변경하지 않으며 모든 행이 `NULL`로 남는다. 제거는 이후 별도 마이그레이션에서 결정한다(12장).

ON DELETE CASCADE로 회원·요청 행이 삭제되면 사진 행도 사라져 Storage 객체가 추적 불가능해질 수 있다. 현재 회원·요청 삭제 기능이 없으므로 이 단계에서는 허용하고, 삭제 기능 도입 시 "먼저 `discarded` 전환 후 삭제"를 설계하도록 12장에 이월한다.

### 4.2 마이그레이션 — 공유 DB와 동시 진행 stage4를 위한 호환 방식

**문제**: 로컬 PostgreSQL은 4단계 워크트리와 공유된다. 4단계가 자신의 revision(이 체크아웃은 모르는 ID)을 공유 DB에 적용하면, 이 체크아웃에서 `alembic upgrade head`는 `Can't locate revision` 오류로 실패한다. 반대로 이 체크아웃이 `alembic_version`에 자기 revision을 기록(stamp)하면 4단계 체크아웃이 같은 오류를 겪는다.

**결정**:

1. 새 revision 파일: `backend/migrations/versions/0004_create_purchase_request_photos.py`
   - `revision = "0004_request_photos"` (19자). alembic 기본 `alembic_version.version_num`은 `VARCHAR(32)`이므로 revision 문자열을 32자 이하로 유지한다. 파일명은 설명적인 이름을 유지하고, 공유 DB의 버전 컬럼은 변경하지 않는다. 문서·테스트·후속 `down_revision`은 모두 이 짧은 ID를 참조한다.
   - 개발 중 `down_revision = "0002_create_purchase_requests"` (4단계가 `0003_*`을 쓴다고 가정해 번호 `0003`을 비워 둔다).
   - **통합 규칙**: develop에 나중에 병합되는 쪽이 병합 직전 자기 `down_revision`을 develop의 현재 head로 바꿔 **단일 head**를 유지한다. 이 판단은 PR 병합 시점(`pr-merge` 스킬)에서 한다. 테스트 M4가 `alembic heads` 개수 1을 확인한다.
2. `upgrade()`는 **멱등 DDL**만 사용한다: `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS` (`op.execute`로 SQL 작성). 기존 테이블 ALTER·DROP·데이터 변경이 없다.
3. `downgrade()`는 새 인덱스·새 테이블만 `DROP ... IF EXISTS`한다. `purchase_requests`, `users`, `auth_sessions`, 스키마는 건드리지 않는다. **공유 DB에서 downgrade를 실행하지 않는다**(테스트는 offline SQL 렌더링으로만 검증, M2).
4. **공유 DB 적용은 alembic 버전 테이블을 건드리지 않는 방식으로 한다.** 테스트 지원 모듈 `backend/tests/support/schema.py`의 `ensure_additive_schema(engine)`가:
   - `0001`/`0002` 테이블(`users`, `auth_sessions`, `purchase_requests`)이 **이미 존재하는지만 확인**한다. 없으면 만들지 않고 "먼저 운영 절차로 마이그레이션하라"는 메시지로 실패한다.
   - `0004` 모듈을 import해 `alembic.operations.Operations.context(MigrationContext.configure(connection))` 안에서 `upgrade()`를 호출한다. `alembic_version`을 읽지도 쓰지도 않는다.
   - 적용 후 테이블 컬럼·제약·인덱스 이름을 inspector로 검증하고, 다르면(이미 다른 모양의 테이블이 있으면) 명확히 실패한다.
   - `python -m tests.support.schema`로도 실행 가능하게 해, UI 검증용 8105 백엔드를 띄우기 전에 한 번 수행한다.
5. 병합 후 운영(Supabase PostgreSQL) 배포 절차는 기존과 같다: 서비스 시작과 분리해 `uv run alembic upgrade head`. 공유 개발 DB에도 병합 후 같은 명령을 쓰면 이미 존재하는 객체는 `IF NOT EXISTS`로 건너뛰고 버전만 기록된다.
6. 시드 데이터 없음. 기존 행 수정 없음(backfill 없음 — 레거시 요청은 사진 0장).

---

## 5. API 계약

모든 오류 응답은 기존 형식 `{"error": {"code", "message", "fields"}}`를 쓴다. 모든 JSON 응답과 오류 응답에 `Cache-Control: no-store`를 둔다.

### 5.1 새 요청 검증 의존성 (`app/api/deps.py`)

기존 `require_auth_post_request`는 **이름·동작을 바꾸지 않는다.** 추가:

- `require_same_origin_mutation`: Origin이 `AUTH_ALLOWED_ORIGINS`에 있고 `X-Requested-With: gamja-market`인지 확인. 위반 시 `403 INVALID_ORIGIN`. Content-Type은 보지 않는다(DELETE용).
- `require_image_upload_request`: `require_same_origin_mutation` + Content-Type 매개변수 제거·소문자화 후 `image/jpeg|image/png|image/webp` 중 하나인지 확인. 아니면 `415 UNSUPPORTED_MEDIA_TYPE`.

### 5.2 `POST /api/request-photos` — 사진 1장 업로드

- 인증 필수. 요청 본문 = 이미지 바이트. 헤더: `Origin`, `X-Requested-With: gamja-market`, `Content-Type: image/*`(허용 3종), `Content-Length` 권장.
- **검사 순서** (앞 단계에서 실패하면 뒤를 수행하지 않는다):

| 순서 | 검사 | 실패 응답 |
| --- | --- | --- |
| 1 | Origin / `X-Requested-With` | 403 `INVALID_ORIGIN` |
| 2 | 세션(`get_current_user`) | 401 `UNAUTHENTICATED` |
| 3 | 드라이버 활성 여부 | 503 `PHOTO_STORAGE_UNAVAILABLE` |
| 4 | Content-Type 허용 3종 | 415 `UNSUPPORTED_MEDIA_TYPE` |
| 5 | `Content-Length`가 있으면 3,145,728 초과 여부 | 413 `PAYLOAD_TOO_LARGE` |
| 6 | **사전(비잠금) 한도 확인**: 본인 활성 업로드가 이미 10개 이상이면 본문을 읽기 전에 거절(대역폭 절약용. 최종 판정은 9단계) | 409 `PHOTO_LIMIT_EXCEEDED` |
| 7 | 본문 스트리밍 읽기, 누적 3,145,729바이트에 도달하면 즉시 중단 | 413 `PAYLOAD_TOO_LARGE` |
| 8 | 이미지 검증·정규화(아래). 빈 본문, 시그니처 불일치, 디코딩 실패·잘림, 선언 타입 ≠ 디코딩 포맷, 20MP 초과, 애니메이션 | 422 `INVALID_IMAGE` |
| 8′ | 정규화 결과가 품질을 낮춰도 3,145,728 초과 | 413 `PAYLOAD_TOO_LARGE` |
| 9 | **한 트랜잭션**: 사용자 행 잠금 → 활성 업로드 개수 재확인 → 의도 행 INSERT(`uploading`, 현재 이름공간) → 커밋 | 409 `PHOTO_LIMIT_EXCEEDED` / 503 `SERVICE_UNAVAILABLE` |
| 10 | Storage 저장(정규화된 바이트) | 503 `PHOTO_STORAGE_UNAVAILABLE` (6.2) |
| 11 | DB `pending` 확정 커밋 | 6.2의 확정 커밋 규칙 |

- 활성 업로드 = 본인 행 중 `status IN ('uploading','pending')`이고 `created_at > now() - 24h`인 행.
- **9단계 한도 보장(동시성)**: 같은 트랜잭션에서
  1. `SELECT id FROM app_private.users WHERE id = :uid FOR NO KEY UPDATE` — 같은 사용자의 업로드끼리만 직렬화한다. `FOR NO KEY UPDATE`는 외래키 검사가 잡는 `FOR KEY SHARE`와 충돌하지 않으므로 같은 사용자의 구매요청 등록·세션 생성을 막지 않는다.
  2. 활성 업로드 개수 `SELECT count(*)` → 10 이상이면 롤백 후 409.
  3. 의도 행 INSERT → 커밋(잠금 해제).
  동시에 여러 장을 올려도 활성 업로드가 10개를 넘을 수 없다. 이 트랜잭션은 Storage 호출이나 이미지 처리를 포함하지 않아 잠금 보유 시간이 짧다.
- **전역 잠금 순서**: 사용자 행 → 사진 행(`id` 오름차순). 모든 경로가 이 순서를 따르므로 교착이 생기지 않는다(5.5, 6.4).

#### 이미지 검증·정규화 (`app/services/photo_validation.py`, Pillow)

입력 bytes와 선언 Content-Type을 받아 `NormalizedImage(data, content_type, ext, width, height)`를 돌려주거나 `InvalidImage`/`ImageTooLarge`를 던지는 순수 함수다. CPU 작업이므로 라우트에서 `run_in_threadpool`로 호출한다.

1. **시그니처 사전 판정**(빠른 거절용, 통과해도 신뢰하지 않음): JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF….WEBP`. 판정 타입 ≠ 선언 타입이면 거절.
2. `Image.open(BytesIO(data))`로 헤더만 읽고 `img.format`이 `JPEG|PNG|WEBP`이며 선언 타입과 일치하는지 확인.
3. **픽셀 한도**: 디코딩 전에 `width * height > 20,000,000`이면 거절(디컴프레션 폭탄 방지. 전역 `Image.MAX_IMAGE_PIXELS`에 의존하지 않고 명시적으로 검사).
4. **애니메이션 거부**: `getattr(img, "is_animated", False)` 또는 `getattr(img, "n_frames", 1) > 1`이면 거절(애니메이션 WebP, APNG).
5. **완전 디코딩**: `img.load()`. `ImageFile.LOAD_TRUNCATED_IMAGES`는 기본값(`False`)을 유지해 잘린 파일은 예외 → 거절. `Image.DecompressionBombError`, `OSError`, `SyntaxError`, `ValueError` 등 Pillow 예외는 모두 `InvalidImage`로 변환(원인 문자열을 응답에 싣지 않음).
6. **방향 보정**: `ImageOps.exif_transpose(img)`로 EXIF Orientation을 픽셀에 반영.
7. **같은 포맷으로 재인코딩, 메타데이터 제거**: `exif`, `icc_profile`, XMP, PNG 텍스트 청크, JPEG 주석을 **전달하지 않는다**(ICC 미보존으로 인한 약간의 색 차이는 허용).
   - JPEG: 모드가 `RGB`/`L`이 아니면 `RGB`로 변환(CMYK 등). `quality=85, optimize=True, progressive=True`.
   - PNG: 모드 유지(`P`/`RGBA`/`LA` 투명도 보존), `optimize=True`.
   - WebP: 모드 `RGB`/`RGBA`로 정규화, `quality=85, method=4`(투명도 보존).
8. **출력 크기 상한 3,145,728바이트**: 초과 시 JPEG/WebP는 품질 75 → 65로 재시도, 그래도 초과하거나 PNG가 초과하면 `ImageTooLarge`(413).
9. 결과의 `content_type`·확장자는 원본 포맷과 같다(포맷 보존). Storage와 DB에는 **정규화된 바이트와 그 크기·보정 후 너비/높이**를 기록한다.

- SVG·GIF·HEIC·HTML 등은 4단계(415) 또는 8단계(422)에서 걸린다. 원본 바이트는 어디에도 저장하지 않는다.
- 크기는 **바이트 수**로 판정한다(3 MiB = 3,145,728). 원본 상한은 Vercel Functions 요청 본문 4.5MB 한도보다 충분히 작다.
- 메모리: 20MP RGBA 디코딩은 약 80MB. 요청당 1장이므로 함수 메모리 한도 안에 든다.

- 성공 `201`:

```json
{
  "id": "5b8c…-uuid",
  "contentType": "image/jpeg",
  "byteSize": 482113,
  "width": 1200,
  "height": 1600,
  "expiresAt": "2026-09-27T03:10:00+00:00"
}
```

  - `byteSize`·`width`·`height`는 정규화 결과 기준이다. `expiresAt` = `created_at + 24h`. 이 시각 이후에는 등록에 사용할 수 없다.
  - **URL을 반환하지 않는다.** 스토리지 경로도 반환하지 않는다.

### 5.3 `DELETE /api/request-photos/{photoId}` — 등록 전 사진 폐기

- 인증 필수, `require_same_origin_mutation`. 본문 없음.
- 대상: 본인 소유이고 `status = 'pending'`이며 **현재 이름공간**의 행만. 그 외(타인 소유, 없음, 다른 이름공간, `attached`, `uploading`, `discarded`)는 **모두 `404 NOT_FOUND`**(존재 여부 비노출). 잘못된 UUID 형식은 `422 VALIDATION_ERROR`.
- 처리: 행 `FOR UPDATE` 잠금 → `discarded`(+`discarded_at`) 커밋 → **커밋 확인 후에만** Storage 삭제 시도 → 삭제 확인 시 `object_deleted_at = now()` 커밋. `pending` 객체는 업로드가 이미 끝난 상태라 늦은 쓰기가 없으므로 즉시 삭제 확인을 기록해도 된다.
- Storage 삭제가 실패해도 **`204`**를 반환한다(행은 이미 `discarded`, 정리 명령이 재시도). 사용자 관점에서 사진은 이미 제거됐다.

### 5.4 `GET /api/request-photos/files/{photoId}.{ext}` — `local` 드라이버 전용

- 드라이버가 `local`일 때만 라우터에 **등록**한다. 그 외 드라이버에서는 라우트 자체가 없어 404다.
- `{photoId}`는 UUID, `{ext}`는 `jpg|png|webp`만 허용(경로 조작 차단). 파일 경로는 DB의 `storage_path`로만 조립한다.
- `status = 'attached'`인 사진만 제공한다(`pending`은 404 — 공개 버킷에서 URL을 반환하지 않는 것과 동일한 노출 수준).
- 응답 헤더: DB `content_type`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=3600`.

### 5.5 `POST /api/requests` — 기존 계약 + `photoIds`

- Content-Type·Origin 검사는 **기존 그대로**(`require_auth_post_request`).
- 입력 추가: `photoIds?: string[]` (UUID 문자열, 0~5개, 중복 불가, 누락 시 `[]`). **`photoIds`를 보내지 않은 기존 요청은 지금과 동일하게 동작하고 동일한 응답 필드를 받는다**(`photos: []` 필드만 추가됨).
- 트랜잭션(한 커밋):
  1. 구매요청 INSERT
  2. `SELECT id FROM purchase_request_photos WHERE id = ANY(:ids) AND uploader_id = :buyer AND status = 'pending' AND request_id IS NULL AND storage_backend = :backend AND storage_bucket IS NOT DISTINCT FROM :bucket AND created_at > now() - interval '24 hours' ORDER BY id FOR UPDATE`
     - **`ORDER BY id`로 잠금 순서를 고정**한다. 두 요청이 같은 사진 집합을 서로 다른 배열 순서로 보내도 잠금을 같은 순서로 얻어 역순 교착이 생기지 않는다. `sort_order`는 잠금 순서와 별개로 요청 배열 인덱스로 매긴다.
  3. 결과 개수 ≠ 요청 개수 → 롤백, `422 VALIDATION_ERROR`, `fields.photoIds = "사진을 다시 업로드해 주세요."`
  4. 각 행 `status='attached'`, `request_id`, `sort_order = 배열 인덱스`, `updated_at = now()`
  5. 커밋
- 동시에 같은 사진으로 두 번 등록하면 행 잠금으로 직렬화되어 한 건만 성공하고 다른 건은 422(구매요청 행도 롤백되어 남지 않음).
- 스키마 수준 오류(6개 이상, 중복, UUID 아님, 배열 아님)는 `validation_error_handler`의 고정 메시지 `fields.photoIds = "사진은 서로 다른 5장 이하로 첨부해 주세요."`.
- 성공 응답은 5.6의 상세 형태. `purchase_requests.thumbnail_url`은 여전히 `NULL`.

### 5.6 조회 응답 변경 (`GET /api/requests`, `GET /api/requests/{id}`, `POST` 응답)

- 조회는 **현재 이름공간과 일치하는** attached 사진만 사용한다(다른 이름공간 행은 숨김).
- `PurchaseRequestSummary.thumbnailUrl`: `sort_order = 0`인 attached 사진의 URL, 없으면 `null`. (필드 이름·타입 불변)
- `PurchaseRequestDetail.photos`: **새 필드**, `sort_order` 오름차순.

```json
"photos": [
  { "id": "uuid", "url": "https://<project>.supabase.co/storage/v1/object/public/<bucket>/photos/<uuid>.jpg" }
]
```

- URL 조립(`app/services/photo_urls.py`, Storage 호출 없음):
  - `supabase`: `{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_STORAGE_BUCKET}/{storage_path}` (경로 구성요소 퍼센트 인코딩)
  - `local`: `/api/request-photos/files/{id}.{ext}` (상대 경로 — 브라우저가 프런트 origin 기준으로 요청하고 rewrite가 백엔드로 전달)
  - `disabled`: 사진을 숨긴다(`photos: []`, `thumbnailUrl: null`). 애플리케이션 시작 시 경고 로그 1회.
- 목록은 페이지의 요청 ID들로 **쿼리 1회**(`DISTINCT ON (request_id) … ORDER BY request_id, sort_order`)로 대표 사진을 가져온다(N+1 금지). 상세는 해당 요청의 attached 사진 1회 조회.
- **레거시 요청**(사진 0장): `thumbnailUrl: null`, `photos: []`. 기존 행을 변경하지 않는다.

### 5.7 오류 코드

`ERROR_MESSAGES`에 4개 추가. 기존 코드·메시지는 변경하지 않는다.

| code | status | message | 발생 |
| --- | --- | --- | --- |
| `PAYLOAD_TOO_LARGE` | 413 | `사진은 3MB 이하만 올릴 수 있어요.` | 5.2의 5·7·8′단계 |
| `INVALID_IMAGE` | 422 | `JPG, PNG, WEBP 형식의 2천만 화소 이하 정지 사진만 올릴 수 있어요.` | 5.2의 8단계 |
| `PHOTO_LIMIT_EXCEEDED` | 409 | `업로드 중인 사진이 너무 많아요. 잠시 후 다시 시도해 주세요.` | 5.2의 6·9단계 |
| `PHOTO_STORAGE_UNAVAILABLE` | 503 | `사진 업로드를 지금 사용할 수 없어요.` | 드라이버 비활성, Storage 저장 실패 |

재사용: `INVALID_ORIGIN`(403), `UNAUTHENTICATED`(401), `UNSUPPORTED_MEDIA_TYPE`(415), `VALIDATION_ERROR`(422, `fields.photoIds`), `NOT_FOUND`(404), `SERVICE_UNAVAILABLE`(503, DB 실패), `INTERNAL_ERROR`(500).

`validation_error_handler`의 `/api/requests` 허용 필드에 `photoIds`를 추가한다. `/api/request-photos`는 Pydantic 본문이 없으므로 경로 매개변수 오류만 `VALIDATION_ERROR`(fields 비움)로 나간다.

### 5.8 인증·소유권 규칙 요약

| 상황 | 결과 |
| --- | --- |
| 비로그인 업로드/삭제 | 401 |
| 타인의 `photoId`로 등록 | 422 `fields.photoIds` (타인 사진 존재 여부 비노출) |
| 타인의 `photoId` 삭제 | 404 |
| 이미 연결된 사진 재사용 | 422 |
| 만료(24h 경과) 사진으로 등록 | 422 |
| 목록/상세 조회 | 공개. 사진 URL은 공개 URL |

---

## 6. DB/Storage 일관성

### 6.1 상태 머신

```
            업로드 요청 수락
                 │
                 ▼
          ┌─────────────┐  Storage 실패 / 확정 커밋 실패 후 보상
          │  uploading  │───────────────────────────────┐
          └─────────────┘                               │
                 │ Storage 성공 + 확정 커밋             │
                 ▼                                      ▼
          ┌─────────────┐   DELETE / 만료 정리    ┌─────────────┐
          │   pending   │────────────────────────▶│  discarded  │── 객체 삭제 확인 → object_deleted_at 기록
          └─────────────┘                         └─────────────┘
                 │ 등록 트랜잭션                        ▲
                 ▼                                      │ (이번 단계에는 없음: 요청 삭제 기능 도입 시)
          ┌─────────────┐                               │
          │  attached   │───────────────────────────────┘
          └─────────────┘
```

- 행은 **삭제하지 않는다**(소프트 상태). 검증 데이터 보존 원칙과 추적성을 함께 만족한다.
- `discarded`는 **종착 상태**다. `discarded`에서 다른 상태로 돌아가는 전이는 없다.
- 모든 상태 전이는 **조건부 UPDATE**(`WHERE id = :id AND status = :expected`)로 수행하고, 영향 행 수가 1일 때만 성공으로 본다. 재시도해도 결과가 같다(멱등).

**불변식**

1. **I-1 행 선기록**: Storage 객체가 존재할 수 있는 모든 경우에 대응 DB 행이 존재한다(Storage 호출 전에 의도 행을 커밋).
2. **I-2 삭제 전 폐기 확정**: Storage 객체 삭제는 그 행이 `discarded`로 **커밋되었음을 확인한 뒤에만** 호출한다. 따라서 `pending`·`attached` 행이 삭제된(보상된) 객체를 가리키는 일은 없다.
3. **I-3 불확실하면 삭제하지 않음**: DB 커밋 결과가 불확실하면(커밋 중 예외) 그 요청 안에서는 Storage 삭제를 하지 않고, 새 세션으로 행을 다시 읽어 확정된 상태에 따라서만 행동한다. 다시 읽기도 실패하면 아무것도 하지 않고 정리 명령에 맡긴다.
4. **I-4 늦은 쓰기 대비**: Storage 저장 결과가 불확실한 경우(타임아웃·연결 오류·5xx·응답 해석 실패)에는 즉시 삭제를 시도하더라도 `object_deleted_at`을 기록하지 않는다. 요청이 끝난 뒤 저장이 늦게 반영될 수 있으므로, 정리 명령이 유예(1h) 뒤 다시 삭제하고 그때 기록한다.
5. **I-5 이름공간 고정**: 삭제·정리는 행의 `(storage_backend, storage_bucket)`이 현재 드라이버와 같을 때만 수행한다.

### 6.2 업로드 실패와 보상

| 실패 지점 | 처리 순서 | 최종 DB 상태 | 응답 | 이후 |
| --- | --- | --- | --- | --- |
| 의도 행 트랜잭션 실패(한도 초과 포함) | 롤백 | 행 없음 | 409 또는 503 `SERVICE_UNAVAILABLE` | 없음(Storage 미호출) |
| Storage 저장 실패(모든 오류를 결과 불확실로 취급) | ① `uploading → discarded`(+`discarded_at`) 조건부 커밋 ② 커밋 확인 시에만 삭제 1회 시도 | `discarded`, `object_deleted_at NULL`(I-4) | 503 `PHOTO_STORAGE_UNAVAILABLE` | 정리 ②가 유예 후 재삭제·기록 |
| 위 ①의 폐기 커밋 자체 실패 | Storage 삭제 안 함(I-3) | `uploading` 유지 | 503 `PHOTO_STORAGE_UNAVAILABLE` | 정리 ①(25h 후) |
| Storage 성공 → `pending` 확정 커밋에서 예외 | **새 세션으로 행 다시 읽기** | 아래 분기 | 아래 분기 | 아래 분기 |
| ├ 다시 읽은 상태 = `pending` | 커밋은 실제로 성공했음. 삭제하지 않음 | `pending` | **201**(정상 응답) | 없음 |
| ├ 다시 읽은 상태 = `uploading` | `uploading → discarded` 조건부 커밋, 확인 시 삭제 시도. 저장이 성공 응답으로 끝났으므로 늦은 쓰기가 없어 삭제 확인 시 `object_deleted_at` 기록 가능 | `discarded` | 503 `SERVICE_UNAVAILABLE` | 삭제 실패 시 정리 ② |
| └ 다시 읽기 실패 / 폐기 커밋 실패 | 아무것도 삭제하지 않음(I-3) | `uploading` 또는 알 수 없음 | 503 `SERVICE_UNAVAILABLE` | 정리 ①(25h 후, 다시 읽고 판단) |
| 응답 전송 중 클라이언트 연결 끊김 | — | `pending` | (전달 안 됨) | 등록하지 않으면 만료 후 정리 ① |

- Storage 저장은 `x-upsert: false`로 호출한다. 경로가 새 UUID이므로 충돌은 발생하지 않으며, 충돌 응답도 실패(결과 불확실)로 처리한다.
- 클라이언트의 재시도는 **새 업로드**(새 `photoId`)다. 실패한 행을 재사용하지 않으므로 재시도가 이전 실패 행의 상태와 경합하지 않는다.
- 보상 로직은 서비스 계층(`app/services/request_photos.py`)에 두고, 모든 예외 경로에서 **원래 오류 응답을 유지**한다(보상 실패가 응답 코드를 바꾸지 않는다). 보상 실패는 `photo_id`와 단계 이름만 로그로 남긴다.
- `DELETE /api/request-photos/{id}`도 같은 규칙을 따른다: `discarded` 커밋에서 예외가 나면 새 세션으로 다시 읽어 `discarded`일 때만 Storage 삭제를 진행하고, 아니면 Storage를 건드리지 않고 503 `SERVICE_UNAVAILABLE`.

### 6.3 버려진 업로드

- 업로드 후 등록하지 않고 떠난 경우, 폼에서 제거했지만 DELETE가 실패한 경우, 422로 등록이 거절된 경우 → 행은 `pending`으로 남고 24시간 뒤 사용 불가가 된다.
- 한도(5.2의 6·9단계)는 만료되지 않은 `uploading`/`pending`만 세므로, 버려진 업로드가 사용자를 영구히 막지 않는다.

### 6.4 정리 명령

`uv run python -m app.jobs.sweep_request_photos [--apply] [--limit 100]`

- 기본은 **dry-run**(대상 개수만 출력, 아무것도 변경하지 않음). `--apply`일 때만 변경한다.
- **현재 드라이버의 이름공간 행만** 처리한다(I-5). 드라이버가 `disabled`이면 실행을 거부하고 0이 아닌 종료 코드로 끝난다. 다른 이름공간 행은 개수만 "건너뜀"으로 보고한다.
- 대상(`object_deleted_at IS NULL`인 현재 이름공간 행 중):
  ① `status IN ('uploading','pending')` 이고 `created_at < now() - 25h` (만료 24h + 유예 1h — 등록 트랜잭션의 만료 경계와 겹치지 않고, 진행 중 업로드와도 겹치지 않음)
  ② `status = 'discarded'` 이고 `discarded_at < now() - 1h` (저장 타임아웃 뒤 늦게 반영된 쓰기까지 지우기 위한 유예. 요청 경로에서 이미 삭제를 시도했더라도 **다시 삭제**한다)
- 처리:
  1. 대상 행을 `ORDER BY id FOR UPDATE SKIP LOCKED LIMIT :limit`로 잠그고 상태를 재확인한다.
  2. ① 행은 조건부 UPDATE로 `discarded`(+`discarded_at = now()`) 전환 후 **커밋**한다. 생성 후 25h가 지나 늦은 쓰기 가능성이 없으므로 같은 실행에서 바로 삭제 단계로 넘어간다.
  3. 커밋이 확인된 행만 Storage 일괄 삭제를 호출한다(I-2). 커밋이 불확실하면 그 행은 이번 실행에서 건너뛴다(I-3).
  4. 삭제가 확인된 행(삭제 목록에 있거나 원래 없던 객체)만 `object_deleted_at = now()` 커밋. 실패 행은 그대로 두어 다음 실행에서 재시도.
  두 번 실행해도 결과가 같다(멱등).
- 서비스 함수 `sweep_request_photos(db, storage, namespace, *, now, limit, dry_run, uploader_id=None)`는 `uploader_id` 범위를 받을 수 있다. **테스트는 반드시 자기 테스트 사용자 범위로만 호출**한다(공유 DB의 다른 워커 데이터 보호).
- 로컬 공유 DB에서 `--apply`를 범위 없이 실행하지 않는다(검증 데이터 보존). 운영 실행 주기(수동/Cron)는 12장 결정 사항.
- `attached` 사진은 이 단계에서 정리 대상이 아니다.

---

## 7. 프론트엔드 설계

### 7.1 API 클라이언트와 타입

- `src/types/request.ts`
  - `RequestPhoto { id: string; url: string }`
  - `PurchaseRequestDetail.photos: RequestPhoto[]`
  - `CreateRequestPayload.photoIds?: string[]`
  - `UploadedRequestPhoto { id: string; contentType: string; byteSize: number; expiresAt: string }`
- `src/types/api.ts` `ApiErrorCode`와 `src/lib/api/http.ts` `KNOWN_ERROR_CODES`에 4개 코드 추가. `fallbackCode`에 `413 → PAYLOAD_TOO_LARGE` 추가.
- `src/lib/api/requests.ts`
  - `ALLOWED_FIELD_KEYS`에 `photoIds` 추가.
  - `parseDetail`: `photos`가 **없으면 `[]`**(배포 순서 차이 대비), 배열인데 항목이 `{id: string, url: string}`가 아니면 `INTERNAL_ERROR`.
  - **URL 안전 검사** `isSafeImageUrl(url)`: `https://`, `http://`(개발), 또는 `/api/request-photos/files/`로 시작하는 상대 경로만 허용. `javascript:`, `data:`, `//host` 등은 거부. `thumbnailUrl`이 안전하지 않으면 `null`로, `photos` 항목이 안전하지 않으면 해당 항목을 제외한다.
  - `createRequest`: `photoIds`가 비어 있으면 **키 자체를 보내지 않는다**(레거시와 바이트 단위로 같은 JSON).
- 새 파일 `src/lib/api/requestPhotos.ts`
  - `uploadRequestPhoto(file: File, signal?)`: `fetch('/api/request-photos', { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'X-Requested-With': 'gamja-market' }, credentials: 'same-origin', cache: 'no-store' })`. 응답 파싱 실패 → `INTERNAL_ERROR`.
  - `deleteRequestPhoto(id: string)`: `DELETE /api/request-photos/{id}` + `X-Requested-With`. 실패는 호출 측에서 무시 가능하도록 예외를 던지되 UI는 무시한다.

### 7.2 등록 폼 — `PhotoPicker`

새 컴포넌트 `src/features/requests/components/PhotoPicker.tsx` (client). `RequestForm`의 비활성 사진 버튼을 대체한다.

- 입력: `<input type="file" accept="image/jpeg,image/png,image/webp" multiple>`를 시각적으로 숨기고 `<label>` 버튼 "사진 추가 (n/5)"로 연다. 5장이면 버튼 비활성.
- 선택 즉시 **클라이언트 사전 검증**(서버가 최종 판정):
  - 합계 5장 초과분은 추가하지 않고 "사진은 최대 5장까지 첨부할 수 있어요." 표시
  - `file.size > 3 * 1024 * 1024` → 해당 파일 거부, "3MB 이하 사진만 올릴 수 있어요."
  - `file.type`이 허용 3종이 아니면 거부, "JPG, PNG, WEBP 사진만 올릴 수 있어요."
- 통과한 파일은 항목 상태 `uploading`으로 추가하고 **한 번에 1장씩 순차 업로드**. 미리보기는 `URL.createObjectURL(file)`(서버 URL 사용 안 함). 항목 제거·컴포넌트 해제 시 `URL.revokeObjectURL`.
- 항목 상태: `uploading`(스피너, `aria-busy`) → `uploaded(id)` / `failed(message)`.
- 첫 번째 항목에 "대표" 배지(목록 썸네일로 쓰인다는 뜻). 순서 변경 UI는 없다(선택 순서 = 표시 순서).
- 항목별 버튼: 제거(접근 가능한 이름 "사진 n 삭제"), `failed`이면 "다시 시도".
  - `uploaded` 항목 제거 → 목록에서 즉시 제거 + `deleteRequestPhoto` fire-and-forget.
  - 업로드 중 항목 제거 → `AbortController`로 취소 후 제거.
- 업로드 오류 표시(코드 기준):

| code | 항목 메시지 |
| --- | --- |
| `PAYLOAD_TOO_LARGE` | 3MB 이하 사진만 올릴 수 있어요. |
| `UNSUPPORTED_MEDIA_TYPE`, `INVALID_IMAGE` | JPG, PNG, WEBP 형식의 2천만 화소 이하 정지 사진만 올릴 수 있어요. |
| `PHOTO_LIMIT_EXCEEDED` | 업로드 중인 사진이 너무 많아요. 잠시 후 다시 시도해 주세요. |
| `PHOTO_STORAGE_UNAVAILABLE` | 사진 업로드를 지금 사용할 수 없어요. 사진 없이 등록할 수 있어요. |
| `UNAUTHENTICATED` | (폼 상단 기존 "다시 로그인" 블록 표시) |
| `NETWORK_ERROR` | 네트워크 연결을 확인한 뒤 다시 시도해 주세요. |
| 기타 | 잠시 후 다시 시도해 주세요. |

- 안내 문구(항상 표시): "JPG·PNG·WEBP 정지 이미지, 장당 3MB, 최대 5장. 첫 번째 사진이 대표 사진이 돼요. 사진의 위치 정보 등 메타데이터는 자동으로 지워져요."

### 7.3 등록 폼 제출 규칙 (`RequestForm`)

- `PhotoPicker`는 상위에 `{ uploadedIds: string[], pendingCount: number, failedCount: number }`를 알린다.
- 업로드 중(`pendingCount > 0`)이면 제출 버튼 비활성 + 문구 "사진 업로드가 끝나면 등록할 수 있어요."
- 실패 항목이 있으면(`failedCount > 0`) 제출 시 클라이언트 검증 오류 `photos` 필드: "업로드에 실패한 사진을 다시 시도하거나 삭제해 주세요." (조용히 누락시키지 않는다)
- 제출 payload: 기존 필드 + `photoIds: uploadedIds`(1장 이상일 때만).
- 서버 `VALIDATION_ERROR` + `fields.photoIds` → 사진 영역 아래 메시지 표시, 사진 항목을 모두 비운다(만료·재사용 사진은 되살릴 수 없음). 다른 입력값은 보존.
- "초기화" 버튼: 사진 항목도 비우고 업로드된 항목은 `deleteRequestPhoto` fire-and-forget.
- 성공 시 기존과 같이 `/requests/{id}` 이동.

### 7.4 목록·상세

- `RequestCard`: 기존 `thumbnailUrl` 분기 유지, `<img>`에 `loading="lazy"`, `decoding="async"` 추가. alt 문구 유지(`{title} 참고 이미지`).
- 새 컴포넌트 `src/features/requests/components/RequestPhotoGallery.tsx`:
  - `photos.length === 0` → 렌더하지 않는다(레거시 상세 화면은 현재와 동일).
  - 1장 이상 → 큰 이미지 1개(`aspect-[4/3]`, `object-contain`, 배경 `stone-100`) + 2장 이상이면 썸네일 버튼 목록. 버튼 이름 "사진 n / 총", 선택 항목 `aria-pressed="true"`. 큰 이미지 alt: `{title} 사진 n/총`.
  - client 컴포넌트(선택 상태만 가짐). 서버에서 받은 URL을 그대로 `<img src>`에 쓴다(`next/image` 미사용 → `remotePatterns` 설정 불필요).
- `RequestDetail`: 제목(`h1`) 아래, 가격 카드 위에 `<RequestPhotoGallery photos={request.photos} title={request.title} />` **한 줄만 추가**한다. 4단계가 같은 파일의 지원자 영역을 수정하므로 변경 범위를 최소화해 병합 충돌을 줄인다.
- 기존 테스트 fixture에는 `photos: []`를 추가한다.

### 7.5 환경 변수

프런트엔드에는 **새 환경 변수가 없다.** Supabase URL·키를 `NEXT_PUBLIC_*`로 노출하지 않는다. 이미지 URL은 백엔드 응답에 완성된 형태로 담긴다.

---

## 8. 백엔드 구성과 설정

### 8.1 파일 구성

| 레이어 | 파일 | 책임 |
| --- | --- | --- |
| API | `app/api/request_photos.py` (신규) | 업로드·삭제·로컬 파일 라우트, 의존성, 예외 → `ApiError` |
| API | `app/api/requests.py` | `photo_ids` 전달, 신규 도메인 예외 매핑 |
| API | `app/api/deps.py` | `require_same_origin_mutation`, `require_image_upload_request`, `get_photo_storage` |
| Schema | `app/schemas/requests.py` | `photo_ids`, `RequestPhoto`, `PurchaseRequestDetail.photos` |
| Schema | `app/schemas/request_photos.py` (신규) | 업로드 응답 모델 |
| Service | `app/services/photo_validation.py` (신규) | 시그니처 사전 판정 + Pillow 디코딩 검증·정규화 재인코딩(순수 함수, 입력 bytes → 출력 bytes/메타) |
| Service | `app/services/request_photos.py` (신규) | 업로드·폐기·보상·정리 트랜잭션 |
| Service | `app/services/photo_urls.py` (신규) | 드라이버별 URL 조립(순수 함수) |
| Service | `app/services/requests.py` | 등록 시 사진 연결, 조회 시 사진·썸네일 결합 |
| Repository | `app/repositories/request_photos.py` (신규) | SQL(커밋 안 함) |
| Storage | `app/storage/base.py`, `supabase.py`, `local.py` (신규) | `PhotoStorage` 프로토콜: `namespace -> (backend, bucket)`, `put(path, data, content_type)`, `delete_many(paths) -> set[str]`(삭제 확인된 경로) |
| Job | `app/jobs/sweep_request_photos.py` (신규) | 정리 명령 CLI |
| Model | `app/db/models.py` | `PurchaseRequestPhoto` |
| Migration | `migrations/versions/0004_create_purchase_request_photos.py` | 4.2 |
| Test support | `tests/support/schema.py`, `tests/support/fake_storage.py` (신규) | 9장 |

- `PhotoStorage` 구현은 **동기** 함수다(기존 라우터가 동기 `def`이므로 일관성 유지). `httpx.Client` 타임아웃 10초.
- 본문 스트리밍 읽기는 라우트를 `async def`로 두고 `request.stream()`을 누적 상한으로 읽은 뒤, DB·Storage 작업은 `run_in_threadpool`로 서비스 함수를 호출한다.

### 8.2 Supabase Storage REST 호출 (`supabase` 드라이버)

공식 문서(Standard Uploads, Serving assets, Creating Buckets, API keys) 기준. 실제 연동 검증 전까지는 **미검증** 항목이다(10.2).

| 동작 | 요청 |
| --- | --- |
| 저장 | `POST {SUPABASE_URL}/storage/v1/object/{bucket}/{path}` — 헤더 `apikey: <secret>`(항상), `Authorization: Bearer <secret>`(레거시 service_role JWT만; `sb_secret_`에는 생략), `Content-Type: <정규화 결과 포맷>`, `x-upsert: false`, `cache-control: 3600`, 본문 = 바이트 |
| 삭제(일괄) | `DELETE {SUPABASE_URL}/storage/v1/object/{bucket}` — 동일 인증 헤더, JSON `{"prefixes": ["photos/…", …]}`. 응답의 삭제된 객체 목록 + 원래 없던 객체를 "삭제 확인"으로 간주(멱등) |
| 공개 URL | `{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}` (호출 없음, 문자열 조립) |

- 최신 secret key는 JWT가 아니므로 `apikey` 헤더에만 넣는다. 레거시 service_role JWT에는 Bearer 헤더도 넣는다([공식 API keys 문서](https://supabase.com/docs/guides/getting-started/api-keys), 구현 준비 시 확인).
- 비밀 키는 `SecretStr`로 보관하고 헤더를 만들 때만 꺼낸다. 예외 메시지·로그·`repr`에 키, 요청 헤더, 응답 본문 전체를 넣지 않는다. 로그에는 동작 이름, HTTP 상태 코드, `photo_id`만 남긴다.
- 버킷은 **사람이 Supabase 대시보드에서 수동 생성**한다(앱이 버킷을 만들지 않는다): 공개(public) 버킷, `allowed_mime_types = image/jpeg, image/png, image/webp`, `file_size_limit = 3145728`(3MiB)(서버 검증과 이중 방어). `storage.objects`에 익명 정책을 추가하지 않는다.

### 8.3 설정 (이름만 정의 — 값은 사람이 설정)

모두 **백엔드 전용**이다. `.env.example`에는 이름과 빈 값만 추가하고, 실제 `.env` 파일은 이 작업에서 수정하지 않는다.

| 이름 | 필수 조건 | 설명 |
| --- | --- | --- |
| `PHOTO_STORAGE_DRIVER` | 선택, 기본 `disabled` | `disabled` \| `local` \| `supabase` |
| `SUPABASE_URL` | driver=`supabase`일 때 필수 | 프로젝트 URL. `https://`로 시작, 끝 `/` 금지 |
| `SUPABASE_SECRET_KEY` | driver=`supabase`일 때 필수 | 서버 전용 비밀 키(`sb_secret_…` 또는 레거시 service_role). **절대 프런트·로그·응답에 노출 금지** |
| `SUPABASE_STORAGE_BUCKET` | driver=`supabase`일 때 필수 | 공개 버킷 이름 |
| `PHOTO_LOCAL_STORAGE_DIR` | driver=`local`일 때 필수 | 로컬 저장 디렉터리(절대 경로 권장). 저장소 추적 대상 밖이어야 함 |

설정 검증(`Settings` model validator, 기존 스타일과 동일하게 시작 시 실패):

- driver=`supabase`인데 3개 중 하나라도 비어 있음 → 오류(메시지에 값 미포함).
- driver=`local`이고 `AUTH_ALLOWED_ORIGINS`에 `https://` origin이 있음 → 오류(운영에서 로컬 드라이버 금지).
- `memory`는 설정값으로 허용하지 않는다(테스트가 dependency override로만 주입).
- 코드 상수(설정 아님): 요청당 5장, 원본·정규화 결과 각각 3,145,728바이트, 디코딩 픽셀 20,000,000, JPEG/WebP 재인코딩 품질 85(초과 시 75·65 재시도), 만료 24h, 사용자당 활성 업로드 10장, 정리 유예 1h, Storage 타임아웃 10초, 업로드 `cache-control` 3600.
- `backend/.gitignore`에 로컬 저장 기본 위치 `.local-storage/`를 추가한다.

---

## 9. 공유 DB 테스트 전략 (기존 fixture 교체 포함)

### 9.1 원칙

- 로컬 DB 하나를 4단계와 **동시에** 사용한다. 새 DB·새 스키마를 만들지 않는다.
- 테스트는 **아무 행도 삭제·TRUNCATE하지 않고**, DROP·downgrade·reset하지 않으며, `alembic_version`을 읽거나 쓰지 않는다.
- 테스트가 만든 행은 그대로 남긴다(검증 데이터 보존). 따라서 모든 단언은 **테스트 자신이 만든 데이터로 범위를 좁혀야** 한다.
- 이 교체가 끝나기 전에는 기존 `pytest`를 실행하지 않는다(현재 fixture가 TRUNCATE를 수행하므로).

### 9.2 `conftest.py` 교체

| 기존 | 교체 |
| --- | --- |
| `migrate_database`: `command.upgrade(config, "head")` | `ensure_schema`(session, autouse): `tests.support.schema.ensure_additive_schema(engine)` (4.2-4). 버전 테이블 무변경 |
| `clean_database`(autouse): `TRUNCATE … CASCADE` | **삭제.** 대신 `run_tag` fixture: `f"t{uuid4().hex[:10]}"` — 테스트마다 고유 |
| 고정 이메일 `buyer@example.com` | `unique_email(prefix="buyer")` 헬퍼: `f"{prefix}-{run_tag}@example.com"` |
| — | `photo_storage` fixture: `FakePhotoStorage`를 `app.dependency_overrides[get_photo_storage]`로 주입, 종료 시 override 제거. 실패 주입 스위치(`fail_put`, `fail_delete`, `put_raises_then_late_write`, `put_delay`) 제공, 호출 순서 기록. DB 커밋 실패는 서비스에 주입하는 세션 래퍼(`commit_raises_before`, `commit_raises_after`, `reread_fails`)로 모사 |

### 9.3 기존 테스트 변환 규칙

| 기존 테스트 | 문제 | 변환 |
| --- | --- | --- |
| `test_auth.py` 전반의 고정 이메일 | 남아 있는 행과 중복 → 409 | `unique_email()` 사용 |
| `test_signup_mismatch…` `count(users) == 0` | 전체 테이블 개수 | 해당 이메일 행 개수 0 |
| `test_create_request_requires_authentication` `count(purchase_requests) == 0` | 전체 개수 | 제목에 `run_tag`를 넣고 그 제목 행 개수 0 |
| 목록 `total == 15`, `total == 1`, `total == 2`, 정렬·페이지 안정성 | 빈 DB 가정 | 생성하는 모든 제목에 `run_tag` 포함, 목록 요청에 `q=run_tag` 추가 후 단언 |
| `test_detail_returns_masked_buyer_email_only` 고정 이메일·마스킹 | 이메일 고유성 | 로컬파트는 케이스 그대로 두고 도메인을 `{run_tag}.example.com`으로 바꿔 기대값도 같은 방식으로 계산 |
| `test_deleting_user_cascades_requests` `DELETE FROM users` | 행 삭제 | 카탈로그 검사로 대체: `pg_constraint`에서 `purchase_requests.buyer_id` FK의 `confdeltype = 'c'` 확인 |
| `test_migration_0002_upgrade_and_downgrade` | 공유 DB에서 `purchase_requests` DROP | inspector로 테이블·CHECK·인덱스 존재만 확인. downgrade는 offline SQL 렌더링(`alembic downgrade 0002_create_purchase_requests:0001_create_auth_tables --sql`)으로 DROP 대상이 `purchase_requests` 관련 객체뿐임을 문자열로 확인 |
| `test_db_check_constraints_reject_invalid_rows` | 실패하는 INSERT(롤백) | 그대로 유지(행이 남지 않음, 삭제 아님) |
| 기존 응답 필드 단언(`thumbnailUrl is None`) | — | 그대로 유지 + `photos == []` 단언 추가 |

### 9.4 새 백엔드 테스트 (`backend/tests/test_request_photos.py`)

테스트 이미지는 **Pillow로 테스트 안에서 생성한 실제 이미지**(예: 8×6 JPEG/PNG/WebP, 메모리 `BytesIO`)다. 저장소에 이미지 파일을 추가하지 않는다. **가짜 시그니처 바이트가 통과하는 것을 전제로 한 테스트는 쓰지 않는다** — 가짜 시그니처는 거절되어야 하는 입력으로만 쓴다. fake storage 행의 이름공간은 `('memory', NULL)`이다.

**이미지 검증·정규화 단위 테스트** (`photo_validation`, DB 불필요)

| # | 입력(테스트에서 생성) | 기대 |
| --- | --- | --- |
| V1 | 실제 JPEG/PNG/WebP 소형 이미지, 선언 타입 일치 | 성공. 출력 포맷 = 입력 포맷, 출력 bytes를 Pillow로 다시 열면 같은 크기 |
| V2 | EXIF Orientation=6 + GPS 태그를 넣은 8×6 JPEG | 출력 6×8(회전 반영), 출력에 EXIF(`getexif()` 비어 있음)·GPS 없음 |
| V3 | `tEXt` 청크를 넣은 PNG, ICC 프로필을 넣은 JPEG, XMP를 넣은 WebP | 출력에 텍스트 청크·`icc_profile`·XMP 없음 |
| V4 | 투명도 있는 RGBA PNG / RGBA WebP | 알파 채널 보존 |
| V5 | CMYK JPEG | RGB JPEG로 출력 |
| V6 | 실제 JPEG를 절반에서 자른 바이트(잘림), 올바른 시그니처 + 무작위 바이트(가짜 매직), 빈 본문, HTML | `InvalidImage` |
| V7 | 실제 PNG를 `image/jpeg`로 선언 | `InvalidImage` |
| V8 | 5000×4001 단색 PNG(바이트는 작음) | 디코딩 전에 `InvalidImage`(20MP 초과). 4000×5000은 성공(느린 테스트 표시 가능) |
| V9 | 2프레임 애니메이션 WebP, 2프레임 APNG | `InvalidImage` |
| V10 | 출력 상한을 테스트용으로 낮춰 주입(함수 인자) — JPEG는 품질 단계 하향으로 통과, PNG는 초과 시 `ImageTooLarge` | 품질 85→75→65 재시도 순서와 최종 실패를 명시적으로 확인 |

**업로드**

| # | 시나리오 | 기대 |
| --- | --- | --- |
| P1 | 실제 JPEG/PNG/WEBP 각각 업로드 | 201, 응답에 `id/contentType/byteSize/width/height/expiresAt`만 있고 URL·경로 없음. DB 행 `pending`·이름공간 `memory`, fake storage에 `photos/{id}.{ext}`로 **정규화된 바이트**(EXIF 없음) 저장, `byte_size` = 저장 바이트 길이 |
| P2 | 비로그인 | 401, 행·객체 없음 |
| P3 | Origin 또는 `X-Requested-With` 누락 | 403 |
| P4 | `image/gif`, `image/svg+xml`, `application/octet-stream`, `multipart/form-data`, `application/json` | 415 |
| P5 | PNG + `image/jpeg` 선언, 빈 본문, HTML + `image/png`, 잘린 JPEG, 가짜 매직 바이트, 20MP 초과 PNG, 애니메이션 WebP | 422 `INVALID_IMAGE`, 행·객체 없음 |
| P6 | 실제 PNG에 텍스트 청크를 덧붙여 정확히 3,145,728바이트로 맞춘 파일 / 3,145,729바이트(Content-Length 있음) / 3,145,729바이트(청크 전송, Content-Length 없음) | 201(텍스트 청크 제거로 저장 크기 감소) / 413 / 413 |
| P7 | 본인 활성 업로드 10개 상태에서 1장 더 | 409 `PHOTO_LIMIT_EXCEEDED`. `discarded`·`attached`·만료 행은 한도에 불포함(각각 확인) |
| P7b | 활성 9개 상태에서 같은 사용자가 **동시에** 2장 업로드(스레드 2개 + barrier, fake storage `put` 지연) | 정확히 1건 201, 1건 409. 최종 활성 행 10개 |
| P7c | 한 사용자의 업로드 트랜잭션이 사용자 행을 잠근 동안 같은 사용자가 구매요청 등록 | 등록이 막히지 않음(`FOR NO KEY UPDATE`와 FK `KEY SHARE` 비충돌) |
| P8 | 드라이버 `disabled` | 503 `PHOTO_STORAGE_UNAVAILABLE`, 행 없음 |
| P9 | Storage 저장 실패 | 503 `PHOTO_STORAGE_UNAVAILABLE`, 행 `discarded`·`discarded_at` 설정 **후** 삭제 호출(호출 순서 기록으로 확인), `object_deleted_at NULL`(I-4) |
| P10 | 저장 실패 + 폐기 커밋 실패(세션 주입) | 503, Storage 삭제 **호출 없음**, 행 `uploading` 유지 |
| P11 | 늦은 쓰기 모사: `put`이 예외를 던진 뒤 fake storage에 객체가 나중에 생김 | 503, 행 `discarded`·`object_deleted_at NULL`. 유예 경과(`now` 주입) 후 정리 ②가 객체를 지우고 `object_deleted_at` 기록 |
| P12 | 저장 성공 후 확정 커밋이 **실제로는 성공했지만 예외**를 던짐(커밋 후 예외 주입) | 다시 읽기 결과 `pending` → **201**, 객체 삭제 호출 없음 |
| P12b | 저장 성공 후 확정 커밋 실패(커밋 전 예외) | 다시 읽기 `uploading` → `discarded` 커밋 후 삭제, 503 `SERVICE_UNAVAILABLE`, 삭제 확인 시 `object_deleted_at` 설정 |
| P12c | 저장 성공 후 확정 커밋 실패 + 다시 읽기도 실패 | 503, 객체 삭제 호출 없음, 행 `uploading` 유지(정리 ① 대상) |
| P13 | Storage 예외 메시지에 비밀처럼 보이는 문자열 포함 | 응답 본문·로그(caplog)에 해당 문자열 없음 |
| P14 | 업로드 응답·오류 응답 헤더 | `Cache-Control: no-store` |

**등록 연결**

| # | 시나리오 | 기대 |
| --- | --- | --- |
| C1 | 3장 업로드 후 `photoIds` 순서 [2,0,1]로 등록 | 201, `photos` 순서가 요청 순서와 동일, `thumbnailUrl` = 첫 사진 URL, 행 `attached`·`sort_order` 0~2, `purchase_requests.thumbnail_url` NULL |
| C2 | `photoIds` 없이 등록(기존 payload) | 201, 기존 단언 전부 통과 + `photos: []`, `thumbnailUrl: null` |
| C3 | `photoIds: []` | C2와 동일 |
| C4 | 타인 사진 ID | 422 `fields.photoIds`, 해당 `run_tag` 제목의 요청 행 0개, 타인 사진 행 상태 불변 |
| C5 | 이미 연결된 / `discarded` / `uploading` / 존재하지 않는 / 만료(본인 행 `created_at`을 25h 전으로 UPDATE) / **다른 이름공간**(`local` 행을 `memory` 드라이버에서) 사진 | 각각 422, 요청 행 생성 안 됨 |
| C6 | 6개, 중복 ID, UUID 아님, 배열 아님 | 422 `fields.photoIds` |
| C7 | 같은 사진으로 두 세션이 동시에 등록(스레드 2개) | 정확히 1건 201, 1건 422 |
| C7b | 같은 사진 2장을 두 요청이 **반대 배열 순서**로 동시에 등록 | 교착(deadlock 오류) 없이 1건 201, 1건 422. 잠금 SQL에 `ORDER BY id` 포함(리포지토리 단위 확인) |
| C8 | 사진 연결 UPDATE 중 DB 오류 주입 | 503, 요청 행·사진 상태 모두 롤백 |

**조회**

| # | 시나리오 | 기대 |
| --- | --- | --- |
| R1 | `q=run_tag` 목록에 사진 있는 요청 + 레거시 요청 | 각각 첫 사진 URL / `null` |
| R2 | 상세 | `photos` sort_order 순, 레거시는 `[]` |
| R3 | fake storage를 "전부 실패" 모드로 두고 목록·상세 | 200, storage 호출 0회 |
| R4 | 드라이버 `disabled`로 바꾼 뒤 attached 사진 있는 요청 조회 | `photos: []`, `thumbnailUrl: null` |
| R4b | 다른 이름공간(`local`)으로 attached된 사진이 있는 요청을 `memory` 드라이버로 조회 | 해당 사진 숨김 |
| R5 | URL 조립 단위 테스트 | supabase: `{SUPABASE_URL}/storage/v1/object/public/{bucket}/photos/{id}.jpg`, local: `/api/request-photos/files/{id}.jpg` |

**폐기 · 로컬 파일 · 정리**

| # | 시나리오 | 기대 |
| --- | --- | --- |
| D1 | 본인 `pending` 삭제 | 204, 행 `discarded` 커밋 **후** 객체 삭제, `object_deleted_at` 설정 |
| D2 | 타인 / `attached` / 없는 ID / 다른 이름공간 | 404. 비로그인 401, Origin 누락 403, 잘못된 UUID 422 |
| D3 | Storage 삭제 실패 | 204, `object_deleted_at NULL` |
| L1 | local 드라이버: attached 파일 GET | 200, 판정 타입, `nosniff` |
| L2 | local 드라이버: pending 파일, 잘못된 확장자, `..` 포함 경로 | 404 또는 422, 파일시스템 밖 접근 없음 |
| L3 | supabase/disabled 드라이버에서 파일 경로 GET | 404(라우트 없음) |
| S1 | 정리 dry-run(본인 범위) | 변경 없음, 대상 개수 반환 |
| S2 | 정리 apply(본인 범위, `now` 주입) | 만료 pending/uploading → discarded 커밋 후 객체 삭제, 신규 pending·attached 불변, 유예(1h) 안의 `discarded`는 건너뜀·유예 경과 후 재삭제, 삭제 실패 행은 `object_deleted_at NULL` 유지, 두 번째 실행 결과 0건 |
| S3 | 이름공간 분리 | `memory` 드라이버 정리가 본인 범위의 `local`/`supabase` 행을 건드리지 않고 "건너뜀"으로 보고. `disabled` 드라이버로 실행하면 거부 |
| S4 | 폐기 커밋 불확실(커밋 예외 주입) | 해당 행 Storage 삭제 호출 없음, 다음 실행에서 처리 |

**Supabase 어댑터 · 설정 · 스키마**

| # | 시나리오 | 기대 |
| --- | --- | --- |
| A1 | `httpx.MockTransport`로 저장 요청 캡처 | 메서드·URL·`apikey`·레거시 JWT에만 `Authorization: Bearer`·`Content-Type`·`x-upsert: false`·`cache-control` |
| A2 | 삭제 요청 캡처 | `DELETE …/object/{bucket}`, JSON `prefixes` |
| A3 | 4xx/5xx/타임아웃 | `StorageError`, 메시지에 키·응답 본문 없음 |
| A4 | 설정 객체 `repr`/로그 | 비밀 키 문자열 없음 |
| G1 | driver=supabase + 설정 누락 / driver=local + https origin / 미설정 | 검증 오류 / 검증 오류 / `disabled` |
| M1 | `ensure_additive_schema` 2회 실행 | 예외 없음, 테이블·CHECK 10개·인덱스 5개 존재, 실행 전후 `alembic_version` 내용 동일(읽기만 하는 비교는 테스트 코드에서 수행) |
| M2 | `0004` offline downgrade SQL | 사진 테이블·인덱스만 DROP, `purchase_requests`/`users` DROP 없음 |
| M3 | CHECK 위반 INSERT(attached인데 request_id 없음, 잘못된 status/content_type/backend, supabase인데 bucket 없음, byte_size 3,145,729, 20MP 초과 width×height, discarded인데 discarded_at 없음) | `IntegrityError`, 롤백으로 행 없음 |
| M4 | 이 체크아웃의 `ScriptDirectory.get_heads()` | 1개 |
| M5 | 모든 revision 문자열 길이 | 32자 이하, `0004_request_photos`의 `down_revision`이 기존 revision을 가리킴 |

### 9.5 프런트엔드 테스트 (`frontend/tests/`, Vitest + RTL)

| # | 파일 | 시나리오 |
| --- | --- | --- |
| F1 | `requestPhotosApi.test.ts` | 업로드가 raw `File` 본문, `Content-Type=file.type`, `X-Requested-With`, `same-origin`, `no-store`로 호출. 201 파싱. 413/415/422/409/503/401/네트워크 오류 코드 매핑. 삭제는 `DELETE` + 헤더 |
| F2 | `requestsApi.test.ts` 확장 | `photos` 누락 → `[]`, 항목 형식 오류 → `INTERNAL_ERROR`, `javascript:`/`data:`/`//evil` URL → thumbnail `null`·항목 제외, `photoIds` 빈 배열이면 요청 JSON에 키 없음 |
| F3 | `PhotoPicker.test.tsx` | 파일 선택 → 순차 업로드, 미리보기 object URL, 첫 항목 "대표", 6번째 거부 메시지, 3MB 초과·허용 외 타입은 업로드 호출 없이 거부, 제거 시 delete 호출과 revoke, 실패 항목 "다시 시도", 업로드 중 제거 시 abort |
| F4 | `RequestForm.test.tsx` 확장 | 업로드 중 제출 비활성, 실패 항목 있으면 제출 차단 메시지, payload `photoIds` 순서, 사진 없으면 기존 payload와 동일, 서버 `fields.photoIds` → 메시지 + 사진 비움 + 다른 입력 보존, `PHOTO_STORAGE_UNAVAILABLE` 메시지, 초기화 시 사진 비움 |
| F5 | `RequestList`/`RequestCard` 관련 테스트 확장 | 썸네일 `<img>` alt·`loading="lazy"`, `null`이면 이모지 |
| F6 | `RequestPhotoGallery.test.tsx` | 0장 렌더 없음, 1장 썸네일 버튼 없음, 3장 버튼 이름 "사진 2 / 3"·`aria-pressed`·클릭 시 큰 이미지 교체 |
| F7 | 기존 fixture | `photos: []` 추가 후 기존 테스트 전부 통과 |

---

## 10. 검증: 모의 검증과 실제 검증

### 10.1 모의 검증 (이번 단계에서 워커가 수행)

- 자동 테스트: 9.4(fake storage, `httpx.MockTransport`), 9.5.
- UI 검증: `local` 드라이버, 프런트 **3105**, 백엔드 **8105**, 공유 로컬 DB. 환경 파일을 수정하지 않고 **프로세스 환경 변수로만** 주입한다(pydantic-settings는 프로세스 환경 변수가 `.env`보다 우선).
  - 백엔드: `AUTH_ALLOWED_ORIGINS='["http://localhost:3105"]'`, `PHOTO_STORAGE_DRIVER=local`, `PHOTO_LOCAL_STORAGE_DIR=<워크트리>/backend/.local-storage` 를 명령 앞에 붙여 `uv run uvicorn app.main:app --host 127.0.0.1 --port 8105`
  - 프런트: `BACKEND_API_ORIGIN=http://127.0.0.1:8105 npm run dev -- -p 3105`
  - 시작 전 `uv run python -m tests.support.schema`로 추가형 스키마 적용(버전 테이블 무변경).
  - 브라우저 검사는 orca CLI 내장 브라우저로 한다.
- UI 시나리오:

| # | 시나리오 | 기대 |
| --- | --- | --- |
| U1 | 로그인 → 사진 3장 선택 → 등록 | 업로드 진행 표시 → 완료, 등록 후 상세 갤러리 3장, 순서 유지 |
| U2 | 목록 | 해당 카드에 첫 사진 썸네일, 레거시 요청은 이모지 |
| U3 | 로그아웃 후 목록·상세 | 사진 동일하게 보임(공개) |
| U4 | 6장 선택 | 5장만 추가, 안내 메시지 |
| U5 | 3MB 초과 파일, `.gif`/`.svg` 파일 | 업로드 없이 거부 메시지 |
| U6 | 확장자만 `.png`로 바꾼 텍스트 파일, 애니메이션 WebP | 서버 422 → 항목 실패 메시지 |
| U6b | 위치정보·회전 EXIF가 있는 휴대폰 JPEG 업로드 후 상세 | 올바른 방향으로 표시, 저장 파일(`.local-storage`)에 EXIF 없음 |
| U7 | 업로드 후 항목 제거 → 등록 | 제거한 사진은 상세에 없음 |
| U8 | 업로드 중 제출 버튼 | 비활성 + 안내 문구 |
| U9 | 사진 없이 등록 | 기존과 동일, 상세에 갤러리 없음 |
| U10 | 백엔드를 `PHOTO_STORAGE_DRIVER` 없이 재시작 후 사진 선택 | "사진 업로드를 지금 사용할 수 없어요. 사진 없이 등록할 수 있어요.", 사진 없이 등록 가능 |
| U11 | 키보드만으로 사진 추가·제거·갤러리 전환 | 포커스 이동·접근 가능한 이름 정상 |
| U12 | 기존 회귀(가입·로그인·목록 필터·페이지) | 05 문서 I-시나리오와 동일 |

- 검증 데이터(DB 행, `.local-storage` 파일)는 삭제하지 않는다.

### 10.2 실제 검증 (Supabase — 사람이 설정을 제공한 뒤에만)

현재 워크트리의 환경 파일에는 Supabase 관련 설정이 없다. 따라서 **실제 Storage 연동은 이번 단계 산출물에서 "미검증"으로 명시**한다. 사람이 다음을 준비한 뒤 별도로 수행한다:

1. Supabase 대시보드에서 공개 버킷 생성(허용 MIME 3종, 3MB 제한).
2. 백엔드 실행 환경(로컬 셸 또는 Vercel backend 서비스 환경 변수)에 `PHOTO_STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET` 설정.
3. 확인 항목: 업로드 201 후 대시보드에 `photos/{id}.{ext}` 객체와 올바른 Content-Type, 내려받은 객체에 EXIF가 없음, 행의 이름공간이 `('supabase', <bucket>)`, 상세의 공개 URL이 브라우저에서 열림, 폐기 후 객체 삭제, 버킷 제한 초과 파일을 서버 검증 없이 직접 올리면 Storage가 거부(이중 방어 확인), 응답·로그·브라우저 번들(`.next` 산출물)에 비밀 키 문자열이 없음, 삭제 API의 실제 응답 형태가 8.2 가정과 일치.
4. 불일치가 발견되면 어댑터만 수정한다(서비스 계약 불변).

---

## 11. 구현 순서 제안

1. `tests/support/schema.py`, `fake_storage.py`, `conftest.py` 교체와 기존 테스트 변환(9.2, 9.3) → 공유 DB에서 비파괴 확인 후 기존 테스트 GREEN 유지
2. `0004` 마이그레이션(멱등) + 모델 → M1~M4 RED/GREEN
3. 이미지 검증·정규화(Pillow)·URL 조립 순수 함수 → V1~V10·R5 단위 RED/GREEN
4. Storage 프로토콜 + fake + supabase/local 어댑터 + 설정 → A1~A4, G1
5. 업로드·폐기 서비스/라우트 + 오류 코드 → P1~P14, D1~D3, L1~L3
6. 등록 연결·조회 결합 → C1~C8, R1~R4
7. 정리 명령 → S1, S2
8. 프런트 타입·API 클라이언트 → F1, F2
9. `PhotoPicker`, `RequestForm` 연동 → F3, F4
10. 카드·갤러리 → F5~F7
11. UI 모의 검증 U1~U12, 실제 검증 10.2는 사람 준비 후

---

## 12. 사람 검토가 필요한 결정

| # | 항목 | 본 설계의 선택 | 대안 |
| --- | --- | --- | --- |
| 1 | EXIF 위치정보 — **해소됨(권장안 채택)** | Pillow 디코딩 검증 후 EXIF 방향 보정·메타데이터 제거·같은 포맷 재인코딩(5.2). ICC 미보존으로 인한 경미한 색 차이 허용 | ICC 프로필만 보존하는 선택(메타데이터 최소화와 색 정확도의 절충) |
| 2 | 버킷 공개 여부 | 공개 버킷 + 추측 불가 경로, URL 비반환 | 비공개 버킷 + 조회마다 일괄 서명 URL(`createSignedUrls`). pending 노출 0이지만 캐시 적중 없음, 조회가 Storage 가용성에 의존 |
| 3 | 한도 수치 | 5장, 장당 3MiB(Vercel 4.5MB 본문 한도에 맞춤), 20MP, 활성 업로드 10장, 만료 24h | 수치 조정(단, 장당 크기는 4.5MB 본문 한도 미만 유지) |
| 4 | 정리 실행 | 수동 CLI(dry-run 기본) | Vercel Cron → 보호된 내부 엔드포인트(별도 비밀 설정 필요) |
| 5 | `thumbnail_url` 레거시 컬럼 | 유지·미사용 | 이후 마이그레이션에서 제거 |
| 6 | 회원·요청 삭제 시 Storage 객체 | 해당 기능이 없으므로 이월. 도입 시 "discarded 전환 → 객체 삭제 → 행 삭제" 순서 필요 | — |
| 7 | 마이그레이션 번호 | `0004`, 개발 중 `down_revision=0002`, 나중 병합 쪽이 rebase | 4단계와 합의해 다른 번호 사용 |
| 8 | 사진 순서 변경 UI | 없음(선택 순서 고정) | 드래그/화살표 버튼으로 순서 변경 |
| 9 | 업로드 실패 항목 처리 | 제출 차단(명시적 재시도/삭제 요구) | 실패 항목을 자동 제외하고 제출 |

### 4단계와의 병합 접점

- `app/api/errors.py` `ERROR_MESSAGES`, `frontend/src/types/api.ts`, `frontend/src/lib/api/http.ts` `KNOWN_ERROR_CODES`: 양쪽이 코드를 추가할 수 있다. 항목 추가만 하므로 충돌은 기계적으로 해소 가능.
- `app/main.py` `validation_error_handler`의 `request_fields`: `photoIds` 한 줄 추가.
- `RequestDetail.tsx`: 본 설계는 갤러리 한 줄만 추가한다.
- `conftest.py`: 본 설계가 fixture를 교체한다. 4단계 테스트도 같은 공유 DB 원칙(9.1)을 따라야 하며, 병합 시 fixture는 본 설계의 비파괴 버전을 기준으로 한다.
- 마이그레이션 head: 4.2-1 통합 규칙.
