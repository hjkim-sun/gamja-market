# 01. 프로젝트 기반 — 목업 기반 화면 구성

> 커리큘럼 1단계. 로그인 없이 볼 수 있는 정적 웹. Next.js 스캐폴딩 + 목업 데이터로 화면만 구성한다.
> **DB / 인증 / 백엔드 API 연동은 전부 이 단계의 범위 밖이다.**

---

## 1. 목표

- Next.js(App Router) + TypeScript 프로젝트를 스캐폴딩하고, 이후 단계에서 그대로 확장할 수 있는 디렉토리 구조를 확정한다.
- 감자마켓의 핵심 화면(구매요청 목록 / 상세 / 등록 폼)을 목업 데이터로 렌더링한다.
- "구매자가 사고 싶은 물건과 희망가를 올리면 판매자가 지원한다"는 서비스 컨셉이 화면만 봐도 전달되게 한다.

### 이 단계에서 하지 않는 것 (Out of Scope)

| 항목 | 도입 단계 |
| --- | --- |
| FastAPI 백엔드, DB, Docker Postgres | 2단계 |
| 회원가입 · 로그인 · 세션 | 2단계 |
| 구매요청 실제 등록(영속화) · 서버 조회 | 3단계 |
| 판매자 지원 처리 | 4단계 |
| 사진 업로드(Supabase Storage) | 5단계 |
| 채팅 | 6단계 |
| 매칭 확정 · 상태 전이 로직 | 7단계 |

> 1단계의 등록 폼은 **UI만** 존재한다. 제출 시 저장하지 않고, 유효성 검사 결과와 안내 문구만 보여준다.

---

## 2. 기술 스택 및 전제

| 항목 | 선택 |
| --- | --- |
| 프레임워크 | Next.js 15 (App Router) |
| 언어 | TypeScript (strict) |
| 스타일 | Tailwind CSS |
| 패키지 매니저 | npm |
| Node | 20 LTS 이상 |
| 렌더링 | 목록/상세는 서버 컴포넌트, 폼·필터 등 상호작용 요소만 클라이언트 컴포넌트 |
| 테스트 | Vitest + React Testing Library (스모크 수준) |

- 백엔드 디렉토리(`backend/`)는 이 단계에서 생성하지 않거나, 생성하더라도 비워 둔다.
- 외부 네트워크 호출은 없다. 모든 데이터는 `frontend/src/lib/mock/` 안의 정적 배열에서 온다.

---

## 3. 디렉토리 구조

```
frontend/
├── public/
│   └── images/                     # 목업 썸네일 (또는 placeholder 사용)
├── src/
│   ├── app/
│   │   ├── layout.tsx              # 루트 레이아웃 (Header/Footer)
│   │   ├── page.tsx                # 홈 = 구매요청 목록
│   │   ├── not-found.tsx
│   │   └── requests/
│   │       ├── new/page.tsx        # 구매요청 등록 폼 (UI만)
│   │       └── [id]/page.tsx       # 구매요청 상세
│   ├── components/                 # 도메인 무관 공용 UI
│   │   ├── layout/Header.tsx
│   │   ├── layout/Footer.tsx
│   │   └── ui/{Badge,Button,Card,EmptyState}.tsx
│   ├── features/
│   │   └── requests/
│   │       ├── components/RequestCard.tsx
│   │       ├── components/RequestList.tsx
│   │       ├── components/RequestFilterBar.tsx
│   │       ├── components/RequestDetail.tsx
│   │       ├── components/ApplicantList.tsx
│   │       └── components/RequestForm.tsx
│   ├── lib/
│   │   ├── mock/requests.ts        # 목업 구매요청 데이터
│   │   ├── mock/applicants.ts      # 목업 지원자 데이터
│   │   ├── mock/users.ts
│   │   └── format.ts               # 가격/상대시간 포맷터
│   └── types/
│       └── request.ts              # 도메인 타입 정의
├── tests/
└── logs/
docs/
└── specs/
    └── 01-project-foundation.md
```

**규칙**

- `features/` 하위는 도메인 단위로 묶는다. 구매요청 관련 UI는 전부 `features/requests/`에 둔다.
- `components/ui/`에는 도메인 지식이 없는 프리미티브만 둔다.
- 데이터 접근은 반드시 `lib/mock/*`을 경유한다. 컴포넌트 안에 데이터를 하드코딩하지 않는다 — 3단계에서 이 파일들만 API 호출로 교체하면 되도록.

---

## 4. 도메인 타입 (`src/types/request.ts`)

이후 단계의 DB 스키마와 어긋나지 않도록, 지금 확정해 둔다.

```ts
export type RequestStatus = 'open' | 'matched' | 'closed';

export type ProductCondition = 'any' | 'new' | 'like_new' | 'used';

export interface PurchaseRequest {
  id: string;
  title: string;              // "아이패드 프로 11인치 M2 구합니다"
  description: string;        // 원하는 스펙 상세
  category: string;           // '디지털기기' | '가전' | ...
  condition: ProductCondition;
  priceMin: number;           // 희망 가격대 하한 (원)
  priceMax: number;           // 희망 가격대 상한 (원)
  region: string;             // "서울 강남구"
  status: RequestStatus;
  thumbnailUrl: string | null;  // 1단계는 null 또는 placeholder (5단계에서 실제 업로드)
  buyer: UserSummary;
  applicantCount: number;
  createdAt: string;          // ISO 8601
}

export interface UserSummary {
  id: string;
  nickname: string;
  region: string;
}

export interface Applicant {
  id: string;
  requestId: string;
  seller: UserSummary;
  offerPrice: number;         // 판매자 제시가
  message: string;
  createdAt: string;
}
```

**상태값 표기**

| status | 라벨 | 배지 색 |
| --- | --- | --- |
| `open` | 구해요 | 초록 |
| `matched` | 매칭됨 | 파랑 |
| `closed` | 마감 | 회색 |

---

## 5. 목업 데이터 요구사항

- `mockRequests`: **최소 12건**. 아래 조건을 모두 만족하도록 구성한다.
  - status가 `open` / `matched` / `closed` 각각 최소 1건씩 포함
  - `applicantCount`가 0인 건 최소 1건 (지원자 없음 UI 확인용)
  - 카테고리는 최소 4종 (디지털기기, 가전, 가구/인테리어, 의류, 도서 등)
  - 제목이 아주 긴 건 1건 이상 (텍스트 말줄임 확인용)
  - `priceMin <= priceMax`를 항상 만족
  - `createdAt`은 서로 다른 시각. 목록 기본 정렬(최신순) 확인이 가능해야 함
- `mockApplicants`: 특정 요청 1건에 **3명 이상** 연결. 4단계(다중 지원) UI를 미리 검증하기 위함.
- 가격은 실제 중고 시세에 가깝게(예: 300,000 ~ 900,000) 넣어 포맷터 검증이 되게 한다.

---

## 6. 화면 명세

### 6.1 공통 레이아웃

- **Header**: 좌측 로고("감자마켓"), 중앙 검색 인풋(1단계에서는 클라이언트 측 제목 필터만 동작), 우측 `로그인` 버튼 + `구매요청 등록` 버튼.
  - `로그인` 버튼은 2단계 전까지 비활성 또는 "준비 중" 안내로 처리한다.
- **Footer**: 프로젝트 설명 한 줄 + 실습용 프로젝트임을 명시.
- 최대 컨텐츠 폭 1200px, 좌우 패딩 16px(모바일) / 24px(데스크톱).

### 6.2 홈 — 구매요청 목록 (`/`)

- 상단에 서비스 한 줄 소개: "사고 싶은 물건을 올리면, 판매자가 찾아옵니다."
- **필터 바** (`RequestFilterBar`, 클라이언트 컴포넌트)
  - 카테고리 칩 (전체 + 각 카테고리, 단일 선택)
  - 상태 필터 (전체 / 구해요만)
  - 정렬 (최신순 / 희망가 높은순 / 지원자 많은순)
  - 필터 상태는 URL 쿼리스트링(`?category=&status=&sort=`)에 반영해 새로고침 시 유지한다.
- **카드 그리드**: 데스크톱 3열 / 태블릿 2열 / 모바일 1열.
- **RequestCard** 표시 항목: 썸네일(또는 카테고리 이모지 플레이스홀더), 상태 배지, 제목(2줄 말줄임), `희망가 30만원 ~ 45만원`, 지역, `지원 3명`, 상대 시간("3시간 전").
- 카드 클릭 → `/requests/[id]`.
- 필터 결과가 0건이면 `EmptyState`("조건에 맞는 구매요청이 없어요") 표시.

### 6.3 구매요청 상세 (`/requests/[id]`)

- 상단: 상태 배지, 제목, 등록 시각, 카테고리.
- 희망 가격대를 강조 표시(가장 큰 활자).
- 원하는 스펙 상세(`description`) 본문, 희망 상태(`condition`), 거래 희망 지역.
- 구매자 요약 카드(닉네임, 지역).
- **지원자 목록**(`ApplicantList`): 판매자 닉네임, 제시가, 메시지, 지원 시각. 지원자가 없으면 "아직 지원한 판매자가 없어요".
- 하단 고정 액션 영역: `지원하기` 버튼 — 1단계에서는 비활성(`disabled`) + "4단계에서 구현 예정" 툴팁/안내.
- 존재하지 않는 id면 `notFound()` 호출 → `not-found.tsx`.

### 6.4 구매요청 등록 (`/requests/new`)

폼 UI만 구현하며 저장하지 않는다.

| 필드 | 입력 형태 | 검증 |
| --- | --- | --- |
| 제목 | text | 필수, 2~60자 |
| 카테고리 | select | 필수 |
| 원하는 스펙 | textarea | 필수, 10~1000자 |
| 희망 최소가 / 최대가 | number 2개 | 필수, 0 이상, `min <= max` |
| 희망 상태 | radio (상관없음/새상품/거의새것/중고) | 필수 |
| 거래 지역 | text | 필수 |
| 사진 | 자리만 표시 | 1단계 비활성 ("5단계에서 지원") |

- 검증은 클라이언트에서 수행하고, 실패한 필드 아래에 에러 메시지를 노출한다.
- 제출 성공 시: 저장하지 않고 "아직 저장 기능이 없습니다(3단계 예정)" 안내 배너를 띄운다.

---

## 7. 포맷 규칙 (`lib/format.ts`)

- `formatPrice(n)`: `450000` → `45만원`. 만 단위로 떨어지지 않으면 `450,500원` 형태.
- `formatPriceRange(min, max)`: `30만원 ~ 45만원`. `min === max`면 단일 값.
- `formatRelativeTime(iso)`: 1분 미만 "방금 전", 1시간 미만 "N분 전", 24시간 미만 "N시간 전", 7일 미만 "N일 전", 그 이상 `YYYY.MM.DD`.

---

## 8. 접근성 · 반응형

- 모든 이미지에 `alt` 제공. 플레이스홀더는 `alt=""` + `aria-hidden`.
- 카드 전체를 링크로 감싸되, 링크 텍스트는 제목이 읽히도록 구성한다.
- 상태 배지는 색상만으로 구분하지 않고 텍스트를 함께 표기한다.
- 브레이크포인트: 640px / 1024px.
- 320px 폭에서 가로 스크롤이 발생하지 않아야 한다.

---

## 9. 완료 조건 (Definition of Done)

- [ ] `npm run dev`로 실행 시 `/`, `/requests/[id]`, `/requests/new` 3개 경로가 모두 정상 렌더링된다.
- [ ] `npm run build`가 타입 에러 없이 통과한다.
- [ ] 목록에서 카드를 클릭하면 해당 상세 페이지로 이동한다.
- [ ] 카테고리·상태·정렬 필터가 동작하고, 새로고침 후에도 URL 쿼리로 상태가 유지된다.
- [ ] 존재하지 않는 요청 id 접근 시 404 페이지가 표시된다.
- [ ] 등록 폼의 필수/범위 검증이 동작하고, 제출 시 저장 없이 안내 메시지가 표시된다.
- [ ] 320px ~ 1440px 범위에서 레이아웃이 깨지지 않는다.
- [ ] 코드 어디에도 DB·인증·외부 API 호출이 없다.
- [ ] `formatPrice` / `formatPriceRange` / `formatRelativeTime` 단위 테스트가 통과한다.

---

## 10. 다음 단계 연결점

- **2단계**: Header의 `로그인` 버튼이 실제 로그인 페이지로 연결된다. `UserSummary`가 실제 회원 테이블과 매핑된다.
- **3단계**: `lib/mock/requests.ts`를 FastAPI 호출로 교체한다. 컴포넌트 시그니처는 그대로 유지되도록 지금부터 props를 타입 기준으로 설계한다.
- **4단계**: 상세 페이지의 `지원하기` 버튼을 활성화하고 `ApplicantList`를 실데이터로 채운다.
