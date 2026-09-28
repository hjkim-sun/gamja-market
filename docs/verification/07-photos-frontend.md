# 07 구매요청 사진 — 프런트 구현 인계

검증일: 2026-09-26
역할: front worker
기준 문서: `docs/specs/07-purchase-request-photos.md`, `docs/verification/07-photos-red.md`

## 책임자 후속 검토

초기 완료 보고 이후 Sonnet/high 워커를 같은 터미널에서 재개(`ctx_829e9a1ae1e7`)해 StrictMode effect 복구, 선택 간 단일 업로드 큐, 늦은 응답 폐기, 제출 핸들러 가드와 사진 선택기 비활성화를 구현하고 회귀 테스트를 추가했다. 이후 실제 transcript에 `You've hit your session limit`가 확인되어 해당 dispatch를 abandon하고 터미널은 보존했다. 완료했다고 간주하지 않고 책임자가 남은 초기화 동결, 큐에서 제거된 파일 건너뛰기, URL 경로 검증과 ID 인코딩을 마무리했다.

책임자 재실행: **19 suites / 104 tests 통과**, `npm run lint`, `npm run build`, `npx tsc --noEmit` 모두 통과. 로컬 사진 URL fixture는 실제 API의 UUID 파일명 형태로 보정했고, 경로 순회·제어 문자·역슬래시 URL 거부 사례 6개를 추가했다. 사진 저장 중 초기화를 누르더라도 입력과 사진이 유지되고 폐기 API가 호출되지 않는 것도 확인했다. 아래 94개 결과는 최초 워커 인계 시점의 기록이다.

## 요약

- RED 인계 시점 프런트 실패(6 failed suites, 10 failed tests, 76 passed) 전부를 GREEN으로 전환했다.
- 1차 구현 검증 통과(19 suites / 94 tests) 후, 코디네이터 리뷰에서 지목된 5건의 필수 수정 사항을 반영하고 회귀 테스트 4건을 추가했다(아래 "리뷰 수정 사항" 절).
- 최종: `npm test -- --run` **19 suites / 98 tests 전부 통과**, `npm run lint` 경고 0, `npx tsc --noEmit` 오류 0, `npm run build` 성공.
- 백엔드(`backend/**`)는 건드리지 않았다. `frontend/src/**`와 `frontend/tests/**`(PhotoPicker/requestPhotosApi 하네스 결함 보정)만 수정했다.

## 구현 파일

신규:

- `frontend/src/lib/api/requestPhotos.ts` — `uploadRequestPhoto(file, signal?)`(raw body, `Content-Type: file.type`, `X-Requested-With: gamja-market`, `credentials: 'same-origin'`, `cache: 'no-store'`), `deleteRequestPhoto(id)`.
- `frontend/src/features/requests/components/PhotoPicker.tsx` — 파일 선택기. 클라이언트 사전검증(5장/3MiB/허용 MIME 3종) → 1장씩 순차 업로드 → 미리보기(`createObjectURL`/`revokeObjectURL`) → 제거(업로드 중이면 abort, 완료면 fire-and-forget delete) → 재시도. 부모에는 `{ uploadedIds, pendingCount, failedCount }`만 알린다.
- `frontend/src/features/requests/components/RequestPhotoGallery.tsx` — 상세 화면 갤러리. 0장이면 렌더 안 함, 큰 이미지 + 2장 이상이면 썸네일 버튼(`aria-pressed`, 접근 가능한 이름 `사진 n / 총`).

수정:

- `frontend/src/types/api.ts` — `PAYLOAD_TOO_LARGE`/`INVALID_IMAGE`/`PHOTO_LIMIT_EXCEEDED`/`PHOTO_STORAGE_UNAVAILABLE` 4개 코드 추가.
- `frontend/src/types/request.ts` — `RequestPhoto`, `PurchaseRequestDetail.photos`, `CreateRequestPayload.photoIds?`, `UploadedRequestPhoto` 추가.
- `frontend/src/lib/api/http.ts` — `KNOWN_ERROR_CODES` 4개 추가, `fallbackCode(413) → PAYLOAD_TOO_LARGE`.
- `frontend/src/lib/api/requests.ts` — `ALLOWED_FIELD_KEYS`에 `photoIds` 추가, `isSafeImageUrl`(https/http/`/api/request-photos/files/`만 허용, `//host` 스킴 상대·`javascript:`·`data:` 거부) 및 `parsePhotos`(누락 시 `[]`, 구조 오류 시 `null`→`INTERNAL_ERROR`, 안전하지 않은 URL 항목만 제외) 추가, `createRequest`에서 빈 `photoIds`는 키 자체를 생략.
- `frontend/src/features/requests/components/RequestForm.tsx` — 비활성 사진 버튼을 `PhotoPicker`로 교체. `pendingCount > 0`이면 제출 비활성 + 안내문, `failedCount > 0`이면 제출 시 `photos` 필드 오류, 성공 시 `photoIds: uploadedIds` 전송, 서버 `fields.photoIds` 응답은 `photos` 필드 메시지로 표시하며 사진 항목 전체를 비움(만료·재사용 사진은 되살릴 수 없으므로), 초기화 버튼은 업로드된 사진을 fire-and-forget으로 폐기하고 `PhotoPicker`를 새 key로 리마운트.
- `frontend/src/features/requests/components/RequestCard.tsx` — 썸네일 `<img>`에 `loading="lazy"`, `decoding="async"` 추가.
- `frontend/src/features/requests/components/RequestDetail.tsx` — 제목 아래·가격 카드 위 한 줄에 `RequestPhotoGallery` 삽입(4단계 지원자 영역과 충돌 최소화).

## 레이스·정리 관련 설계 메모

- `PhotoPicker`는 `items`를 매 갱신 시 `itemsRef`에 **동기적으로** 먼저 반영한 뒤 `setState`한다. 순차 업로드 루프는 `await` 지점마다 `itemsRef`로 "이 항목이 여전히 존재하는가"를 확인하므로, 업로드 도중 제거·초기화된 항목의 응답이 나중에 도착해도 상태를 덮어쓰지 않는다(stale response 무시).
- 업로드 중 항목 제거는 `AbortController.abort()`를 호출하고 `AbortError`는 조용히 무시한다(제거 자체가 최종 상태).
- 언마운트 시 `useEffect` cleanup에서 아직 해제되지 않은 모든 `previewUrl`을 `revokeObjectURL`하고 진행 중 업로드를 abort한다.
- `mountedRef`로 언마운트 후 비동기 콜백의 `setState` 호출을 차단한다.

## 실행 결과

```text
cd frontend
npm test -- --run
Test Files  19 passed (19)
     Tests  94 passed (94)

npm run lint
# exit 0, warnings 0

npx tsc --noEmit
# exit 0

npm run build
✓ Compiled successfully
✓ Generating static pages (6/6)
```

## 테스트 하네스 보정 (계약 약화 없음)

코디네이터가 지목한 `frontend/tests/PhotoPicker.test.tsx` 결함과, 구현 중 같은 종류로 확인된 `requestPhotosApi.test.ts` 결함을 수정했다. 두 경우 모두 프로덕션 코드가 아니라 테스트 격리 방식의 문제였다:

1. **`PhotoPicker.test.tsx`**: `vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })`는 `URL`(클래스)을 스프레드해 생성자 기능이 없는 plain object로 치환해 버려, 컴포넌트가 다른 코드 경로에서 쓰는 `new URL(...)`이 깨졌다(`TypeError: URL.createObjectURL is not a function`류 연쇄 실패). → 네이티브 `URL` 생성자는 그대로 두고 정적 `createObjectURL`/`revokeObjectURL`만 `vi.spyOn`으로 스텁하도록 변경(jsdom엔 두 메서드가 아예 없어 스텁을 먼저 `Object.assign`으로 만든 뒤 spy). `afterEach`에 `vi.restoreAllMocks()` 추가.
2. **`PhotoPicker.test.tsx`**: `userEvent.setup()`이 기본값(`applyAccept: true`)이라 `accept` 속성과 맞지 않는 파일(GIF 등)이 업로드 이벤트 자체에 실리지 않아, "허용 외 형식 거부" 시나리오가 컴포넌트 로직이 아니라 `userEvent`에 의해 걸러지고 있었다. → `userEvent.setup({ applyAccept: false })`로 변경해 컴포넌트의 클라이언트 사전검증이 실제로 실행되게 했다.
3. **`requestPhotosApi.test.ts`**: `afterEach`의 `vi.resetModules()`가 매 테스트마다 모듈 그래프를 리셋하는데, 파일 상단 정적 `import { ApiError } from '@/types/api'`와 테스트 내부 동적 `await import('@/lib/api/requestPhotos')`가 리셋 경계를 사이에 두고 서로 다른 모듈 인스턴스를 참조해 `instanceof ApiError`가 항상 거짓이 됐다. → 불필요한 `resetModules()`를 제거하고 `uploadRequestPhoto`/`deleteRequestPhoto`를 파일 상단에서 정적으로 import하도록 변경(`fetch`는 매 테스트 `vi.stubGlobal`로 교체되므로 모듈 재로드가 애초에 필요 없었다).

세 수정 모두 검증 대상 동작(요청 헤더/바디, 오류 코드 매핑, 클라이언트 사전검증 규칙)은 그대로 두고 테스트 격리 방식만 고쳤다.

## 백엔드 의존성

- 이 시점 `backend/app/api/request_photos.py` 등은 백엔드 워커가 이미 작업 중이었다(git status 확인). 프런트 테스트는 전부 `fetch` mock 기반이라 백엔드 기동 여부와 무관하게 통과한다.
- 실제 백엔드·로컬 드라이버 연동 UI 검증(3105/8105 동시 기동)은 코디네이터·UI 워커 합의 후 진행 — 이번 라운드에서는 서버를 띄우지 않았다.

## 남은 작업

- UI 검증 단계에서 실제 백엔드(`local` 드라이버)와 붙여 PhotoPicker 업로드/삭제/갤러리 선택 흐름을 브라우저로 재확인.
- 스펙 12장에 남긴 향후 결정 사항(서명 URL 대안 등)은 이번 범위 밖.
