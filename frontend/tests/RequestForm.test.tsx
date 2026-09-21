import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestForm } from '@/features/requests/components/RequestForm';

const push = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
}));

const detail = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '아이패드 구합니다',
  category: '디지털기기',
  description: 'M2 모델이며 상태가 깨끗하면 좋겠습니다.',
  priceMin: 600_000,
  priceMax: 800_000,
  condition: 'like_new',
  region: '서울 강남구',
  status: 'open',
  thumbnailUrl: null,
  applicantCount: 0,
  createdAt: '2026-09-21T08:30:00+00:00',
  updatedAt: '2026-09-21T08:30:00+00:00',
  isOwner: true,
  buyer: { id: 'user-1', maskedEmail: 'bu***@example.com' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: () => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function submitButton() {
  return screen.getByRole('button', { name: /입력 내용 확인|구매요청 등록|등록 중/ });
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /제목/ }), detail.title);
  await user.selectOptions(screen.getByRole('combobox', { name: /카테고리/ }), detail.category);
  await user.type(screen.getByRole('textbox', { name: /원하는 스펙/ }), detail.description);
  await user.type(screen.getByRole('spinbutton', { name: '희망 최소가' }), String(detail.priceMin));
  await user.type(screen.getByRole('spinbutton', { name: '희망 최대가' }), String(detail.priceMax));
  await user.click(screen.getByRole('radio', { name: /거의 새것/ }));
  await user.type(screen.getByRole('textbox', { name: /거래 지역/ }), detail.region);
}

describe('RequestForm', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    push.mockClear();
    refresh.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('빈 폼을 제출하면 필수 입력 오류를 보여주고 API를 호출하지 않는다', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(201, detail));
    const user = userEvent.setup();
    render(<RequestForm />);

    await user.click(submitButton());

    expect(screen.getByText('제목은 2자 이상 60자 이하로 입력해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('카테고리를 선택해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('희망 상태를 선택해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('거래 지역을 입력해 주세요.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('최소가가 최대가보다 크면 범위 오류를 보여준다', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(201, detail));
    const user = userEvent.setup();
    render(<RequestForm />);
    await fillValidForm(user);
    await user.clear(screen.getByRole('spinbutton', { name: '희망 최소가' }));
    await user.type(screen.getByRole('spinbutton', { name: '희망 최소가' }), '900000');

    await user.click(submitButton());

    expect(screen.getByText('최대가는 최소가보다 크거나 같아야 합니다.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('유효한 입력을 API에 보내고 저장 예정 목업 안내를 렌더하지 않는다', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(201, detail));
    const user = userEvent.setup();
    render(<RequestForm />);
    await fillValidForm(user);

    await user.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/requests');
    expect(JSON.parse(String(init.body))).toEqual({
      title: detail.title,
      category: detail.category,
      description: detail.description,
      priceMin: detail.priceMin,
      priceMax: detail.priceMax,
      condition: detail.condition,
      region: detail.region,
    });
    expect(screen.queryByText(/아직 저장 기능이 없습니다/)).not.toBeInTheDocument();
  });

  it('등록 성공 시 새 상세로 이동하고 서버 데이터를 새로고침한다', async () => {
    stubFetch(async () => jsonResponse(201, detail));
    const user = userEvent.setup();
    render(<RequestForm />);
    await fillValidForm(user);

    await user.click(submitButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/requests/${detail.id}`));
    expect(refresh).toHaveBeenCalled();
  });

  it('서버 422 fields를 입력 아래 표시하고 입력값을 보존한다', async () => {
    stubFetch(async () =>
      jsonResponse(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: '입력값을 확인해 주세요.',
          fields: { title: '서버가 제목을 거부했습니다.' },
        },
      }),
    );
    const user = userEvent.setup();
    render(<RequestForm />);
    await fillValidForm(user);

    await user.click(submitButton());

    await waitFor(() => expect(screen.getByText('서버가 제목을 거부했습니다.')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: /제목/ })).toHaveValue(detail.title);
    expect(screen.getByRole('textbox', { name: /제목/ })).toHaveAttribute('aria-invalid', 'true');
  });

  it('제출 중 버튼을 비활성화하고 중복 클릭을 한 요청으로 합친다', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = stubFetch(
      () => new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<RequestForm />);
    await fillValidForm(user);

    await user.click(submitButton());
    const pendingButton = await screen.findByRole('button', { name: '등록 중…' });
    expect(pendingButton).toBeDisabled();
    await user.click(pendingButton);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveResponse?.(jsonResponse(201, detail));
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it('401이면 재로그인 링크를 보여주며 모든 입력값을 보존한다', async () => {
    stubFetch(async () =>
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: '다시 로그인해 주세요.', fields: {} },
      }),
    );
    const user = userEvent.setup();
    render(<RequestForm />);
    await fillValidForm(user);

    await user.click(submitButton());

    const login = await screen.findByRole('link', { name: /다시 로그인/ });
    expect(login).toHaveAttribute('href', '/login?next=/requests/new');
    expect(screen.getByRole('textbox', { name: /제목/ })).toHaveValue(detail.title);
    expect(screen.getByRole('textbox', { name: /원하는 스펙/ })).toHaveValue(detail.description);
  });

  it('사진 업로드는 계속 비활성 상태다', () => {
    render(<RequestForm />);
    expect(screen.getByRole('button', { name: '사진 업로드 · 5단계에서 지원' })).toBeDisabled();
  });
});
