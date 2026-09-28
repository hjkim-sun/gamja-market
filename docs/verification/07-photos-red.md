# 07 구매요청 사진 — RED 테스트 인계

검증일: 2026-09-26
역할: tester worker
기준 문서: `docs/specs/07-purchase-request-photos.md`

## 결과 요약

- 기존 백엔드 인증/구매요청 회귀 61건은 공유 로컬 DB를 비우거나 되돌리지 않고 모두 통과한다.
- 사진 기능 RED는 백엔드에서 `16 failed, 12 errors`, 프런트 전체에서 `76 passed, 10 failed, 1 failed suite`로 확인했다. 실패는 새 라우트·정규화 서비스·스토리지 의존성·응답 필드·PhotoPicker·갤러리·안전 URL 파싱이 아직 없다는 계약 지점에 걸린다.
- 실제 Supabase는 호출하지 않았다. 백엔드는 실제 Pillow 생성 이미지와 실패 주입 가능한 메모리 저장소를 사용하고, 프런트는 `fetch`만 모의한다.

## 공유 DB 안전 전환

`backend/tests/conftest.py`에서 다음 파괴 동작을 제거했다.

- 세션 시작 시 `alembic upgrade head`
- 매 테스트 `TRUNCATE ... CASCADE`
- 사용자 삭제로 cascade를 확인하는 `DELETE FROM users`
- 공유 DB에서 수행하던 실제 Alembic downgrade/upgrade

대신 다음을 적용했다.

- 테스트마다 `run_tag`와 고유 이메일을 사용한다.
- 목록 단언은 제목에 `run_tag`를 넣고 `q=run_tag`로 범위를 제한한다.
- 변경 UPDATE는 테스트가 생성한 ID에만 수행한다.
- cascade는 `pg_constraint.confdeltype = 'c'` 카탈로그 단언으로 확인한다.
- downgrade는 offline SQL만 렌더링해 `purchase_requests` 외 테이블을 DROP하지 않는지 확인한다.
- `tests.support.schema.ensure_additive_schema(engine)`는 `users`, `auth_sessions`, `purchase_requests` 존재만 확인하고, 미래의 `0004_create_purchase_request_photos.py`가 있을 때 그 `upgrade()`만 Alembic version state 없이 호출한다. 0004가 없는 현재 RED 단계에서는 기존 회귀를 막지 않는다.

검증 중 생성된 사용자·세션·구매요청 행은 삭제하지 않고 공유 로컬 DB에 보존했다. 새 DB나 새 스키마를 만들지 않았고, `alembic_version`을 수정하지 않았다.

## 실행 결과

### 기존 백엔드 회귀 — GREEN

```text
cd backend
uv run python -m pytest tests/test_auth.py tests/test_requests.py -q
61 passed, 2 warnings in 4.62s
```

### 사진 백엔드 계약 — RED

```text
cd backend
uv run python -m pytest tests/test_request_photos.py -q
16 failed, 12 errors, 2 warnings in 3.38s
```

주요 RED 근거:

- 실제 JPEG/PNG/WebP 정규화 테스트: `app.services.photo_validation` 미구현
- 인증/동일 출처 순서 테스트: `POST /api/request-photos`가 현재 404
- fake storage 연동 테스트: `app.api.deps.get_photo_storage` 미구현
- 레거시 무사진 생성: 성공 응답에 `photos` 없음
- `photoIds` 형식 검증: 오류 `fields.photoIds` 없음
- additive schema: `0004_create_purchase_request_photos.py` 없음
- 소유권, 10장 동시 한도, 저장 실패 보상, 사진 순서 연결은 storage 의존성이 생기면 실행되는 테스트로 준비됨

### 프런트 전체 — 기존 76건 통과 + 기능 RED

```text
cd frontend
npm test -- --reporter=dot
Test Files 6 failed | 13 passed (19)
Tests 10 failed | 76 passed (86)
```

주요 RED 근거:

- `src/lib/api/requestPhotos.ts` 없음(해당 API 테스트 suite resolve 실패)
- RequestForm에 접근 가능한 파일 입력/PhotoPicker와 안내 문구 없음
- 업로드 중 제출 차단, 순차 업로드, abort/remove, `photoIds` payload 미구현
- RequestDetail에 사진 갤러리 없음
- RequestCard 이미지에 `loading="lazy"`, `decoding="async"` 없음
- 상세 응답 `photos` 기본값/검증과 이미지 URL 스킴 필터 없음
- 빈 `photoIds`를 JSON에서 생략하는 동작 없음

### 정적 검사

```text
cd backend && uv run python -m compileall -q tests
# exit 0

cd frontend && npm run lint
# exit 0, warnings 0
```

## 개발자용 내부 인터페이스 계약

백엔드 테스트가 기대하는 최소 인터페이스:

- `app.services.photo_validation.normalize_image(data: bytes, declared_content_type: str) -> NormalizedImage`
- `NormalizedImage`: `data`, `content_type`, `ext`, `width`, `height`
- `InvalidImage`, `ImageTooLarge` 예외
- `app.api.deps.get_photo_storage`: FastAPI override 가능한 dependency
- storage 객체: `namespace -> (backend, bucket)`, `put(path, data, content_type)`, `delete_many(paths) -> set[str]`
- 업로드 성공 응답은 `id/contentType/byteSize/width/height/expiresAt`만 포함하며 URL과 저장 경로를 포함하지 않음
- 연결 잠금 쿼리는 사진 ID 오름차순으로 잠그고, 응답/DB `sort_order`는 요청의 `photoIds` 순서를 보존함

테스트 fake는 `backend/tests/support/fake_storage.py`에 있다. `fail_put`, `fail_delete`, `put_raises_then_late_write`, `put_delay`, 호출 순서와 객체 내용을 제공한다.

프런트 테스트가 기대하는 최소 인터페이스:

- `uploadRequestPhoto(file, signal?)`, `deleteRequestPhoto(id)` in `src/lib/api/requestPhotos.ts`
- 파일 input은 `/사진 추가/` 접근 가능 이름을 가지며 `multiple` + 허용 MIME을 사용
- PhotoPicker 삭제 버튼은 `사진 n 삭제`, 갤러리 버튼은 `사진 n / 총` 이름을 사용
- `PurchaseRequestDetail.photos`는 누락 시 `[]`; 잘못된 구조는 `INTERNAL_ERROR`; 위험 URL은 노출하지 않음
- 빈 `photoIds`는 POST JSON에서 키 자체를 생략함

## 아직 추가하지 않은 확장 테스트

핵심 구현 인계를 빠르게 하기 위해 다음 exhaustive matrix는 후속 backend/front 또는 UI 검증에서 확장한다.

- DB commit 전/후 예외 및 재조회 실패의 모든 보상 분기
- sweeper dry-run/apply, 유예 재삭제, local 파일 라우트 전체
- 20MP 경계, 정확히 3MiB/3MiB+1 chunked 경계, 품질 85→75→65 재인코딩 주입
- 두 요청의 역순 사진 집합 deadlock 실경합 및 사진 attach update 오류 rollback
- Supabase `httpx.MockTransport` 어댑터: 현대 `sb_secret`은 `apikey`만, 레거시 JWT만 `Authorization: Bearer`; 정확한 버킷 제한 3,145,728바이트
- 설정 검증, offline 0004 downgrade SQL, 전체 CHECK 위반 행렬
- 구현 완료 뒤 3105/8105 local driver UI 시나리오 및 실제 Supabase 사람 주도 검증

## 의존성 메모

테스트에서 실제 이미지를 생성하기 위해 `Pillow>=11,<13`을 backend dev dependency에 추가했고 `uv.lock`을 갱신했다. 운영 코드가 Pillow를 직접 사용하게 되면 backend 구현 워커가 승인 명세대로 runtime dependency로 이동해야 한다.
