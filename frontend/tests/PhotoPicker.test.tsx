import { StrictMode } from 'react';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestForm } from '@/features/requests/components/RequestForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /제목/ }), '사진 구매요청');
  await user.selectOptions(screen.getByRole('combobox', { name: /카테고리/ }), '디지털기기');
  await user.type(screen.getByRole('textbox', { name: /원하는 스펙/ }), '충분히 자세한 구매 희망 스펙입니다.');
  await user.type(screen.getByRole('spinbutton', { name: '희망 최소가' }), '100000');
  await user.type(screen.getByRole('spinbutton', { name: '희망 최대가' }), '200000');
  await user.click(screen.getByRole('radio', { name: /거의 새것/ }));
  await user.type(screen.getByRole('textbox', { name: /거래 지역/ }), '서울 강남구');
}

describe('PhotoPicker', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    // 네이티브 URL 생성자(new URL(...))는 그대로 두고, 정적 create/revoke만 스텁한다.
    // {...URL}로 스프레드하면 생성자 기능이 없는 plain object가 되어 이후 new URL() 호출이 깨진다.
    // jsdom은 createObjectURL/revokeObjectURL을 아예 구현하지 않으므로 먼저 정의한 뒤 spy한다.
    if (!('createObjectURL' in URL)) {
      Object.assign(URL, { createObjectURL: () => '', revokeObjectURL: () => {} });
    }
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => `blob:${(obj as File).name}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('여러 파일을 선택 순서대로 한 장씩 업로드하고 첫 사진을 대표로 표시한다', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const file = init?.body as File;
      await Promise.resolve();
      active -= 1;
      return jsonResponse(201, {
        id: `id-${file.name}`,
        contentType: file.type,
        byteSize: file.size,
        width: 8,
        height: 6,
        expiresAt: '2026-09-27T03:10:00+00:00',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    render(<RequestForm />);
    const files = [
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ];

    await user.upload(screen.getByLabelText(/사진 추가/), files);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
    expect(screen.getByText('대표')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /사진 1 미리보기/ })).toHaveAttribute('src', 'blob:one.jpg');
  });

  it('6번째·3MiB 초과·허용 외 형식 파일은 API 호출 전에 거부한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, {}));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    render(<RequestForm />);
    const valid = Array.from({ length: 6 }, (_, index) =>
      new File(['ok'], `${index}.jpg`, { type: 'image/jpeg' }));
    const tooLarge = new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    });
    const gif = new File(['gif'], 'animated.gif', { type: 'image/gif' });

    await user.upload(screen.getByLabelText(/사진 추가/), [...valid, tooLarge, gif]);

    expect(await screen.findByText(/사진은 최대 5장/)).toBeInTheDocument();
    expect(screen.getByText(/3MB 이하 사진/)).toBeInTheDocument();
    expect(screen.getByText(/JPG, PNG, WEBP 사진/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('업로드 중에는 등록 버튼을 비활성화하고 제거하면 요청을 중단한다', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(
      (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    ));
    const user = userEvent.setup({ applyAccept: false });
    render(<RequestForm />);

    await user.upload(
      screen.getByLabelText(/사진 추가/),
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
    );

    expect(screen.getByRole('button', { name: '구매요청 등록' })).toBeDisabled();
    expect(screen.getByText('사진 업로드가 끝나면 등록할 수 있어요.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '사진 1 삭제' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:one.jpg');
  });

  it('업로드된 ID를 선택 순서대로 등록 payload에 포함한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (input === '/api/requests') {
        return jsonResponse(201, {
          id: 'request-id', title: '사진 구매요청', category: '디지털기기',
          description: '충분히 자세한 구매 희망 스펙입니다.', priceMin: 100000,
          priceMax: 200000, condition: 'like_new', region: '서울 강남구', status: 'open',
          thumbnailUrl: '/api/request-photos/files/id-one.jpg', applicantCount: 0,
          createdAt: '2026-09-26T00:00:00+00:00', updatedAt: '2026-09-26T00:00:00+00:00',
          isOwner: true, buyer: { id: 'buyer', maskedEmail: 'bu***@example.com' },
          photos: [],
        });
      }
      const file = init?.body as File;
      return jsonResponse(201, {
        id: `id-${file.name.replace(/\..+$/, '')}`,
        contentType: file.type,
        byteSize: file.size,
        width: 8,
        height: 6,
        expiresAt: '2026-09-27T03:10:00+00:00',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    render(<RequestForm />);
    await user.upload(screen.getByLabelText(/사진 추가/), [
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '구매요청 등록' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).photoIds).toEqual(['id-one', 'id-two']);
  });

  it('StrictMode의 mount-unmount-remount 이후에도 업로드 성공이 반영된다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, {
      id: 'id-one',
      contentType: 'image/jpeg',
      byteSize: 3,
      width: 8,
      height: 6,
      expiresAt: '2026-09-27T03:10:00+00:00',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    // StrictMode는 개발 모드에서 effect를 mount → cleanup → 재mount 순으로 두 번 실행해,
    // mountedRef를 초기값에만 의존해 관리하면 재마운트 후에도 계속 "언마운트됨"으로 남는
    // 회귀를 잡아낸다.
    render(
      <StrictMode>
        <RequestForm />
      </StrictMode>,
    );

    await user.upload(
      screen.getByLabelText(/사진 추가/),
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('대표')).toBeInTheDocument());
    expect(screen.queryByText(/업로드 중/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '구매요청 등록' })).not.toBeDisabled();
  });

  it('두 번에 나눠 선택한 파일도 전역 큐 하나로 직렬 업로드한다', async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const file = init?.body as File;
      if (file.name === 'first.jpg') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      active -= 1;
      return jsonResponse(201, {
        id: `id-${file.name}`,
        contentType: file.type,
        byteSize: file.size,
        width: 8,
        height: 6,
        expiresAt: '2026-09-27T03:10:00+00:00',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    render(<RequestForm />);

    // 첫 번째 선택이 아직 진행 중(fetch가 대기 중)인 동안 두 번째 선택을 이어서 한다.
    await user.upload(
      screen.getByLabelText(/사진 추가/),
      new File(['first'], 'first.jpg', { type: 'image/jpeg' }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.upload(
      screen.getByLabelText(/사진 추가/),
      new File(['second'], 'second.png', { type: 'image/png' }),
    );

    // 두 번째 선택의 업로드는 첫 번째가 끝나기 전까지 시작되지 않는다(fetch 호출도 없음).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
  });

  it('제출 중에는 사진 추가·제거·재시도를 모두 동결한다', async () => {
    let resolveUpload: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (input === '/api/requests') {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve(jsonResponse(201, {
        id: 'id-one',
        contentType: 'image/jpeg',
        byteSize: 3,
        width: 8,
        height: 6,
        expiresAt: '2026-09-27T03:10:00+00:00',
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    render(<RequestForm />);

    await user.upload(
      screen.getByLabelText(/사진 추가/),
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
    );
    await waitFor(() => expect(screen.getByText('대표')).toBeInTheDocument());
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '구매요청 등록' }));
    await screen.findByRole('button', { name: '등록 중…' });

    expect(screen.getByRole('button', { name: '사진 1 삭제' })).toBeDisabled();
    expect(screen.getByLabelText(/사진 추가/)).toBeDisabled();
    const reset = screen.getByRole('button', { name: '초기화' });
    expect(reset).toBeDisabled();
    await user.click(reset);
    expect(screen.getByRole('textbox', { name: /제목/ })).toHaveValue('사진 구매요청');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: /사진 1 미리보기/ })).toBeInTheDocument();

    resolveUpload?.(jsonResponse(201, {
      id: 'request-id', title: '사진 구매요청', category: '디지털기기',
      description: '충분히 자세한 구매 희망 스펙입니다.', priceMin: 100000,
      priceMax: 200000, condition: 'like_new', region: '서울 강남구', status: 'open',
      thumbnailUrl: null, applicantCount: 0,
      createdAt: '2026-09-26T00:00:00+00:00', updatedAt: '2026-09-26T00:00:00+00:00',
      isOwner: true, buyer: { id: 'buyer', maskedEmail: 'bu***@example.com' },
      photos: [],
    }));
  });

  it('handleSubmit 자체가 업로드 대기 중이면 버튼 상태와 무관하게 등록을 막는다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ applyAccept: false });
    const { container } = render(<RequestForm />);

    await user.upload(
      screen.getByLabelText(/사진 추가/),
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
    );
    await fillValidForm(user);

    const form = container.querySelector('form');
    expect(form).toBeTruthy();
    // 버튼은 disabled라 클릭이 통하지 않지만, submit 이벤트 자체를 직접 발생시켜
    // handleSubmit 내부의 pendingCount 가드가 버튼 상태와 무관하게 동작하는지 검증한다.
    if (form?.requestSubmit) {
      form.requestSubmit();
    } else {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '구매요청 등록' })).toBeInTheDocument();
  });
});
