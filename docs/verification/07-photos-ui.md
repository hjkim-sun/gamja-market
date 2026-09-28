# 07 구매요청 사진 — 실제 UI 검증

검증일: 2026-09-26 (Asia/Seoul)
실행: Orca embedded browser (`browserPageId=f66e0405-a5a7-4f7c-b536-be4be912ff01`), 실제 로컬 FastAPI `8105` + Next.js `3105`
서버 터미널: `photos-api` (`term_5fba6330-ab92-49d0-a6c4-cdf9c88ba6d3`), `photos-web` (`term_5c07042d-c1d6-4d95-a3c9-bce1c1f00d20`). 두 터미널은 검증 뒤에도 열어 두었다.

## 결과

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 로그인 UI 계정 생성 | 통과 | 고유 계정을 회원가입 UI로 생성하고 인증된 등록 화면으로 이동했다. 자격 증명은 기록하지 않는다. |
| JPG/PNG/WebP 순차 업로드와 미리보기 | 통과 | 세 파일을 각각 선택해 `1/5` → `2/5` → `3/5`로 진행했고 미리보기 3개와 대표 배지를 확인했다. |
| 손상 이미지 실패·재시도·폼 보존 | 통과 | 손상 JPEG는 `INVALID_IMAGE` 사용자 메시지와 재시도를 보였고, 제목·카테고리·사양·가격·지역 입력은 유지됐다. |
| 클라이언트 거부 | 통과 | 3 MiB 초과 PNG는 `3MB 이하`, TXT는 `JPG, PNG, WEBP` 메시지로 즉시 거부됐다. |
| 5장 한도, 제거, 초기화 | 통과 | 5개 미리보기에서 `사진 추가 (5/5)` 입력이 disabled였고, 개별 삭제와 초기화 뒤 `0/5` 및 빈 폼을 확인했다. |
| 사진 없는 등록 호환성 | 통과 | 실제 생성 요청 `3ab5223c-5bf7-4d85-a785-840fa5b6ea0c`의 상세 URL에서 사진 갤러리 없이 정상 상세가 표시됐다. |
| 사진 첨부 등록·상세 갤러리 | 통과 | 실제 생성 요청 `515e3c30-cf9a-447b-a538-c3787e30371f`에서 3개 썸네일·대표 이미지가 표시됐고, 대표 이미지 `naturalWidth=48`, `naturalHeight=32`였다. |
| 키보드 썸네일 선택 | 통과 | 두 번째 썸네일에 focus 후 Enter를 보내 대표 이미지 alt가 `사진 2/3`으로 바뀌었다. |
| 목록 첫 사진 썸네일 | 통과 | 고유 제목으로 검색한 목록 1건에 `참고 이미지`가 표시됐다. |
| 데스크톱 레이아웃 | 통과 | Orca 1216×969 실제 뷰포트 스크린샷에서 선택기·목록·상세 갤러리를 확인했다. |
| 503 오류 안내 및 복구 — 책임자 보완 | 통과 (응답 주입) | 사진 POST에만 계약 형태의 503을 주입해 `사진 업로드를 지금 사용할 수 없어요. 사진 없이 등록할 수 있어요.` 표시를 확인했다. 원래 fetch로 복구하고 화면 안의 재시도 버튼을 클릭하자 실제 업로드가 완료되어 오류가 사라졌다. |
| 업로드 대기 중 등록 차단 — 책임자 보완 | 통과 (지연 주입) | 사진 POST만 Promise로 보류한 동안 `aria-busy=true`, 대기 안내, `구매요청 등록` 버튼의 `disabled=true`를 확인했다. 이후 실제 fetch로 전달해 업로드를 완료하고 원래 fetch를 복원했다. |

## 실제 로컬 HTTP 상태 근거

`photos-api` 로그에서 사진 업로드 성공은 `POST /api/request-photos 201`, 손상 이미지 거부는 `422`, 일반 제거는 `DELETE /api/request-photos/{id} 204`, 사진/무사진 등록은 각각 `POST /api/requests 201`으로 확인했다. 상세 갤러리는 세 로컬 파일 URL을 `200`으로 받았다. 원시 요청 헤더·쿠키·비밀번호는 수집하거나 기록하지 않았다.

## 스크린샷 및 fixture

- `07-photos-ui/01-picker-three-photos.png` — 실제 3장 미리보기
- `07-photos-ui/02-picker-five-max.png` — 실제 5장 한도 disabled 상태
- `07-photos-ui/03-detail-gallery.png` — 실제 상세 갤러리
- `07-photos-ui/04-list-thumbnail.png` — 고유 제목 검색 결과의 첫 사진 썸네일
- `07-photos-ui/05-mocked-storage-503.png` — 책임자가 추가 확인한 503 안내 (응답 주입)
- `07-photos-ui/06-pending-submit-disabled.png` — 책임자가 추가 확인한 대기 중 등록 차단 (지연 주입)
- `07-photos-ui/fixture-red.jpg`, `fixture-blue.png`, `fixture-green.webp` — 정상 업로드 fixture
- `07-photos-ui/fixture-corrupted.jpg`, `fixture-oversize.png`, `fixture-invalid.txt` — 오류 검증 fixture

## 제한 및 미검증

- Supabase 실제 연동은 자격 증명이 제공되지 않아 미검증이다. 본 검증은 명시적으로 `PHOTO_STORAGE_DRIVER=local`을 쓴 실제 로컬 백엔드 경로다.
- UI 워커 최초 보고에서는 503과 pending 차단이 미검증이었다. 책임자가 이후 Orca CLI로 위 두 항목을 보완했다. 503은 실제 Supabase 장애가 아닌 브라우저 응답 주입이며, 대기 상태도 의도적인 지연 주입이다. 초기에 화면 밖 버튼에 대한 click 영수증만으로 재시도를 판단할 수 없었고, 명시적으로 스크롤한 뒤 DOM 상태 변화와 실제 업로드 복구를 확인했다.
- 현재 Orca browser CLI에는 뷰포트 resize/mobile emulation 명령이 노출되지 않아 모바일 레이아웃은 **미검증**이다. 데스크톱 결과를 모바일 결과로 일반화하지 않는다.
- 프런트 작업 터미널은 세션 quota로 중단되어 코디네이터가 잔여 수정을 맡았다는 운영 제약이 있었고, 이 UI 검증에서는 해당 터미널에 수정을 보내지 않았다.
