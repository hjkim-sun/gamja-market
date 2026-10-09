# 10. 보안·성능 하드닝 — 구현 계약

> **사람 검토 결과 (2026-10-09)**: §14 H1~H7은 권장 기본값대로 승인되었다. H8은 반려되어 **S-08 의존성 패치를 이번 PR에 포함**한다(§6.6). tester RED → backend/frontend 순서로 진행한다.
>
> 입력: 보안 감사 `security-review.md`(S-01~S-08), 성능 감사 `performance-review.md`(P-01~P-18). 둘 다 코디네이터 작업 공간 `_workspace/2026-10-09/term_8e72d62e-…/reviews/`에 있다. 기존 설계 [02 인증](02-email-password-auth.md), [04 배포](04-login-register-deployment-fix.md), [05 목록](05-purchase-request-registration-discovery.md), [07 사진](07-purchase-request-photos.md), [08 private 버킷](08-private-request-photo-bucket.md), [09 채팅](09-chat-messaging-and-matching.md).
> 조사 대상: worktree `security-performance-hardening`(branch `feature/security-performance-hardening`, HEAD `52bac3f`). 리포트의 file:line 근거는 이 HEAD에서 직접 다시 확인했다(§2).
> 이 문서는 기존 API 계약을 **바꾸지 않고 강화**한다. 바뀌는 계약은 §12에 모두 적었다. 설계자는 이 문서 외에 어떤 파일도 수정하지 않았고, DB에는 접근하지 않았다(`docker ps`로 컨테이너·볼륨 이름만 확인했다).

---

## 0. 한눈에 보기

| 구분 | 내용 |
| --- | --- |
| 이번 PR 포함 | S-01, S-02, S-03(=P-04), S-04, S-05, S-07, S-08(운영 의존성 패치), P-01, P-02(최소안), P-03(설정화), P-05, P-06(최소안), P-07, P-08, P-09, P-11, P-14, P-16 |
| 후속 PR | S-08b(dev 의존성 메이저 업그레이드: vitest 5, tailwindcss 4 등), P-02b(썸네일 변형), P-03b(운영 pooler 전환), P-06b(지원자 수 비정규화·total 근사), P-10, P-12, P-13, P-17, P-18 |
| 미적용 | S-06(의도된 계약, S-01로 완화), P-15(Next 요청 메모이제이션 대상, 중복 근거 없음) |
| 새 오류 code | `429 RATE_LIMITED` + `Retry-After` 헤더 |
| DB 변경 | revision `0006_security_perf_hardening`(additive·멱등): `auth_rate_limits` 테이블, `ix_seller_applications_buyer_id`, `ix_purchase_requests_price_created_id`. 기존 데이터 삭제·변경 없음 |
| 새 설정(env) | `AUTH_RATE_LIMIT_ENABLED`, `TRUST_PROXY_IP_HEADERS`, `DATABASE_POOL_MODE` 외(§5.10). 모두 기본값이 있어 기존 배포가 깨지지 않는다 |
| 작업 분담 | backend: S-01/S-03/S-04/S-07/P-01~P-09/P-11/P-16 · frontend: S-02/S-05/S-08/P-14/RATE_LIMITED 표시/page 상한 · tester: RED 테스트와 conftest(§11) |

---

## 1. 목표와 범위

### 1.1 이 단계에서 하는 것

- 인증 엔드포인트의 무차별 대입과 Argon2 자원 고갈을 서버에서 막는다(S-01, P-08).
- 로그인 후 이동 경로의 오픈 리다이렉트 우회를 막는다(S-02).
- 느린 클라이언트나 외부 스토리지를 기다리는 동안 DB 연결을 잡고 있지 않도록 트랜잭션 경계를 고친다(S-03/P-04, P-01).
- 사진 전송량과 함수 호출 수를 줄인다. CDN 캐시 지시자와 업로드 시 다운스케일을 적용한다(P-02 최소안, P-07).
- 인덱스와 쿼리 비용 상한을 둔다(P-05, P-06, P-11). 모델과 마이그레이션의 인덱스 드리프트를 없앤다(P-16).
- 개발 DB 노출 범위를 줄인다. 기존 로컬 볼륨과 데이터는 그대로 보존한다(S-04).
- 운영 의존성의 알려진 취약 버전을 같은 메이저·마이너 라인의 패치로 올린다: `next`·`eslint-config-next` 15.5.27, `sharp` 0.35.5(S-08, §6.6).
- 저비용 방어를 추가한다: frame-ancestors(S-05), 세션 TTL 상한(S-07), httpx 클라이언트 재사용(P-09), `/me` 중복 호출 제거(P-14).

### 1.2 하지 않는 것

| 항목 | 이유 |
| --- | --- |
| 썸네일 변형 객체 생성·`next/image` 도입 | 저장 구조와 비용 모델이 바뀐다. 이번에는 CDN 캐시와 업로드 다운스케일로 대신한다(P-02b 후속) |
| 운영 DB를 Transaction pooler(6543)로 전환 | Supabase Pool Size·리전을 운영에서 확인해야 한다. 코드는 설정으로 전환 가능하게만 만든다(P-03b 후속) |
| 개발 의존성 **메이저** 업그레이드(vitest 5, tailwindcss 4 등) | 설정·테스트 코드 이관이 필요한 breaking change다. 이번에는 같은 메이저 안의 패치·마이너만 반영하고 나머지는 S-08b 후속으로 둔다(§6.6.4) |
| 가입 응답 409 계약 변경 | 02 설계의 의도된 UX다(S-06) |
| 만료 세션·사진 정리 Cron | 운영 스케줄 설정이 필요하고, 로컬 검증 데이터 보존 원칙과 충돌한다(P-17) |
| 기존 사진 일괄 재인코딩(backfill) | 기존 데이터를 바꾸지 않는다. 다운스케일은 **새 업로드에만** 적용한다 |

---

## 2. 현재 코드 근거 (HEAD `52bac3f` 재확인)

| ID | 리포트 근거 | 재확인 결과 |
| --- | --- | --- |
| S-01 | `api/auth.py:27,54`, `services/auth.py:44,75,77` | **맞음.** 시도 제한이 없다. 추가로 등록 이메일 로그인은 `get_by_email`(services/auth.py:68)로 연 트랜잭션을 `verify_password`(:77) 동안 유지한다. 미등록 이메일만 :74에서 rollback한다 |
| S-02 | `lib/safeNextPath.ts:5-7`, `LoginForm.tsx:45,87` | **맞음.** `startsWith('/') && !startsWith('//')`만 검사한다. 사용처는 `LoginForm.tsx`의 `resolveSafeNextPath(searchParams?.get('next'))` 한 곳이다 |
| S-03/P-04 | `api/request_photos.py:45-52` | **맞음.** :45 `active_upload_count`가 트랜잭션을 연 뒤 :52 `_read_limited`, :54 `normalize_image`까지 끝내지 않는다. :50 `db.rollback()`은 이벤트루프에서 동기 호출된다 |
| S-04 | `docker-compose.yml:6-11` | **맞음.** 추가 발견: 실행 중 컨테이너의 compose project는 `gamja-market`(작업 디렉터리 `/Users/hjkim/gamja-market`)이고 데이터 볼륨은 `gamja-market_postgres_data`다. compose 파일에 `name:`이 없어서 **worktree 디렉터리에서 `docker compose up`을 실행하면 프로젝트명이 디렉터리명으로 바뀌어 빈 볼륨을 새로 만든다**(그리고 `container_name` 충돌이 난다). 설계에 프로젝트명 고정을 포함한다 |
| S-05 | `next.config.ts:21-35` | **맞음.** `headers()`가 없다. `vercel.json`에도 헤더 설정이 없다 |
| S-06 | `services/auth.py:39-41` | 사실이지만 02 설계의 의도된 계약이다 → 미적용 |
| S-07 | `core/config.py:22` | **맞음.** `Field(default=604800, gt=0)`, 상한이 없다 |
| S-08 | `frontend/package.json` | **맞음.** `npm audit --package-lock-only` 재실행(2026-10-09) 결과 총 16건(critical 2·high 11·moderate 3), `--omit=dev` 3건(high: `next`·`sharp`·`source-map-js`)이다. 업로드 이미지가 `sharp`까지 가는 앱 경로는 없다(`RequestCard.tsx`는 `<img>`를 쓴다). 그래도 사람 검토(H8 반려)에 따라 이번 PR에 포함한다(§6.6) |
| P-01 | `api/request_photos.py:89-106` | **맞음.** `photo_file`은 sync 엔드포인트다. :90 select로 시작한 트랜잭션이 :101 `storage.read` 동안 열려 있다 |
| P-02 | `api/request_photos.py:106`, `services/requests.py:174-187` | **맞음.** `Cache-Control: public, max-age=3600`만 있고 CDN 지시자가 없다. 07 §1.2는 “서버 측 리사이즈 안 함, 원본 해상도 유지”로 결정했다. 이번에 이 결정을 갱신한다(§14 H3) |
| P-03 | `db/session.py:11` | **맞음.** `NullPool` + `pool_pre_ping=True`. 운영은 Session pooler(5432)다(04 배포 절차 2) |
| P-05 | `repositories/chat_rooms.py:86`, `models.py:136-137` | **맞음.** `buyer_id` 단독 인덱스가 없다 |
| P-06 | `api/requests.py:37`, `repositories/requests.py:78-95` | **맞음.** `page`는 `ge=1`만 있다(`schemas/requests.py:68`도 같다). `sort=price`용 인덱스가 없다 |
| P-07 | `services/photo_validation.py:47-63,75-95` | **맞음.** 다운스케일과 동시성 상한이 없고 PNG는 `optimize=True`다 |
| P-08 | `core/security.py:14` | **맞음.** 동시 실행 상한이 없다 |
| P-09 | `storage/supabase.py:25,36,52` | **맞음.** 호출마다 `with httpx.Client(...)`를 새로 만든다 |
| P-10 | `ChatMessagePanel.tsx:15,142` | 맞다. 09 X1에서 비용을 인정한 설계다 → 후속 |
| P-11 | `repositories/requests.py:79`, `services/requests.py:189-191` | **맞음.** `User.email`을 조회한 뒤 `for request, _, applicant_count in rows`에서 버린다 |
| P-12 | `repositories/requests.py:69-71` | 맞다. 현재 규모에서는 0.6ms이고 확장(`pg_trgm`)이 필요하다 → 후속 |
| P-13 | `services/chat.py:96-124` | 맞다. 정확성에 민감한 경로이고 이득이 작다 → 후속 |
| P-14 | `AuthProvider.tsx:98-111` | **맞음.** `focus`와 `visibilitychange`가 같은 `handleRevalidate`를 호출하고, 세대 가드는 응답만 버린다 |
| P-15 | `app/chats/[roomId]/page.tsx`, `app/requests/[id]/page.tsx` | **근거 부족.** 두 호출 모두 `lib/api/http.ts`의 전역 `fetch` GET(같은 URL·같은 init)이다. Next 15 App Router는 `generateMetadata`와 page를 같은 렌더 패스에서 요청 메모이제이션으로 합친다(`cache: 'no-store'`는 Data Cache 설정이고 메모이제이션과는 별개다). 리포트도 “가능성”으로만 적었다 → 미적용 |
| P-16 | `models.py:97-99`, migration 0004:50-53 | **맞음.** `PurchaseRequestPhoto.__table_args__`에는 schema만 있다 |
| P-17 | `api/deps.py:88-94` | 맞다 → 후속 |
| P-18 | `PhotoPicker.tsx:166-208` | 맞다. UX 변경이다 → 후속 |

추가 확인 사항:

- 기존 테스트 클라이언트는 모두 같은 원격 주소(`testclient`)로 요청한다. 테스트 스위트 전체에서 가입·로그인을 수십 회 하므로, 레이트리밋을 기본 활성으로 두면 기존 테스트가 429로 깨진다. conftest에서 기본 비활성으로 두고, 레이트리밋 테스트에서만 설정을 덮어쓴다(§11.1).
- `tests/conftest.py:65-75` `_explicit_migration_target`은 `0005_chat_matching`까지만 안다. 새 revision을 추가하려면 tester가 이 함수를 갱신해야 한다.
- 이미 attached된 사진이 다른 상태로 바뀌는 코드 경로는 없다. 구매요청 삭제 API(PATCH/DELETE 미구현, `test_patch_and_delete_are_not_implemented`)와 회원 탈퇴 API도 없다. 따라서 사진 URL(`/api/request-photos/files/{id}.{ext}`)의 내용은 바뀌지 않는다. 이것이 P-02 CDN 캐시를 안전하게 둘 수 있는 근거다.

---

## 3. 범위 결정 표

분류: **포함** = 이번 PR · **후속** = 별도 PR(이유 명시) · **미적용** = 근거와 함께 적용하지 않음.

| ID | 심각도 | 분류 | 결정 사유 | 설계 |
| --- | --- | --- | --- | --- |
| S-01 | High | **포함** | 공개 경로에서 실제로 악용할 수 있다. 인스턴스 사이에서 공유되는 DB 기반 카운터로 막는다 | §5.1 |
| S-02 | Medium | **포함** | 한 파일의 순수 함수만 고치면 된다 | §6.1 |
| S-03 | Medium | **포함**(P-04와 통합) | 1~2줄 수정으로 연결 점유를 없앤다 | §5.3 |
| S-04 | Medium·가능성 | **포함** | 포트를 루프백에 묶고 비밀번호를 env로 주입한다. 프로젝트명을 고정해 기존 볼륨을 보존한다 | §5.12 |
| S-05 | Low·가능성 | **포함** | `next.config.ts` 헤더 설정만 추가한다 | §6.2 |
| S-06 | Low | **미적용** | 02 설계의 의도된 409 계약이다. S-01의 가입 IP 제한으로 열거 속도를 제한한다. 계약을 바꾸려면 가입 UX 재설계가 필요하다 | — |
| S-07 | Low·가능성 | **포함** | 설정 검증 한 줄이다 | §5.11 |
| S-08 | Low·조건부 | **포함**(운영 의존성) + 후속(dev 메이저) | 도달 경로는 확인되지 않았지만 H8 검토 결과 이번 PR에 포함한다. `next`·`eslint-config-next`를 15.5 라인 최신 패치(15.5.27)로, `sharp` override를 0.35.5로 올리고 잠금 파일을 다시 만든다. 같은 메이저 안에서 해결되지 않는 dev 경보(vitest/tinypool, tailwindcss/braces 계열)는 S-08b 후속으로 분리한다 | §6.6 |
| P-01 | High | **포함** | 사진 프록시가 커넥션을 오래 점유하는 문제를 1~2줄로 없앤다 | §5.2 |
| P-02 | High | **포함(최소안)** + 후속 | CDN 캐시 지시자와 업로드 다운스케일(P-07과 공유)만 넣는다. 썸네일 변형 객체 파이프라인은 저장 구조와 비용 검토가 필요해 후속(P-02b)으로 분리한다 | §5.4 |
| P-03 | Medium | **포함(설정화)** + 후속 | 풀 모드를 env로 고를 수 있게 만든다. 기본값은 현재 동작(NullPool)이다. 운영 pooler 전환은 Supabase Pool Size 확인 뒤 후속(P-03b)으로 한다 | §5.5 |
| P-04 | Medium | **포함**(S-03과 통합) | — | §5.3 |
| P-05 | Medium | **포함** | additive 인덱스 1개다 | §5.6 |
| P-06 | Medium | **포함(최소안)** + 후속 | `page ≤ 500`, `sort=price` 인덱스, `sort=applicants` 집계 조인을 넣는다. 지원자 수 비정규화 컬럼과 `total` 근사값은 쓰기 경로와 응답 의미가 바뀌므로 후속(P-06b) | §5.7 |
| P-07 | Medium | **포함** | 다운스케일(장변 1600px), 동시 처리 상한 2, PNG `optimize` 제거 | §5.4 |
| P-08 | Medium | **포함** | Argon2 동시 실행 상한과 대기 시간 제한을 둔다. 로그인 검증 전에 트랜잭션도 끝낸다 | §5.1.6 |
| P-09 | Low | **포함** | 프로세스 수준에서 클라이언트를 재사용한다. P-01 점유 시간도 줄어든다 | §5.8 |
| P-10 | Low | **후속** | 09 X1에서 인정한 비용이다. 백오프는 채팅 UX(수신 지연) 결정이 필요하다 | — |
| P-11 | Low | **포함** | 쓰지 않는 조인을 제거한다. 응답 계약은 바뀌지 않는다 | §5.7 |
| P-12 | Low | **후속** | `pg_trgm` 확장 설치와 최소 검색어 길이 정책을 운영에서 확인해야 한다. 현재 규모 0.6ms | — |
| P-13 | Low | **후속** | 메시지 전송의 멱등·seq 정확성 경로를 바꾸는 데 비해 이득이 작다 | — |
| P-14 | Low | **포함** | 프론트 throttle 한 곳만 고친다 | §6.3 |
| P-15 | Low·가능성 | **미적용** | §2. Next 요청 메모이제이션 대상이고 실제로 중복된다는 근거가 없다. 필요하면 후속에서 uvicorn access log로 실측한다 | — |
| P-16 | Low | **포함** | P-05·P-06에서 인덱스를 추가하므로 같이 맞춘다. 드리프트 가드 테스트를 추가한다 | §5.9 |
| P-17 | Low | **후속** | Vercel Cron과 삭제 정책을 운영에서 결정해야 한다. 이번 `auth_rate_limits` 정리도 같은 잡에 합친다 | — |
| P-18 | Low | **후속** | 클라이언트 리사이즈는 UX 변경이다. 서버 다운스케일이 서버 비용을 먼저 줄인다 | — |

---

## 4. 핵심 설계 결정

| # | 결정 | 근거 |
| --- | --- | --- |
| D1 | 레이트리밋 저장소는 **기존 PostgreSQL 테이블**(`app_private.auth_rate_limits`)을 쓰고, 원자적 UPSERT 고정 윈도 카운터로 구현한다 | Vercel Fluid Compute는 인스턴스가 여러 개이고 수명도 보장되지 않는다. 인메모리 카운터는 인스턴스마다 따로 세므로 제한값이 인스턴스 수만큼 늘어나 무력해진다. Redis 같은 새 인프라는 Marketplace 프로비저닝과 비밀 관리가 추가로 필요하다. 로그인·가입은 어차피 DB를 쓰므로 IP 확인 후 이메일 소비가 필요한 로그인은 최대 두 번의 UPSERT를 추가한다. 로그인 경로 트래픽은 작아서 행 경합도 문제가 되지 않는다 |
| D2 | 카운트는 **시도 기준**(성공·실패 모두)으로, **Argon2를 실행하기 전**에 소비한다 | 실패만 세려면 해시 검증이 끝난 뒤에야 셀 수 있다. 그러면 Argon2 비용을 막을 수 없다(S-01 회귀 기준: “제한된 요청에서 Argon2 미실행”) |
| D3 | 축은 **IP와 정규화 이메일 두 가지**다(로그인). 가입은 IP 축만 쓴다 | IP 축은 스터핑을 막고, 이메일 축은 IP를 돌려 가며 한 계정을 노리는 공격을 막는다. 가입 중복 이메일은 Argon2 전에 409로 끝나므로 이메일 축이 필요 없다 |
| D4 | 저장 키는 `sha256("{action}:{axis}:{value}")` 16진 문자열이다. IP·이메일 원문은 저장하지 않는다 | 개인정보를 최소화한다. 키가 고정 길이가 된다 |
| D5 | 클라이언트 IP는 `TRUST_PROXY_IP_HEADERS=true`일 때만 `x-forwarded-for` 첫 값(없으면 `x-real-ip`)을 쓴다. 아니면 `request.client.host`를 쓴다. IPv6는 /64로 묶는다 | Vercel은 이 헤더를 덮어써서 위조를 막는다. 신뢰 프록시가 없는 환경에서 헤더를 믿으면 우회된다. IPv6 /64 하나에는 주소가 사실상 무한하다 |
| D6 | 레이트리밋 저장소 장애는 **fail-closed 503**으로 처리한다 | 로그인·가입도 같은 DB가 필요하므로 열어 두어도 성공할 수 없다. 우회 경로도 생기지 않는다 |
| D7 | 업로드·사진 GET에서 DB 연결 해제는 `Session.close()`로 한다 | `close()`는 객체를 expire하지 않고 detach한다. 그래서 `user.id`, `photo.storage_path`를 다시 조회하지 않는다. SQLAlchemy 2.0 세션은 close 뒤에도 재사용할 수 있으므로 `upload_normalized`가 같은 `db`로 새 트랜잭션을 연다. `rollback()`은 객체를 expire시켜 lazy 재조회로 커넥션을 다시 연다 |
| D8 | 사진 응답 캐시: 브라우저 `public, max-age=86400, immutable`, Vercel CDN `Vercel-CDN-Cache-Control: max-age=604800` | URL은 `photo_id` 기반이고 attached 사진은 바뀌지 않는다(§2). 삭제 기능이 없어서 CDN TTL의 노출 기간 문제도 지금은 생기지 않는다. 삭제 기능이 생기면 TTL과 purge 절차를 다시 정한다(§14 H4) |
| D9 | 다운스케일은 **새 업로드에만** 적용하고 기존 객체는 건드리지 않는다 | 기존 데이터 보존 원칙 |
| D10 | 마이그레이션은 0004·0005와 같은 **`IF NOT EXISTS` 멱등 additive raw SQL**로 작성하고, `CONCURRENTLY`는 쓰지 않는다 | 현재 규모(로컬 수천 행)에서는 짧은 잠금으로 충분하다. `CONCURRENTLY`는 `autocommit_block`이 필요하고, 실패하면 INVALID 인덱스가 남아 기존 패턴과 어긋난다. 운영 행 수가 크게 늘었다면 적용 전에 확인한다(§14 H6) |

---

## 5. 백엔드 설계

### 5.1 S-01 인증 레이트리밋

#### 5.1.1 정책 (설정 기본값)

| action | 축 | 한도 | 윈도 | 설정 키 |
| --- | --- | --- | --- | --- |
| `login` | IP | 30회 | 600초 | `AUTH_LOGIN_IP_LIMIT`, `AUTH_LOGIN_WINDOW_SECONDS` |
| `login` | email | 10회 | 600초 | `AUTH_LOGIN_EMAIL_LIMIT`, (윈도 공유) |
| `signup` | IP | 10회 | 3600초 | `AUTH_SIGNUP_IP_LIMIT`, `AUTH_SIGNUP_WINDOW_SECONDS` |

- 모든 한도·윈도는 `Field(ge=1)`이고 윈도는 `le=86400`이다. `AUTH_RATE_LIMIT_ENABLED: bool = True`(기본 활성).
- 이메일 축 때문에 공격자가 피해자 계정의 로그인을 최대 10분 막을 수 있다. 감사 권고(“IP/계정 두 축 함께”)에 따라 이 트레이드오프를 받아들이고, 영구 잠금은 두지 않는다(§14 H1).

#### 5.1.2 저장소 — `app_private.auth_rate_limits`

```sql
CREATE TABLE IF NOT EXISTS app_private.auth_rate_limits (
  bucket_key varchar(64) NOT NULL PRIMARY KEY,      -- sha256 hex (D4)
  window_started_at timestamptz NOT NULL,
  hit_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_auth_rate_limits_hit_count CHECK (hit_count >= 1)
);
CREATE INDEX IF NOT EXISTS ix_auth_rate_limits_updated_at ON app_private.auth_rate_limits (updated_at);
```

- 행 수는 서로 다른 IP 수와 **IP 한도 안에서 허용된 로그인 시도의 정규화 이메일 수**만큼 늘어난다. IP 한도를 넘긴 요청은 이메일 버킷을 소비하지 않아 새 이메일 행을 만들지 않는다. 윈도가 지난 행은 다음 히트 때 그 자리에서 재사용된다. 오래된 행 정리는 P-17 후속 잡에 맡긴다(`updated_at` 인덱스는 그 잡에서 쓴다).
- SQLAlchemy 모델 `AuthRateLimit`(`app/db/models.py`)도 같은 컬럼·제약·인덱스로 선언한다(P-16 드리프트 방지).

#### 5.1.3 원자적 소비 SQL (`app/repositories/rate_limits.py` 신규)

```sql
INSERT INTO app_private.auth_rate_limits AS r (bucket_key, window_started_at, hit_count, updated_at)
VALUES (:bucket_key, :now, 1, :now)
ON CONFLICT (bucket_key) DO UPDATE SET
  hit_count = CASE WHEN r.window_started_at <= :now - make_interval(secs => :window) THEN 1 ELSE r.hit_count + 1 END,
  window_started_at = CASE WHEN r.window_started_at <= :now - make_interval(secs => :window) THEN :now ELSE r.window_started_at END,
  updated_at = :now
RETURNING bucket_key, hit_count, window_started_at
```

로그인은 먼저 IP 키 한 행을 UPSERT하고 결과를 확인한다. IP 한도 이내일 때만 이메일 키 한 행을 같은 트랜잭션에서 UPSERT한다. 가입은 IP 키 한 행만 소비한다.

- `:now`는 DB `now()`가 아니라 Python `app.core.security.utcnow()`로 넘긴다. 테스트에서 `monkeypatch`로 시간을 옮길 수 있게 하기 위해서다.
- 한 요청의 버킷은 **IP → 이메일 잠금 순서**로 하나의 트랜잭션에서 소비하고 서비스가 `commit()`을 한 번 호출한다. IP가 이미 한도를 넘으면 IP 카운터만 커밋하고 429를 반환하며 이메일 버킷은 읽거나 쓰지 않는다. 따라서 8개 동시 요청의 IP 카운트는 8, 이메일 카운트는 `min(IP 한도, 8)`이고, 거부된 새 이메일은 행을 만들지 않는다. IP와 이메일 행 모두 잠그는 경로는 항상 IP를 먼저 잡아 교착 계층 역전을 막는다. 어느 저장 단계든 실패하면 전체 트랜잭션을 rollback하고 503을 반환한다. 커밋한 뒤에야 사용자 조회와 Argon2로 넘어간다. 그래서 해시 계산 중에는 레이트리밋 트랜잭션이 열려 있지 않다.
- 한도를 넘긴 요청도 카운트는 올라간다. 고정 윈도라서 윈도 시작 시각은 늘어나지 않는다.

#### 5.1.4 서비스 (`app/services/rate_limit.py` 신규)

```python
class RateLimited(Exception):
    def __init__(self, retry_after: int) -> None: ...

def enforce_auth_rate_limit(db, *, action: Literal["login", "signup"], client_ip: str, email: str | None, settings) -> None:
    """Consume buckets before any password hashing. Raises RateLimited or ServiceUnavailable."""
```

- `settings.auth_rate_limit_enabled`가 False면 즉시 반환한다(DB 접근 없음).
- `retry_after = ceil(window_started_at + window - now)`. 1 이상이며 넘긴 버킷 중 최댓값을 쓴다.
- UPSERT나 단일 `commit()`에서 저장소 오류가 나면 `db.rollback()` → `log_database_failure("rate_limit", ...)` → `ServiceUnavailable`(D6). 로그인은 두 버킷을 한 연결에서 소비하므로 버킷마다 새 연결을 만들지 않는다.

#### 5.1.5 API (`app/api/auth.py`, `app/api/deps.py`, `app/api/errors.py`)

- `deps.py`에 `client_ip(request, settings) -> str`를 추가한다(D5). IPv4는 그대로, IPv6는 `ipaddress.ip_network(f"{ip}/64", strict=False)` 문자열로 바꾼다. 파싱에 실패하거나 값이 없으면 `request.client.host`, 그것도 없으면 `"unknown"`을 쓴다.
- 처리 순서(기존 순서 보존):
  - signup: `require_auth_post_request`(403/415) → 본문 검증(422) → `PASSWORD_MISMATCH`(422, “DB·해시 이전” 계약 유지) → **레이트리밋(429)** → `signup()`
  - login: `require_auth_post_request` → 본문 검증 → **레이트리밋(429)** → `login()`
- `/me`, `/logout`에는 적용하지 않는다.
- `ApiError`에 `headers: dict[str, str] | None = None` 인자를 추가해 `HTTPException(headers=...)`로 넘긴다. `error_from_exception`은 `exc.headers`를 `JSONResponse` 헤더로 복사한다. `main.py`의 `api_error_handler`는 그대로 `_api_no_store`를 적용한다.
- `ERROR_MESSAGES["RATE_LIMITED"] = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요."`

응답 계약:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 412
Cache-Control: no-store
Content-Type: application/json

{"error": {"code": "RATE_LIMITED", "message": "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", "fields": {}}}
```

- 등록·미등록 이메일 모두 같은 시점에 같은 본문으로 429를 받는다(열거 방지). 본문에 이메일·IP·남은 횟수를 넣지 않는다.
- `Set-Cookie`를 내보내지 않고 기존 세션 쿠키도 건드리지 않는다.

#### 5.1.6 P-08 Argon2 동시성 상한 + 로그인 트랜잭션 정리

- `app/core/security.py`:
  - `PASSWORD_HASH_CONCURRENCY = 2`, `PASSWORD_HASH_WAIT_SECONDS = 10.0`(모듈 상수), `_hash_slots = threading.BoundedSemaphore(PASSWORD_HASH_CONCURRENCY)`
  - `class PasswordHashBusy(Exception)`
  - `hash_password`, `verify_password`, `verify_dummy_password`는 모두 `_hash_slots.acquire(timeout=PASSWORD_HASH_WAIT_SECONDS)`를 얻은 뒤 실행하고 `finally`에서 release한다. 획득에 실패하면 `PasswordHashBusy`를 던진다.
  - 모듈 import 시점의 `_DUMMY_PASSWORD_HASH` 생성은 세마포어 밖에서 그대로 둔다.
  - 해시 파라미터(64MiB·t=3·p=4)는 바꾸지 않는다.
- 대기 시간을 제한하는 이유: sync 엔드포인트는 anyio 스레드풀(기본 40)을 공유한다. 무한 대기하면 해시를 기다리는 스레드가 스레드풀을 다 차지해서 채팅·목록 요청까지 멈춘다.
- `app/services/auth.py`:
  - `signup`: `hash_password`에서 난 `PasswordHashBusy`를 `ServiceUnavailable`로 바꾼다(현재는 `SQLAlchemyError`만 잡아서 500이 된다).
  - `login`: 사용자를 찾았으면 `password_hash = user.password_hash`를 지역 변수에 담고, `db.expunge(user)`, `db.rollback()`을 차례로 실행한 다음 `verify_password(password, password_hash)`를 호출한다. 이렇게 하면 Argon2를 계산하는 동안 트랜잭션이 열려 있지 않다. expunge한 객체는 expire되지 않아서 `user.id`, `user.email`을 그대로 쓸 수 있다. 세션 INSERT는 새 트랜잭션에서 한다. `verify_dummy_password`와 `verify_password`의 `PasswordHashBusy`도 `ServiceUnavailable`로 바꾼다.
- API는 기존 `ServiceUnavailable` 처리 그대로 503 `SERVICE_UNAVAILABLE`을 반환한다. 새 오류 code는 없다.

### 5.2 P-01 사진 파일 프록시 연결 해제 (`app/api/request_photos.py` `photo_file`)

```python
storage_path, content_type = photo.storage_path, photo.content_type
db.close()                      # D7: 외부 스토리지 호출 전에 커넥션 반환
data = storage.read(storage_path)
```

- 404·503 규칙과 `X-Content-Type-Options: nosniff`는 그대로 둔다. 캐시 헤더는 §5.4.1에 따른다.

### 5.3 S-03/P-04 업로드 중 연결 해제 (`app/api/request_photos.py` `upload_photo`)

1. `uploader_id = user.id`를 먼저 지역 변수에 담는다.
2. `active_upload_count` 사전 검사를 하고, 정상이든 예외든 **그 직후** `await run_in_threadpool(db.close)`를 호출한다. 예외 경로의 기존 `db.rollback()`(:50)도 `await run_in_threadpool(db.rollback)`으로 바꾼다.
3. `_read_limited`와 `normalize_image`는 연결 없이 진행한다.
4. `upload_normalized(db, uploader_id=uploader_id, ...)` → `reserve_upload`가 같은 세션으로 새 트랜잭션을 열고, 사용자 행 잠금 아래에서 한도를 다시 검사한다(07 계약 유지).

- 순서 계약은 바뀌지 않는다: 401 → 503(스토리지 없음) → 415 → 413(헤더) → 409(사전 한도) → 413/422(본문) → 409/503(예약).

### 5.4 P-02 최소안 + P-07 이미지 처리 상한

#### 5.4.1 사진 응답 캐시 (D8)

`photo_file`의 200 응답 헤더:

| 헤더 | 값 |
| --- | --- |
| `Cache-Control` | `public, max-age=86400, immutable` |
| `Vercel-CDN-Cache-Control` | `max-age=604800` |
| `X-Content-Type-Options` | `nosniff` (기존) |

- 200이 아닌 응답은 기존 미들웨어(`main.py:39-40`)가 계속 `no-store`로 덮어쓴다.
- 응답은 쿠키·세션과 무관하다(`photo_file`에는 인증 의존성이 없다). 그래서 공유 캐시에 넣어도 사용자 간 누출이 없다.
- 운영 확인: 배포 뒤 같은 사진 URL을 두 번 요청해서 두 번째 응답의 `x-vercel-cache: HIT`를 확인한다(§13).

#### 5.4.2 업로드 다운스케일 (`app/services/photo_validation.py`)

- 상수 `MAX_EDGE = 1600`을 추가한다.
- 처리 순서: 기존 1~6단계(서명·포맷·**디코딩 전 20MP 검사**·애니메이션 거부·`load`·`exif_transpose`)를 그대로 한 뒤 `if max(image.size) > MAX_EDGE: image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)`를 적용하고, PNG RGBA 변환·메타데이터 제거·인코딩으로 넘어간다.
- 응답과 DB의 `width`·`height`는 다운스케일한 결과 값이다(07 “정규화 결과 기준” 계약과 일치).
- 장변 1600 이하 이미지는 크기가 그대로다.
- PNG 인코딩 옵션은 `{"optimize": True}`에서 `{"compress_level": 6}`으로 바꾼다.
- (선택) JPEG는 `source.draft("RGB", (MAX_EDGE, MAX_EDGE))`로 디코딩 비용을 줄일 수 있다. 다만 결과 크기가 `MAX_EDGE` 이상이라는 것만 보장되므로 `thumbnail`은 그대로 적용한다. 테스트가 결과를 고정하므로 구현자가 선택한다.

#### 5.4.3 동시 처리 상한

- 모듈 수준 `_normalize_slots = threading.BoundedSemaphore(2)`(상수 `NORMALIZE_CONCURRENCY = 2`). `normalize_image` 본문 전체(디코딩~인코딩)를 감싼다. 크기·서명 검사(디코딩 전 검사)는 세마포어 밖에서 먼저 실행해서 잘못된 입력이 슬롯을 차지하지 않게 한다.
- `IMAGE_NORMALIZE_WAIT_SECONDS` 설정(기본 10초)만큼 슬롯 획득을 기다린다. 시간 안에 획득하지 못하면 `ImageNormalizationBusy`를 발생시키고 API는 기존 오류 계약의 503 `SERVICE_UNAVAILABLE`을 반환한다. 슬롯을 획득한 경우에만 `finally`에서 반환하므로 timeout 경로에서 슬롯 누수가 없다. 제한 시간은 이미지 요청이 AnyIO 공용 스레드풀을 무기한 점유하지 않게 한다.

### 5.5 P-03 커넥션 풀 설정화 (`app/db/session.py`, `app/core/config.py`)

| 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `DATABASE_POOL_MODE` | `null` | `null` = `NullPool`(현재 동작), `queue` = `QueuePool` |
| `DATABASE_POOL_SIZE` | 2 | `queue`일 때만 사용. `ge=1, le=10` |
| `DATABASE_MAX_OVERFLOW` | 2 | `ge=0, le=10` |
| `DATABASE_POOL_RECYCLE_SECONDS` | 300 | `ge=30` |
| `DATABASE_POOL_TIMEOUT_SECONDS` | 5 | `ge=1, le=30` |
| `DATABASE_DISABLE_PREPARED_STATEMENTS` | false | true면 `connect_args={"prepare_threshold": None}`(Transaction pooler용) |

- `create_session_factory(database_url=None, settings=None)`: `null` 모드에서는 `pool_pre_ping`을 빼고(효과 없음), `queue` 모드에서는 `pool_pre_ping=True`로 만든다.
- 운영 전환(P-03b, 후속): 안 A는 `queue` 모드(총 연결 = 인스턴스 수 × (size+overflow)이므로 Session pooler Pool Size 안에 들어가야 한다)다. 안 B는 Transaction pooler(6543) + `null` + prepared statement 비활성이다. 코드는 트랜잭션 로컬 `set_config(..., true)`와 행 잠금만 쓰므로 둘 다 가능하다. 결정은 운영 수치를 확인한 뒤 한다.

### 5.6 P-05 채팅 inbox 인덱스

- `CREATE INDEX IF NOT EXISTS ix_seller_applications_buyer_id ON app_private.seller_applications (buyer_id)`
- `models.py` `SellerApplication.__table_args__`에 `Index("ix_seller_applications_buyer_id", "buyer_id")`를 추가한다.
- 쿼리 코드는 바뀌지 않는다. `buyer_id OR seller_id` 조건이 BitmapOr로 처리된다.

### 5.7 P-06 목록 비용 상한 + P-11 조인 제거

| 변경 | 위치 | 내용 |
| --- | --- | --- |
| page 상한 | `api/requests.py:37`, `schemas/requests.py:68` | `MAX_LIST_PAGE = 500`, `Query(ge=1, le=500)`과 `Field(ge=1, le=500)`. 넘으면 기존 계약대로 422 `VALIDATION_ERROR`, `fields.page = "입력값을 확인해 주세요."` |
| price 정렬 인덱스 | migration 0006, `models.py` `PurchaseRequest` | `ix_purchase_requests_price_created_id (price_max DESC, created_at DESC, id DESC)` |
| applicants 정렬 | `repositories/requests.py` `list_and_count` | `sort == "applicants"`일 때만 상관 서브쿼리 대신 `SELECT request_id, count(*) AS applicant_count FROM seller_applications GROUP BY request_id` 서브쿼리를 **LEFT OUTER JOIN**하고 `coalesce(applicant_count, 0)`으로 정렬·반환한다. 행마다 SubPlan을 도는 대신 집계를 한 번만 한다. 기본·price 정렬은 기존 상관 서브쿼리를 유지한다(LIMIT 덕분에 페이지 행에서만 평가된다) |
| 조인 제거(P-11) | `repositories/requests.py:79`, `services/requests.py:163-191` | `select(PurchaseRequest, applicant_count)`, `join(User)` 제거. 반환 타입은 `list[tuple[PurchaseRequest, int]]`. 서비스 언패킹은 `for request, applicant_count in rows`. `get_by_id`(상세의 마스킹 이메일)는 바꾸지 않는다 |

- 응답 스키마, 정렬 결과, tie-break(`created_at DESC, id DESC`)는 그대로다. `total` 계산도 그대로다(근사값은 P-06b 후속).

### 5.8 P-09 Supabase httpx 클라이언트 재사용 (`app/storage/supabase.py`)

- 모듈 수준 `_shared_client: httpx.Client | None`과 `threading.Lock`을 둔다. `_client()`는 transport가 없으면 공유 클라이언트를 lazy로 만든다. 설정은 `timeout=httpx.Timeout(10.0, connect=3.0)`, `limits=httpx.Limits(max_connections=20, max_keepalive_connections=10)`이다.
- transport를 주입한 경우(테스트)에는 **인스턴스마다 클라이언트를 한 번만** 만들어 재사용한다. 기존 `transport=` 생성자 계약을 유지한다.
- `put`, `read`, `delete_many`는 `with httpx.Client(...)` 대신 `self._client()`를 쓴다. 예외 정제(`StorageError`, 404 → `FileNotFoundError`)는 그대로다.
- `httpx.Client`는 여러 스레드에서 공유해도 된다. 앱 종료 시 close는 하지 않아도 된다(프로세스와 수명이 같다).

### 5.9 P-16 모델·마이그레이션 인덱스 동기화 (`app/db/models.py`)

`PurchaseRequestPhoto.__table_args__`에 0004의 인덱스를 그대로 선언한다(DDL 변경 없음).

```python
Index("ix_request_photos_request_id", "request_id", postgresql_where=text("status = 'attached'")),
Index("ix_request_photos_uploader_status", "uploader_id", "status", "created_at"),
Index("ix_request_photos_cleanup", "storage_backend", "storage_bucket", "status", "created_at",
      postgresql_where=text("object_deleted_at IS NULL")),
Index("uq_request_photos_request_sort", "request_id", "sort_order", unique=True,
      postgresql_where=text("status = 'attached'")),
{"schema": "app_private"},
```

- 0006에서 추가하는 인덱스 3개(§5.1.2, §5.6, §5.7)도 models에 선언한다.
- CHECK 제약은 autogenerate 비교 대상이 아니므로 이번 범위에서 제외한다.

### 5.10 마이그레이션 `0006_security_perf_hardening`

- 파일: `backend/migrations/versions/0006_security_perf_hardening.py`, `revision = "0006_security_perf_hardening"`(28자, `VARCHAR(32)` 이내), `down_revision = "0005_chat_matching"`.
- upgrade: 0005와 같은 형식으로 `statements` 리스트를 `op.execute(sa.text(...))`로 실행한다.
  1. §5.1.2의 `CREATE TABLE IF NOT EXISTS app_private.auth_rate_limits …`
  2. `CREATE INDEX IF NOT EXISTS ix_auth_rate_limits_updated_at …`
  3. `CREATE INDEX IF NOT EXISTS ix_seller_applications_buyer_id ON app_private.seller_applications (buyer_id)`
  4. `CREATE INDEX IF NOT EXISTS ix_purchase_requests_price_created_id ON app_private.purchase_requests (price_max DESC, created_at DESC, id DESC)`
- 기존 행을 UPDATE·DELETE하지 않는다. 같은 DB에 두 번 실행해도 안전하다.
- downgrade: 인덱스 3개 `DROP INDEX IF EXISTS`, `DROP TABLE IF EXISTS app_private.auth_rate_limits`. 기존 패턴과 같으며 로컬·운영에서 실행하지 않는다.
- 적용 경로: 로컬은 tester의 conftest fixture가 명시 target으로 upgrade한다(§11.1). 운영은 04 배포 절차 3(`MIGRATION_DATABASE_URL`로 `alembic upgrade head`, 런타임 시작과 분리)을 따른다.

새 설정 요약(`app/core/config.py`, `backend/.env.example`에 주석과 함께 추가):

| 설정 | 기본 | 비고 |
| --- | --- | --- |
| `AUTH_RATE_LIMIT_ENABLED` | `true` | conftest는 `false`로 둔다 |
| `AUTH_LOGIN_IP_LIMIT` / `AUTH_LOGIN_EMAIL_LIMIT` / `AUTH_LOGIN_WINDOW_SECONDS` | 30 / 10 / 600 | |
| `AUTH_SIGNUP_IP_LIMIT` / `AUTH_SIGNUP_WINDOW_SECONDS` | 10 / 3600 | |
| `IMAGE_NORMALIZE_WAIT_SECONDS` | `10` | 이미지 정규화 슬롯 최대 대기 시간(초), 0 초과 30 이하 |
| `TRUST_PROXY_IP_HEADERS` | `false` | **Vercel Production/Preview에서는 `true`로 설정**(§13) |
| `DATABASE_POOL_*`, `DATABASE_DISABLE_PREPARED_STATEMENTS` | §5.5 | |
| `SESSION_TTL_SECONDS` | 604800 | 상한 2,592,000(§5.11) |

### 5.11 S-07 세션 TTL 상한

- `session_ttl_seconds: int = Field(default=604800, gt=0, le=2_592_000)`(30일). 넘으면 설정 로딩(앱 시작)이 `ValidationError`로 실패한다. `hide_input_in_errors=True`는 유지한다.

### 5.12 S-04 개발 DB 노출 축소 (`docker-compose.yml`, 루트 `.gitignore`, 루트 `.env.example`)

```yaml
name: gamja-market            # 프로젝트명 고정 → 볼륨 gamja-market_postgres_data를 계속 사용
services:
  postgres:
    image: postgres:16-alpine
    container_name: gamja-market-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: gamja_market
      POSTGRES_USER: gamja
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?루트 .env에 POSTGRES_PASSWORD를 설정하세요}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data   # 볼륨 키 변경 금지
    # healthcheck 그대로
volumes:
  postgres_data:
```

- 루트 `.gitignore`에 `.env`를 추가한다. 루트 `.env.example`에 `POSTGRES_PASSWORD=`(빈 값)와 설명을 추가한다.
- **데이터 보존 규칙**:
  - `POSTGRES_PASSWORD`는 빈 볼륨을 처음 초기화(initdb)할 때만 쓰인다. 기존 볼륨에서는 값을 바꿔도 DB 비밀번호가 바뀌지 않는다. 그러므로 기존 개발자는 루트 `.env`에 **현재 쓰는 값**을 넣으면 접속 정보(`backend/.env`의 `DATABASE_URL`)를 바꿀 필요가 없다.
  - 비밀번호 교체는 선택적 수동 절차다: `ALTER ROLE gamja PASSWORD '…'` 실행 → `backend/.env` 갱신 → 루트 `.env` 갱신. 이 문서와 구현 작업에서는 실행하지 않는다.
  - 포트 바인딩 변경을 반영하려면 컨테이너를 다시 만들어야 한다(`docker compose up -d`). 명명 볼륨은 유지된다. `docker compose down -v`, 볼륨 삭제·이름 변경은 금지한다. 재생성은 merge 뒤 사람이 메인 체크아웃에서 한다. 구현·테스트 단계에서는 `docker compose config` 정적 검증만 한다.
- 문서 갱신: `backend/README.md`의 로컬 DB 기동 절차에 루트 `.env` 준비 단계를 추가한다.

---

## 6. 프론트엔드 설계

### 6.1 S-02 `resolveSafeNextPath` (`frontend/src/lib/safeNextPath.ts`)

```ts
const PARSE_BASE = 'http://gamja.invalid';
export function resolveSafeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  if (next.includes('\\') || /[\u0000-\u001F\u007F]/.test(next)) return '/';
  let url: URL;
  try { url = new URL(next, PARSE_BASE); } catch { return '/'; }
  if (url.origin !== PARSE_BASE) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
```

- 시그니처와 사용처(`LoginForm.tsx`)는 그대로다. 역슬래시와 제어 문자(탭·개행 포함, URL 파서가 지워서 `//`가 되는 경우)를 거절하고, 파싱한 결과의 origin이 기준과 같은지 확인한 뒤 경로를 다시 조립한다.

### 6.2 S-05 프레임 삽입 방지 (`frontend/next.config.ts`)

```ts
async headers() {
  return [{ source: '/:path*', headers: [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    { key: 'X-Frame-Options', value: 'DENY' },
  ] }];
},
```

- 기존 `rewrites()`와 `reactStrictMode`는 유지한다. Vercel에서 `/api/*`는 backend 서비스로 직접 가므로 이 헤더는 프론트 페이지에만 붙는다. JSON·사진 응답은 프레임 삽입 대상이 아니라서 문제없다.
- 다른 CSP 지시자(script-src 등)는 이번 범위가 아니다. 넣으면 인라인 스크립트 회귀 위험이 있다.

### 6.3 P-14 `/me` 재검증 throttle (`frontend/src/features/auth/AuthProvider.tsx`)

- `REVALIDATE_THROTTLE_MS = 2000`, `lastRevalidateAtRef = useRef(0)`.
- `handleRevalidate`: 기존 hidden 검사 다음에 `Date.now() - lastRevalidateAtRef.current < REVALIDATE_THROTTLE_MS`이면 무시하고, 아니면 시각을 기록한 뒤 `restore()`를 호출한다.
- 최초 마운트 복원과 `refresh()`(사용자 재시도)는 throttle 대상이 아니다. 두 이벤트 리스너는 그대로 둔다(focus만 바뀌는 다중 창 경우도 유지).

### 6.4 `RATE_LIMITED` 처리 (`frontend/src/types/api.ts`, `frontend/src/lib/api/http.ts`)

- `ApiErrorCode` 유니언과 `KNOWN_ERROR_CODES`에 `'RATE_LIMITED'`를 추가한다. `fallbackCode(429)`가 `'RATE_LIMITED'`를 돌려주게 한다.
- `LoginForm`·`SignupForm`은 이미 알 수 없는 code를 `else` 분기에서 `setFormError(caught.message)`로 표시한다. 따라서 서버 메시지가 폼 상단에 나오고, 비밀번호 입력은 기존 규칙대로 지워진다. 컴포넌트 수정 없이 테스트로 이 동작을 고정한다.
- `Retry-After` 값은 표시하지 않는다(서버 메시지 하나로 충분하다).

### 6.5 목록 page 상한 (`frontend/src/app/page.tsx`, `frontend/src/lib/api/requests.ts`)

- `export const MAX_LIST_PAGE = 500`, `export function resolveListPage(raw: string | undefined): number`를 둔다. 정수가 아니거나 1 미만이면 1, 500을 넘으면 500을 돌려준다.
- `page.tsx:26-34`의 인라인 계산을 이 함수로 바꾼다. URL `?page=9999`가 백엔드 422로 오류 화면이 되지 않게 하기 위해서다.

---

### 6.6 S-08 의존성 보안 패치 (`frontend/package.json`, `frontend/package-lock.json`)

#### 6.6.1 현재 상태 (2026-10-09, `npm audit --package-lock-only` · `npm view` 확인)

| 범위 | 건수 | 패키지 |
| --- | --- | --- |
| 운영(`--omit=dev`) | high 3 | `next@15.5.24`(SSG/ISR 캐시 오염 GHSA-4jqv-mc3x-m676·GHSA-mcj8-r9mp-w47p, 영향 범위 `15.5.24–15.5.26` 포함), `sharp@0.35.0`(libheif·librsvg, 영향 `<=0.35.5-rc.1`), `source-map-js@1.2.1`(영향 `1.0.0–1.2.1`, `postcss@8.5.26` override 경유) |
| 전체 | critical 2 · high 11 · moderate 3 | 위 3건 + dev 전용 13건(§6.6.4) |

레지스트리 확인 결과:

- `next` 15.5 라인 최신 패치는 **15.5.27**(2026-09-30 공개)이다. `eslint-config-next`도 15.5.27까지 있다. 15.5.27의 `optionalDependencies.sharp`는 `^0.34.3 || ^0.35.4`라서 0.35.5와 호환된다. `react@19.1.0` peer 범위도 만족한다.
- `sharp` 최신은 **0.35.5**(2026-09-27 공개, rc가 아닌 정식)다. engines `node >=20.9.0`이다.
- `source-map-js` 최신은 1.2.2다. `postcss@8.5.26`의 의존 범위 `^1.2.1` 안에 있으므로 잠금 파일만 다시 만들면 올라간다.

#### 6.6.2 변경

```jsonc
// frontend/package.json (변경 키만)
"dependencies":    { "next": "15.5.27" },              // 15.5.24 → 15.5.27, 정확 버전 고정 유지
"devDependencies": { "eslint-config-next": "15.5.27" }, // next와 같은 버전으로 맞춤
"overrides":       { "postcss": "8.5.26", "sharp": "0.35.5" }  // sharp 0.35.0 → 0.35.5(≥0.35.5), postcss 유지
```

- 기존 방식(정확 버전 + `overrides` 고정)을 그대로 따른다. `sharp`는 `>=0.35.5` 조건을 만족하는 정확 버전 `0.35.5`로 고정해 빌드를 재현 가능하게 한다.
- `react`, `react-dom`, `postcss`, 그 밖의 dev 의존성의 **package.json 선언 범위는 바꾸지 않는다**. 메이저·마이너 라인 변경(`next` 15.6/16, `react` 19.2 등)은 금지한다.

#### 6.6.3 절차

1. `cd frontend && npm view next@15.5 version`으로 15.5 라인 최신 패치를 다시 확인한다. 작업 시점에 15.5.27보다 새 패치가 있으면 `next`와 `eslint-config-next`를 **같은 최신 15.5.x**로 맞춘다. 15.5 밖의 버전은 쓰지 않는다.
2. §6.6.2대로 `package.json`을 수정한다.
3. `npm install`로 `package-lock.json`을 다시 만든다. 선언 범위 안에서 `source-map-js@1.2.2`, `brace-expansion@1.1.21`·`5.0.12`가 해결되는지 `npm ls source-map-js brace-expansion sharp next`로 확인한다. 범위 안인데도 남아 있으면 **`--force` 없는** `npm audit fix`를 한 번 실행한다. 실행 뒤 `git diff package.json`에 §6.6.2 밖의 변경이 없어야 한다.
4. **금지**: `npm audit fix --force`, `overrides`로 메이저가 다른 버전 강제(예: `tinypool@2`, `postcss-selector-parser@7`), `package-lock.json` 삭제 후 무제한 재해결(`rm -rf node_modules package-lock.json`). 잠금 파일은 기존 파일을 바탕으로 갱신한다.
5. `npm audit --omit=dev --package-lock-only`, `npm audit --package-lock-only` 결과를 `docs/verification/10-dependency-audit.md`(frontend 소유, 신규)에 요약한다. 건수, 남은 항목, 사유를 적는다.
6. `npm run lint`, `npm test`, `npm run build`를 실행한다.

#### 6.6.4 남는 dev 전용 경보 → S-08b 후속

같은 메이저 안에서 해결할 수 없어서 이번 PR에서는 받아들이는 항목이다. 모두 `devDependencies` 트리이며 `npm run build` 산출물과 런타임에 들어가지 않는다.

| 패키지(심각도) | 원인 | 해결에 필요한 변경 | 분류 |
| --- | --- | --- | --- |
| `vitest`(critical), `tinypool`(critical), `@vitest/mocker`(moderate) | vitest 3.x 최신(3.2.7)도 `tinypool ^1.1.1`을 쓰고, 영향 범위가 `tinypool <=2.1.1`, `vitest 0.0.95–4.1.10`이다 | vitest 5 메이저 | S-08b 후속 |
| `tailwindcss`(high), `braces`(high, 수정 버전 없음 `*`), `micromatch`·`chokidar`(high), `postcss-nested`·`postcss-selector-parser`(moderate) | tailwindcss 3.4.19(3.x 최신)가 `chokidar@3`·`fast-glob`·`postcss-nested@6`에 의존한다 | tailwindcss 4 메이저(설정 이관) | S-08b 후속 |
| `eslint-config-next`·`@next/eslint-plugin-next`·`fast-glob`(high) | `@next/eslint-plugin-next@15.5.27`도 `fast-glob@3.3.1` → `micromatch` → `braces`에 의존한다 | `braces` 수정판 공개 또는 Next 메이저 | S-08b 후속 |
| `brace-expansion`(high) | `minimatch` 범위 안의 1.1.21·5.0.12로 해결된다 | 잠금 파일 재생성 | **이번 PR에서 해결** |

- 위 dev 경보는 개발 머신에서 신뢰할 수 있는 입력(자체 소스·설정)만 처리하므로 실제 위험이 낮다. 그래도 S-08b에서 vitest 5와 tailwindcss 4 이관을 별도로 설계한다.

#### 6.6.5 수용 기준

- `npm audit --omit=dev --package-lock-only`: **high 이상 0건**(기대 결과: 0건). 0건이 아니면 남은 항목·영향 범위·같은 메이저 안에서 해결할 수 없는 사유를 `docs/verification/10-dependency-audit.md`에 적고 코디네이터에게 escalation한다.
- `npm audit --package-lock-only`: 남은 항목이 §6.6.4의 S-08b 목록의 부분집합이다(새 항목 없음). `brace-expansion`, `source-map-js`, `next`, `sharp`는 목록에 없어야 한다.
- `npm ls next eslint-config-next sharp --package-lock-only`: `next@15.5.27`(또는 절차 1의 최신 15.5.x), `eslint-config-next`가 같은 버전, `sharp@0.35.5 overridden`.
- `git diff frontend/package.json`: §6.6.2의 세 키만 바뀌었다.
- `npm run lint`(warning 0), `npm test`, `npm run build`가 통과한다. 빌드 출력의 라우트 목록이 변경 전과 같다(`/`, `/login`, `/signup`, `/requests/*`, `/chats/*`).

## 7. API 계약 변경 요약

| 엔드포인트 | 변경 |
| --- | --- |
| `POST /api/auth/login` | 429 `RATE_LIMITED` + `Retry-After` 추가. Argon2 대기 시간 초과 시 503 `SERVICE_UNAVAILABLE`(기존 code) |
| `POST /api/auth/signup` | 429 `RATE_LIMITED` + `Retry-After` 추가. 503 사유 추가(기존 code) |
| `GET /api/requests` | `page > 500` → 422 `VALIDATION_ERROR` `fields.page` |
| `POST /api/request-photos` | 응답 `width`·`height`가 다운스케일 결과(장변 ≤ 1600) |
| `GET /api/request-photos/files/{id}.{ext}` | 200 `Cache-Control: public, max-age=86400, immutable`, `Vercel-CDN-Cache-Control: max-age=604800` |
| 프론트 모든 페이지 | `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY` |

그 밖의 경로, 응답 본문 스키마, 오류 code, 상태 코드는 바뀌지 않는다.

---

## 8. 오류·엣지 동작

| 상황 | 기대 |
| --- | --- |
| 로그인 IP 30회 초과(윈도 내) | 31번째부터 429. `verify_password`/`verify_dummy_password` 호출 0회 |
| 이메일 축 10회 초과, 다른 IP | 11번째부터 429(IP를 바꿔도 막힘) |
| 다른 이메일·다른 IP 사용자 | 영향 없음(200/401) |
| 윈도 경과 | 첫 요청에서 카운트 1로 초기화, 통과 |
| 등록·미등록 이메일 | 같은 시점에 같은 429 본문 |
| 비밀번호 불일치 가입 | 422 `PASSWORD_MISMATCH`, 레이트리밋 카운트 증가 없음 |
| 레이트리밋 DB 오류 | 503 `SERVICE_UNAVAILABLE`, 해시 미실행 |
| Argon2 슬롯 10초 대기 초과 | 503 `SERVICE_UNAVAILABLE` |
| `TRUST_PROXY_IP_HEADERS=false`인데 `X-Forwarded-For` 위조 | 무시. `request.client.host` 기준 |
| IPv6 같은 /64의 다른 주소 | 같은 버킷 |
| 사진 GET 중 Supabase 지연 | DB 연결 반환 상태로 대기(트랜잭션 없음) |
| 느린 업로드 본문 | 사전 검사 뒤 DB 연결 반환 상태로 대기 |
| 4000×3000 JPEG 업로드 | 1600×1200 저장, 응답 width/height 일치 |
| `?page=501` 직접 API 호출 | 422. 프론트 URL은 500으로 보정 |
| `/login?next=/%5Cevil.example` | 로그인 성공 뒤 `/` |

---

## 9. 호환성 — 보존하는 기존 계약

- 오류 본문 형식 `{"error":{"code","message","fields"}}`, 인증·요청 경로의 `Cache-Control: no-store`, 사진 GET 비200 응답의 `no-store`.
- 가입 409 `EMAIL_ALREADY_EXISTS`(S-06 미적용), `PASSWORD_MISMATCH`가 DB·해시보다 먼저 실행되는 순서.
- 업로드 오류 순서와 사용자당 활성 업로드 10장, 사용자 행 잠금 재검사(07).
- 목록 응답 필드, 정렬 tie-break, `pageSize ≤ 50`, 상세의 마스킹 이메일.
- 07 결정 중 “원본 해상도 유지”는 이번에 **장변 1600px 다운스케일로 갱신**한다(§14 H3). 포맷 보존, 메타데이터 제거, 20MP 사전 검사는 그대로다.
- 기존 사진 객체·DB 행, 로컬 DB 데이터, docker 볼륨은 변경·삭제하지 않는다.

---

## 10. 작업 분담 경계

| 소유자 | 파일 | 항목 |
| --- | --- | --- |
| **backend** | `backend/app/api/auth.py`, `api/deps.py`, `api/errors.py`, `api/request_photos.py`, `api/requests.py` | S-01, S-03/P-04, P-01, P-02 헤더, P-06 page |
| | `backend/app/services/rate_limit.py`(신규), `services/auth.py`, `services/photo_validation.py`, `services/requests.py` | S-01, P-08, P-07, P-11 |
| | `backend/app/repositories/rate_limits.py`(신규), `repositories/requests.py` | S-01, P-06, P-11 |
| | `backend/app/core/config.py`, `core/security.py`, `db/session.py`, `db/models.py`, `storage/supabase.py`, `schemas/requests.py` | S-07, P-08, P-03, P-05/P-16, P-09, P-06 |
| | `backend/migrations/versions/0006_security_perf_hardening.py`(신규) | §5.10 |
| | `docker-compose.yml`, 루트 `.gitignore`, 루트 `.env.example`(신규), `backend/.env.example`, `backend/README.md` | S-04, 설정 문서 |
| **frontend** | `frontend/src/lib/safeNextPath.ts`, `next.config.ts`, `src/features/auth/AuthProvider.tsx`, `src/types/api.ts`, `src/lib/api/http.ts`, `src/lib/api/requests.ts`, `src/app/page.tsx` | S-02, S-05, P-14, RATE_LIMITED, page 상한 |
| | `frontend/package.json`, `frontend/package-lock.json` | S-08(§6.6). 잠금 파일은 frontend만 다시 만든다 |
| | `docs/verification/10-dependency-audit.md`(신규) | S-08 audit 결과 기록(§6.6.3-5) |
| **tester** | `backend/tests/conftest.py`, `backend/tests/test_*.py`(§11), `frontend/tests/*.test.ts(x)`(§11) | RED 테스트, 의도된 기존 테스트 변경(§11.4) |

- 경계 규칙: backend는 `frontend/`를, frontend는 `backend/`·루트 인프라 파일을 수정하지 않는다. 계약(오류 code 문자열 `RATE_LIMITED`, 429, `page ≤ 500`)은 이 문서를 따른다. 막히면 orchestration으로 상대 워커에게 묻는다.
- backend와 frontend는 병렬로 작업할 수 있다. 서로 의존하는 런타임 변경이 없다(프론트는 429를 받지 못해도 기존 동작이 유지된다).

---

## 11. 테스트 계획 (RED)

### 11.1 conftest 변경 (tester)

- `os.environ.setdefault("AUTH_RATE_LIMIT_ENABLED", "false")`를 기존 `AUTH_ALLOWED_ORIGINS` 설정 옆에 추가한다. 기존 스위트가 IP `testclient` 하나를 공유하므로 반드시 필요하다.
- `_explicit_migration_target`: `"0006_security_perf_hardening" in known`이면 그것을 가장 먼저 반환한다. 나머지 가드와 `head` 금지는 유지한다.
- 레이트리밋 테스트용 fixture `rate_limited_settings(test_ns)`: `get_settings()`를 복사해서 `auth_rate_limit_enabled=True`, `trust_proxy_ip_headers=True`, 작은 한도(예: 로그인 IP 3, 이메일 2, 가입 IP 2)를 적용한 뒤 `app.dependency_overrides[get_settings]`로 주입하고 teardown에서 복원한다. 버킷 충돌을 피하려고 IP는 테스트마다 `test_ns`에서 만든 문서용 대역 주소(예: `198.18.x.y`, `2001:db8:…`)를 `X-Forwarded-For`로 보낸다.
- 금지 사항은 09 §13.3과 같다. `auth_rate_limits`를 포함한 모든 테이블에 DELETE/TRUNCATE/DROP을 하지 않는다. 테스트 버킷 행은 로컬 DB에 그대로 남긴다(키가 해시라서 원문이 없다).

### 11.2 백엔드 — pytest

**`backend/tests/test_auth_rate_limit.py` (신규)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| RL1 | `test_login_ip_limit_returns_429_with_retry_after` | 같은 IP·서로 다른 이메일로 한도까지는 401, 다음 요청은 429. 본문 `error.code == "RATE_LIMITED"`, `fields == {}`, 메시지 일치, `Retry-After`는 1 이상 윈도 이하의 정수, `Cache-Control: no-store`, `Set-Cookie` 없음 |
| RL2 | `test_login_email_limit_applies_across_ips` | 같은 이메일·서로 다른 IP로 한도를 넘기면 429 |
| RL3 | `test_limited_login_never_runs_argon2` | `app.services.auth.verify_password`/`verify_dummy_password`를 카운터로 monkeypatch. 429 요청에서 호출 증가 0 |
| RL4 | `test_registered_and_unknown_email_limited_identically` | 등록 이메일과 미등록 이메일 각각 한도 초과 시 상태·본문이 같다(`Retry-After` 제외) |
| RL5 | `test_other_user_and_window_expiry_pass` | 한도 초과 뒤 다른 IP+다른 이메일은 통과(401/200). `app.core.security.utcnow`(서비스가 참조하는 이름)를 윈도+1초 뒤로 monkeypatch하면 원래 IP도 통과 |
| RL6 | `test_signup_ip_limit_and_mismatch_not_counted` | `PASSWORD_MISMATCH` 422는 카운트하지 않는다. 가입 한도 초과 시 429이고 `hash_password` 미호출. 성공한 가입은 201 + 쿠키 |
| RL7 | `test_forwarded_for_ignored_without_trust` | `trust_proxy_ip_headers=False` 설정에서 `X-Forwarded-For`를 바꿔도 같은 버킷 → 한도에서 429 |
| RL8 | `test_ipv6_same_slash64_shares_bucket` | `2001:db8:…::1`과 `…::2`(같은 /64)가 같은 버킷을 쓴다 |
| RL9 | `test_rate_limit_store_failure_is_503_without_hashing` | 리포지토리 소비 함수가 `SQLAlchemyError`를 던지게 monkeypatch → 503 `SERVICE_UNAVAILABLE`, 해시 미호출, 응답에 DB URL·SQL 없음 |
| RL10 | `test_rate_limit_disabled_skips_store` | 비활성 설정에서 소비 함수 호출 0 |
| RL11 | `test_bucket_keys_are_hashed` | 테스트 이메일로 소비한 뒤 `auth_rate_limits`를 **읽기만** 해서 `bucket_key`가 64자 16진이고, 이메일·IP 원문이 어떤 컬럼에도 없음을 확인. 대상은 테스트가 계산한 키로 한정 |
| RL12 | `test_concurrent_consumption_is_atomic` | 같은 키를 스레드 8개에서 동시에 소비 → 반환된 `hit_count` 집합이 {1..8} |

**`backend/tests/test_password_hash_limits.py` (신규, P-08)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| H1 | `test_hash_concurrency_never_exceeds_limit` | `password_hasher.verify`/`hash`를 sleep 스텁으로 바꾸고 동시 진입 수를 기록. 스레드 6개로 `verify_password`를 호출하면 최대 동시 진입이 `PASSWORD_HASH_CONCURRENCY`(2) 이하 |
| H2 | `test_hash_slot_timeout_maps_to_503` | 세마포어를 모두 점유하고 대기 시간을 0.05초로 monkeypatch. 로그인과 가입 모두 503 `SERVICE_UNAVAILABLE`(500 아님) |
| H3 | `test_login_releases_transaction_before_verify` | `get_db`를 override해 세션을 캡처하고, `verify_password` 스텁 안에서 `session.in_transaction() is False`를 확인. 이어 로그인 200, `user.email` 응답 정상 |

**`backend/tests/test_photo_connection_release.py` (신규, S-03/P-04, P-01)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| C1 | `test_photo_file_releases_db_before_storage_read` | 기존 `photo_storage` fake와 attached 사진을 준비하고 `get_db` override로 세션을 캡처. fake `read` 안에서 `not session.in_transaction()`. 응답 200 바이트 일치 |
| C2 | `test_upload_releases_db_before_body_and_normalize` | `app.api.request_photos.normalize_image`를 래핑해서 실제 정규화 전에 `not session.in_transaction()`을 확인. 201 응답 계약(07 P1 필드) 유지 |
| C3 | `test_upload_precheck_failure_still_503_and_limit_409` | 사전 검사 예외 → 503. 활성 10장 → 409 `PHOTO_LIMIT_EXCEEDED`. 동시 한도 테스트(`test_same_user_concurrent_upload_limit_is_serialized`)는 그대로 통과 |

**`backend/tests/test_request_photos.py` / `test_private_photo_delivery.py` 추가·변경 (P-02, P-07)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| I1 | `test_normalize_downscales_long_edge` | 4000×3000 JPEG → 출력 1600×1200. 3000×4000 PNG → 1200×1600. WEBP도 같은 규칙. 포맷 유지, 메타데이터 없음 |
| I2 | `test_normalize_keeps_small_images_and_exif_rotation` | 1200×800은 크기 그대로. EXIF orientation 6인 4000×3000 JPEG → 1200×1600(회전 뒤 다운스케일), EXIF 없음 |
| I3 | `test_normalize_concurrency_is_bounded` | 내부 디코딩 단계를 sleep 스텁으로 계측. 스레드 4개 동시 호출 시 최대 동시 2 |
| I4 | `test_normalize_rejects_before_acquiring_slot` | 슬롯을 모두 점유한 상태에서 서명 불일치 입력은 즉시 `InvalidImage`(대기 없음) |
| I5 | `test_upload_response_reports_downscaled_dimensions` | 4000×3000 업로드 → 201 `width=1600,height=1200`, DB 행·저장 바이트 크기 일치 |
| I6 | `test_photo_file_cache_headers` | 200: `cache-control == "public, max-age=86400, immutable"`, `vercel-cdn-cache-control == "max-age=604800"`, nosniff. 404·503: `no-store`, CDN 헤더 없음 |

**`backend/tests/test_requests.py` 추가 (P-06, P-11)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| Q1 | `test_list_requests_page_upper_bound` | `page=500` 200, `page=501` 422 `VALIDATION_ERROR` `fields.page` |
| Q2 | `test_list_applicants_sort_matches_counts` | 테스트 요청 3건(지원 2/1/0)을 `q=test_ns`, `sort=applicants`로 조회하면 순서·`applicantCount`가 일치하고, 동률은 `created_at DESC, id DESC` |
| Q3 | `test_list_query_has_no_users_join` | SQLAlchemy `before_cursor_execute` 리스너로 목록 요청의 SQL을 캡처. 목록 SELECT에 `app_private.users`가 없음(세션 조회 SQL 제외 — `purchase_requests`를 포함하는 문장만 검사) |
| Q4 | `test_list_price_and_inbox_use_indexes` | `rollback_connection`에서 `SET LOCAL enable_seqscan = off` 후 `EXPLAIN`: price 정렬 1페이지 SQL에 `ix_purchase_requests_price_created_id`, inbox SQL(`buyer_id = :id OR seller_id = :id`)에 `ix_seller_applications_buyer_id`가 나타남. 읽기 전용 |

**`backend/tests/test_security_perf_settings.py` (신규, S-07, P-03, P-09, S-04)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| T1 | `test_session_ttl_upper_bound` | `SESSION_TTL_SECONDS=2592001` → `ValidationError`, 오류 문자열에 입력값 없음. 2592000·기본 604800 허용 |
| T2 | `test_session_factory_pool_modes` | 기본: `isinstance(engine.pool, NullPool)`. `queue`: `QueuePool`, size 2, overflow 2, recycle 300, timeout 5, `pre_ping` True. `DATABASE_DISABLE_PREPARED_STATEMENTS=true`: dialect connect args에 `prepare_threshold=None`(엔진만 만들고 연결하지 않는다) |
| T3 | `test_supabase_client_is_reused` | `httpx.Client`를 카운팅 래퍼(내부 `MockTransport`)로 monkeypatch. transport 없이 `SupabasePhotoStorage` 두 인스턴스로 `put`/`read`/`delete_many` 호출 → 생성 1회. transport를 주입한 인스턴스는 인스턴스당 1회. 기존 `test_photo_storage_adapters.py` 계약 통과 |
| T4 | `test_dev_compose_binds_loopback_and_preserves_volume` | 루트 `docker-compose.yml` 텍스트 검사: `name: gamja-market`, `"127.0.0.1:5432:5432"`, `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD`, `!test123` 문자열 없음, 볼륨 키 `postgres_data` 유지. 루트 `.gitignore`에 `.env` 줄, 루트 `.env.example`에 `POSTGRES_PASSWORD=` |

**`backend/tests/test_migration_0006.py` (신규, §5.10, P-16)**

| # | 테스트 | 수용 기준 |
| --- | --- | --- |
| M1 | `test_0006_revision_chain_and_offline_sql` | `revision`/`down_revision` 값, offline SQL에 `IF NOT EXISTS` 테이블 1·인덱스 3. `DELETE`/`UPDATE`/`TRUNCATE`/`alembic_version` 쓰기 없음 |
| M2 | `test_0006_objects_exist_after_upgrade` | `pg_indexes`, `to_regclass`로 테이블·인덱스 존재와 정의 확인(읽기 전용) |
| M3 | `test_models_and_db_have_no_index_drift` | `alembic.autogenerate.compare_metadata(MigrationContext.configure(conn, opts={"include_schemas": True}), Base.metadata)` 결과 중 `add_index`/`remove_index` 연산이 `app_private`의 모든 테이블에서 0개 |
| M4 | `test_auth_rate_limits_check_constraint` | `rollback_connection`에서 `hit_count=0` INSERT → `ck_auth_rate_limits_hit_count` 위반 |

### 11.3 프론트엔드 — vitest (`frontend/tests`, 기존 `describe/it` 한국어 서술 패턴)

| # | 파일 | 테스트 | 수용 기준 |
| --- | --- | --- | --- |
| F1 | `safeNextPath.test.ts`(신규) | 우회 입력 거부 | `/\evil.example`, `decodeURIComponent('/%5Cevil.example')`, `//evil.example`, `/\t/evil.example`, `/%0a/evil`의 디코딩 값, `javascript:alert(1)`, `https://evil.example`, `''`, `null` → `'/'` |
| F2 | 〃 | 정상 경로 보존 | `/chats/123?tab=x#m` 그대로, `/requests/new` 그대로, `/a/../b` → `/b`(정규화 결과가 같은 origin이면 허용) |
| F3 | `LoginForm.test.tsx` | 역슬래시 next | `useSearchParams` mock `next=/\evil.example`로 로그인에 성공하면 `router.replace('/')` |
| F4 | 〃 | 429 표시 | `login`이 `ApiError({code:'RATE_LIMITED', status:429, message:'요청이 너무 많아요. 잠시 후 다시 시도해 주세요.'})`를 던지면 폼 상단에 그 메시지, 비밀번호 비움, 이메일 유지, `router.replace` 미호출 |
| F5 | `SignupForm.test.tsx` | 429 표시 | 같은 기준(두 비밀번호 비움) |
| F6 | `authApi.test.ts` | 429 매핑 | 429 + 계약 본문 → `code 'RATE_LIMITED'`, 서버 메시지. 본문이 깨진 429 → `fallbackCode` = `'RATE_LIMITED'` |
| F7 | `nextConfig.test.ts`(신규) | 보안 헤더 | `nextConfig.headers()` 결과에 `source: '/:path*'`, CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`. `rewrites()` 기존 동작(`BACKEND_API_ORIGIN` 유무, `VERCEL=1`) 유지 |
| F8 | `AuthProvider.test.tsx` | `/me` throttle | 마운트 복원 뒤 `focus`와 `visibilitychange`(visible)를 연달아 보내면 `authApi.me` 추가 호출 1회. fake timers로 2초 뒤 `focus` → 추가 1회. hidden 상태 이벤트 → 0회. `refresh()`는 throttle과 무관하게 호출 |
| F9 | `requestsApi.test.ts` | page 보정 | `resolveListPage`: `undefined`/`'abc'`/`'0'`/`'-3'` → 1, `'2.7'` → 2, `'501'`·`'99999'` → 500, `'500'` → 500 |

### 11.4 의도된 기존 테스트 변경 (tester가 함께 갱신)

| 파일 | 현재 | 변경 |
| --- | --- | --- |
| `backend/tests/test_private_photo_delivery.py:49` | `cache-control == "public, max-age=3600"` | `"public, max-age=86400, immutable"` + CDN 헤더(I6과 같은 기준) |
| `backend/tests/conftest.py` | target 0005까지, 레이트리밋 기본값 없음 | §11.1 |
| 목록 결과에 의존하는 테스트 | — | 변경 없음(응답 계약 동일). 실패하면 구현 회귀로 본다 |

### 11.5 GREEN 수용 기준

- `cd backend && uv run pytest` 전부 통과(기존 + 신규). `cd frontend && npm test`·`npm run lint`·`npm run build` 통과. 프론트 명령은 **S-08로 다시 만든 잠금 파일 기준**으로 실행한다(`npm ci` 뒤 실행).
- S-08: `npm audit --omit=dev --package-lock-only` high 이상 0건, 전체 audit의 남은 항목이 §6.6.4 S-08b 목록의 부분집합, `next`·`eslint-config-next` 15.5 라인 최신 패치, `sharp@0.35.5`(§6.6.5 전체 기준). 결과를 `docs/verification/10-dependency-audit.md`에 기록한다.
- 로컬 DB에서 `alembic_version = 0006_security_perf_hardening`. 기존 행 수가 줄지 않음(테스트 전후 `pg_stat_user_tables.n_live_tup` 비교, 읽기 전용).
- 테스트와 로그에 비밀번호·세션 원문·DB URL·IP/이메일 원문이 출력되지 않는다.

---

## 12. UI·수동 검증 (ui tester, 로컬 DB 보존)

1. 로그인 화면에서 틀린 비밀번호를 한도까지 입력 → 폼 상단에 “요청이 너무 많아요…”, 비밀번호 칸 비움. (로컬 `.env`에서 `AUTH_LOGIN_EMAIL_LIMIT`를 작게 둔 백엔드로 검증하고, 끝나면 원래 값으로 되돌린다)
2. `/login?next=/%5Cevil.example`로 로그인 → `/`로 이동, 외부 origin으로 가지 않음.
3. 홈 응답 헤더 `content-security-policy: frame-ancestors 'none'`, `x-frame-options: DENY`.
4. 큰 사진(장변 > 1600) 업로드 → 상세 화면에서 정상 표시, 응답 width/height ≤ 1600.
5. 사진 URL 응답 헤더 확인, 404 URL `no-store`.
6. 창 포커스를 바꿔도 네트워크 탭에서 `/api/auth/me`가 한 번만 호출됨.
7. `?page=9999` → 500페이지 보정 화면(빈 목록 안내), 오류 화면 아님.
8. (S-08 회귀) Next 15.5.27로 홈·상세(사진 갤러리)·로그인·가입·채팅 목록/방 화면을 렌더하고 브라우저 콘솔 오류가 없는지 확인한다. 사진은 `<img>`로 계속 표시된다.

---

## 13. 운영 반영 체크리스트 (merge 뒤 사람이 수행)

- [ ] Vercel backend Production·Preview 환경 변수 `TRUST_PROXY_IP_HEADERS=true`를 설정한다. Vercel이 `X-Forwarded-For`를 덮어쓰는 경로에 한해 신뢰한다. 설정하지 않으면 모든 요청이 플랫폼 내부 주소 하나로 묶여 IP 축 한도가 서비스 전체 한도가 된다. `ENV=production`인데 값이 false이면 앱은 기동을 막지 않고 경고 로그를 남긴다.
- [ ] 런타임이 사용하는 데이터베이스와 동일한 DB에 먼저 `alembic upgrade head`(04 절차 3)를 적용하고, 새 런타임 DB 역할에 `app_private.auth_rate_limits`의 `SELECT`, `INSERT`, `UPDATE` 권한이 있는지 확인한다. 별도 DDL 역할을 쓰는 경우 migration 적용을 런타임 배포보다 먼저 완료한다. 적용 전 `seller_applications`·`purchase_requests` 행 수를 확인한다(D10).
- [ ] 배포 뒤 사진 URL 두 번 요청 → `x-vercel-cache: HIT`. MISS가 계속되면 `Vercel-CDN-Cache-Control` 처리를 문서로 확인하고 P-02b에서 다시 검토한다.
- [ ] 배포 응답에 frame-ancestors 헤더 확인.
- [ ] 로컬 개발자: 루트 `.env`에 현재 `POSTGRES_PASSWORD`를 넣고 메인 체크아웃에서 `docker compose up -d`로 컨테이너 재생성(볼륨 유지). `docker ps`에서 `127.0.0.1:5432->5432/tcp` 확인.
- [ ] Supabase Pool Size·프로젝트 리전 확인 → P-03b 결정 입력.

---

## 14. 사람 검토 항목 (2026-10-09 결정 완료)

> 결정: H1~H7은 아래 권장 기본값대로 승인되었다. H8은 반려되어 S-08을 이번 PR에 포함한다.

| # | 질문 | 권장 기본값 |
| --- | --- | --- |
| H1 | 레이트리밋 한도와 이메일 축 잠금(최대 10분) 수용 여부 | 로그인 IP 30/10분, 이메일 10/10분, 가입 IP 10/60분. 영구 잠금 없음 |
| H2 | 저장소: DB 테이블 vs 외부 KV(Upstash 등) | DB 테이블(D1). 트래픽이 커지면 후속에서 KV로 옮긴다 |
| H3 | 07의 “원본 해상도 유지” 결정을 장변 1600px 다운스케일로 바꾸는 것 | 승인(새 업로드만, 기존 객체 유지) |
| H4 | 사진 캐시 TTL(브라우저 1일 immutable, CDN 7일) | 승인. 사진·요청 삭제 기능이 생기면 TTL과 purge 절차를 다시 정한다 |
| H5 | `page` 상한 500 | 승인 |
| H6 | 인덱스를 `CONCURRENTLY` 없이 생성 | 승인(현재 규모). 운영 행 수가 10만을 넘으면 별도 절차 |
| H7 | frame-ancestors `'none'`(같은 출처 iframe도 금지) | 승인. 앱에 자기 iframe이 없다 |
| H8 | S-08 의존성 패치를 별도 PR로 분리 | **반려 → 이번 PR에 포함**(§6.6). dev 의존성 메이저 업그레이드만 S-08b 후속 |

---

## 15. 구현 순서

1. **tester**: conftest(§11.1) → 백엔드 RED(§11.2) → 프론트 RED(§11.3) → 기존 테스트 변경(§11.4). RED 실패 사유가 “미구현”인지 확인한다.
2. **backend**(병렬): 0006 마이그레이션·모델(P-05/P-06/P-16, `AuthRateLimit`) → 설정(S-07, §5.10) → 레이트리밋(S-01) → Argon2 상한·로그인 트랜잭션(P-08) → 연결 해제(P-01, S-03/P-04) → 이미지(P-07, P-02 헤더) → 목록(P-06, P-11) → httpx(P-09) → 세션 팩토리(P-03) → compose·문서(S-04).
3. **frontend**(병렬): **의존성 패치(S-08, §6.6) — 먼저 실행해서 이후 테스트·빌드가 새 잠금 파일 기준으로 돌게 한다** → safeNextPath(S-02) → RATE_LIMITED 매핑 → next.config 헤더(S-05) → AuthProvider throttle(P-14) → page 보정.
4. secu_reviewer / perf_reviewer 재검토 → ui tester(§12).

---

## 16. 한계 (명시)

- DB 기반 고정 윈도는 윈도 경계에서 최대 2배 버스트를 허용한다. 분산 공격(수천 IP)은 이메일 축과 Argon2 상한으로 완화될 뿐 막지는 못한다. 근본 대책(Vercel Firewall rate limit, BotID)은 운영 설정 후속이다.
- Argon2 세마포어는 **인스턴스 단위**다. 인스턴스 수가 늘면 전체 동시 해시 수도 늘어난다. 인스턴스 메모리 보호가 목적이다.
- CDN 캐시 효과는 운영 확인 전까지 추정치다(§13).
- `auth_rate_limits` 행은 정리 잡(P-17)이 생기기 전까지 계속 쌓인다(키 수만큼, 행당 100바이트 안팎).
- S-08 이후에도 dev 전용 경보(vitest/tinypool critical, tailwindcss/braces 계열 high)가 남는다. 같은 메이저 안에서는 해결할 수 없다(§6.6.4, S-08b 후속).
