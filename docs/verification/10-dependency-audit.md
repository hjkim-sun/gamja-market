# 10 의존성 보안 패치(S-08) 검증 기록

- 일자: 2026-10-09
- 설계: [10-security-performance-hardening.md](../specs/10-security-performance-hardening.md) §6.6
- 대상: `frontend/package.json`, `frontend/package-lock.json`
- 방식: 설계 §6.6.3 절차대로 `package.json` 3개 키를 고치고 `npm install`로 기존 잠금 파일을 갱신한 뒤, `--force` 없는 `npm audit fix`를 한 번 실행했다. `npm audit fix --force`, 메이저 버전 override, 잠금 파일 삭제 후 재해결은 사용하지 않았다.

## 1. 변경 내용

`git diff frontend/package.json`은 설계 §6.6.2의 세 키만 바꾼다.

| 키 | 변경 전 | 변경 후 |
| --- | --- | --- |
| `dependencies.next` | `15.5.24` | `15.5.27` |
| `devDependencies.eslint-config-next` | `15.5.24` | `15.5.27` |
| `overrides.sharp` | `0.35.0` | `0.35.5` |

- `npm view next@15.5 version`으로 15.5 라인 최신 패치가 15.5.27임을 작업 시점에 다시 확인했다. `eslint-config-next`도 15.5.27이 최신이다.
- 잠금 파일은 `npm install`이 선언 범위 안에서 갱신했고, 이어 `npm audit fix`(force 없음)가 `source-map-js`·`brace-expansion`을 범위 안 패치 버전으로 올렸다.

## 2. 해결된 버전

`npm ls next eslint-config-next sharp source-map-js brace-expansion` 결과:

| 패키지 | 변경 전 | 변경 후 |
| --- | --- | --- |
| `next` | 15.5.24 | **15.5.27** |
| `eslint-config-next` | 15.5.24 | **15.5.27** |
| `sharp` | 0.35.0 | **0.35.5** (`overridden`) |
| `source-map-js` | 1.2.1 | **1.2.2** |
| `brace-expansion` | 1.1.18 / 5.0.9 | **1.1.21 / 5.0.12** |

## 3. audit 결과

### 3.1 운영 의존성 — 수용 기준 충족

```
$ npm audit --omit=dev --package-lock-only
found 0 vulnerabilities
```

- 변경 전: high 3건(`next`, `sharp`, `source-map-js`) → 변경 후: **0건**. high 이상 0건 기준을 충족한다.

### 3.2 전체(dev 포함)

변경 전 16건(critical 2 · high 11 · moderate 3) → 변경 후 **12건(critical 2 · high 7 · moderate 3)**. 아래 12건은 모두 `devDependencies` 트리이고, 설계 §6.6.4의 S-08b 목록의 부분집합이다. `next`, `sharp`, `source-map-js`, `brace-expansion`은 남아 있지 않다. 새로 생긴 항목은 없다.

| 패키지 | 심각도 | 직접/전이 | 남은 사유 (같은 메이저 안에서 해결 불가) |
| --- | --- | --- | --- |
| `vitest` | critical | 직접 | 영향 범위가 `0.0.95–4.1.10`이라 3.x 최신(3.2.7)도 포함된다. 수정은 vitest 5(메이저) |
| `tinypool` | critical | 전이 | vitest 3.x가 `tinypool ^1`을 요구한다. 영향 범위 `<=2.1.1`. vitest 5 필요 |
| `@vitest/mocker` | moderate | 전이 | vitest 메이저 업그레이드와 함께 해결 |
| `tailwindcss` | high | 직접 | 3.4.19(3.x 최신)가 취약한 `chokidar@3`·`fast-glob`·`micromatch`·`postcss-nested@6`에 의존. 수정은 tailwindcss 4(설정 이관) |
| `braces` | high | 전이 | 영향 범위 `*`, 수정 버전 없음. 공개되면 `tailwindcss`·`eslint-config-next` 양쪽에서 해소 |
| `micromatch` | high | 전이 | `braces` 의존 |
| `chokidar` | high | 전이 | tailwindcss 3.x 의존(`2.0.0–3.6.0`) |
| `postcss-nested` | moderate | 전이 | tailwindcss 3.x 의존. 수정판이 없다 |
| `postcss-selector-parser` | moderate | 전이 | 수정판 `>=7.1.6`은 메이저(tailwindcss 4) |
| `fast-glob` | high | 전이 | `@next/eslint-plugin-next@15.5.27`도 `fast-glob@3.3.1` → `micromatch` → `braces` 의존 |
| `@next/eslint-plugin-next` | high | 전이 | 위와 같은 사슬. npm이 제안하는 수정은 `eslint-config-next@14.2.35`(다운그레이드·메이저)라 적용하지 않았다 |
| `eslint-config-next` | high | 직접 | 위와 같은 사슬 |

- 모두 개발 머신에서 신뢰할 수 있는 입력(자체 소스·설정)만 처리하며 `next build` 산출물과 런타임에 들어가지 않는다(`--omit=dev` 0건이 이를 확인한다).
- `npm audit fix --force`가 제안하는 변경(vitest 5, tailwindcss 4, eslint-config-next 14.2.35 다운그레이드)은 모두 breaking change라서 적용하지 않았다. → **S-08b 후속 PR**에서 vitest 5와 tailwindcss 4 이관을 별도로 설계한다. `braces` 수정판이 공개되면 `eslint-config-next` 계열도 함께 해소된다.

## 4. 회귀 검증

| 명령 | 결과 |
| --- | --- |
| `npm run lint` (`--max-warnings=0`) | 통과 |
| `npm test` (vitest) | 30 파일 · **278 테스트 전부 통과** (RED 11건 포함 GREEN) |
| `npm run build` (Next.js 15.5.27) | 통과. 라우트 목록은 변경 전과 같다: `/`, `/_not-found`, `/chats`, `/chats/[roomId]`, `/login`, `/requests/[id]`, `/requests/new`, `/signup` |
| `next start` 후 `curl -I /login` | `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY` 확인 |

## 5. 남은 과제

- S-08b: vitest 5, tailwindcss 4 이관, `braces` 수정판 확인(별도 PR).
- 설계 §12 항목 8(Next 15.5.27에서 홈·상세·로그인·가입·채팅 화면의 브라우저 콘솔 오류 확인)은 ui tester 단계에서 수행한다. 이 기록에는 빌드·테스트 결과만 포함한다.
