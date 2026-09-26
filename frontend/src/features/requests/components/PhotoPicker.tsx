'use client';

import { ChangeEvent, useEffect, useId, useRef, useState } from 'react';

import { deleteRequestPhoto, uploadRequestPhoto } from '@/lib/api/requestPhotos';
import { ApiError } from '@/types/api';
import type { ApiErrorCode } from '@/types/api';

const MAX_PHOTOS = 5;
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const UPLOAD_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  PAYLOAD_TOO_LARGE: '3MB 이하 사진만 올릴 수 있어요.',
  UNSUPPORTED_MEDIA_TYPE: 'JPG, PNG, WEBP 형식의 2천만 화소 이하 정지 사진만 올릴 수 있어요.',
  INVALID_IMAGE: 'JPG, PNG, WEBP 형식의 2천만 화소 이하 정지 사진만 올릴 수 있어요.',
  PHOTO_LIMIT_EXCEEDED: '업로드 중인 사진이 너무 많아요. 잠시 후 다시 시도해 주세요.',
  PHOTO_STORAGE_UNAVAILABLE: '사진 업로드를 지금 사용할 수 없어요. 사진 없이 등록할 수 있어요.',
  NETWORK_ERROR: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
};

const DEFAULT_UPLOAD_ERROR_MESSAGE = '잠시 후 다시 시도해 주세요.';

function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return UPLOAD_ERROR_MESSAGES[error.code] ?? DEFAULT_UPLOAD_ERROR_MESSAGE;
  }
  return DEFAULT_UPLOAD_ERROR_MESSAGE;
}

type PhotoItemStatus =
  | { kind: 'uploading' }
  | { kind: 'uploaded'; id: string }
  | { kind: 'failed'; message: string };

interface PhotoItem {
  key: string;
  file: File;
  previewUrl: string;
  status: PhotoItemStatus;
  controller: AbortController;
}

export interface PhotoPickerSummary {
  uploadedIds: string[];
  pendingCount: number;
  failedCount: number;
}

interface PhotoPickerProps {
  onChange: (summary: PhotoPickerSummary) => void;
  /** 제출 중에는 새 선택·제거·재시도를 모두 막는다(등록 트랜잭션과 겹치지 않도록). */
  disabled?: boolean;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `photo-${keySeq}`;
}

function summarize(items: PhotoItem[]): PhotoPickerSummary {
  return {
    uploadedIds: items
      .map((item) => (item.status.kind === 'uploaded' ? item.status.id : null))
      .filter((id): id is string => id !== null),
    pendingCount: items.filter((item) => item.status.kind === 'uploading').length,
    failedCount: items.filter((item) => item.status.kind === 'failed').length,
  };
}

/**
 * 설계서 7.2 — 등록 폼의 사진 선택·업로드 위젯.
 * 선택한 파일은 클라이언트에서 사전 검증한 뒤, 여러 번의 선택·재시도를 통틀어
 * 하나의 전역 순차 큐로 한 번에 한 장씩만 업로드한다.
 * 컴포넌트가 소유한 상태는 오직 `items`뿐이며, 부모에는 `onChange`로만 요약을 알린다.
 */
export function PhotoPicker({ onChange, disabled = false }: PhotoPickerProps) {
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 최신 items를 stale closure 없이 읽기 위한 ref. 비동기 업로드 콜백이 완료될 때
  // 그 사이 항목이 제거·리셋되지 않았는지 이것으로 확인한다.
  const itemsRef = useRef<PhotoItem[]>(items);
  itemsRef.current = items;

  // 제거된(목록에서 사라진) 항목의 업로드가 나중에 성공으로 도착하면 best-effort로
  // 폐기할 수 있도록, 제거 시점에 키를 기록해 둔다.
  const removedKeysRef = useRef<Set<string>>(new Set());

  // React StrictMode(개발 모드)는 effect를 mount → cleanup → 재mount 순으로 두 번 실행한다.
  // useRef(true) 초기값만 쓰면 cleanup에서 false로 내려간 뒤 재mount 시 아무도 다시
  // true로 되돌리지 않아, 실제로는 마운트된 상태에서도 모든 비동기 완료 콜백이
  // "언마운트됨"으로 오판되어 무시된다. 그래서 setup에서 명시적으로 true를 되돌린다.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 언마운트 시 아직 해제되지 않은 모든 미리보기 URL을 정리한다.
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
        if (item.status.kind === 'uploading') item.controller.abort();
      }
    };
  }, []);

  // 여러 번의 파일 선택과 재시도를 하나의 순서로 묶는 전역 순차 큐.
  // Promise 체인 하나로 구현해, handleFiles가 여러 번 호출되거나 재시도가 겹쳐도
  // 항상 이전에 큐잉된 업로드가 끝난 뒤에만 다음 업로드가 시작된다.
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());

  function enqueueUpload(item: PhotoItem) {
    uploadQueueRef.current = uploadQueueRef.current.then(() => uploadOne(item));
  }

  function emit(next: PhotoItem[]) {
    // itemsRef를 동기적으로 먼저 갱신한다. setState는 리렌더까지 반영이 미뤄지므로,
    // emit 직후 곧바로 시작하는 비동기 업로드 큐가 stale ref를 보고 항목이 사라졌다고
    // 오판하지 않게 한다.
    itemsRef.current = next;
    setItems(next);
    onChange(summarize(next));
  }

  function updateItem(key: string, status: PhotoItemStatus) {
    // 이 항목이 여전히 목록에 있을 때만 반영한다(제거·리셋 이후 도착하는 stale 응답 방지).
    const current = itemsRef.current;
    if (!current.some((item) => item.key === key)) return;
    const next = current.map((item) => (item.key === key ? { ...item, status } : item));
    emit(next);
  }

  async function uploadOne(item: PhotoItem) {
    if (!mountedRef.current || item.controller.signal.aborted || !itemsRef.current.some((current) => current.key === item.key)) return;
    try {
      const uploaded = await uploadRequestPhoto(item.file, item.controller.signal);
      // 항목이 이미 목록에서 제거된 뒤(또는 컴포넌트 언마운트 뒤) 늦게 성공한 경우:
      // 서버에는 사진이 pending으로 남아 있으므로 best-effort로 바로 폐기한다.
      const wasRemoved = removedKeysRef.current.has(item.key);
      const stillTracked = mountedRef.current && itemsRef.current.some((i) => i.key === item.key);
      if (wasRemoved || !stillTracked) {
        removedKeysRef.current.delete(item.key);
        deleteRequestPhoto(uploaded.id).catch(() => {});
        return;
      }
      updateItem(item.key, { kind: 'uploaded', id: uploaded.id });
    } catch (error) {
      removedKeysRef.current.delete(item.key);
      if (!mountedRef.current) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      updateItem(item.key, { kind: 'failed', message: uploadErrorMessage(error) });
    }
  }

  function handleFiles(fileList: FileList) {
    if (disabled) return;
    const incoming = Array.from(fileList);
    const remainingSlots = Math.max(0, MAX_PHOTOS - itemsRef.current.length);

    // 타입·크기는 파일 각각의 성질이므로 개수 제한과 무관하게 먼저 판정한다.
    let rejectedForSize = false;
    let rejectedForType = false;
    const validated: File[] = [];
    for (const file of incoming) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        rejectedForType = true;
        continue;
      }
      if (file.size > MAX_BYTES) {
        rejectedForSize = true;
        continue;
      }
      validated.push(file);
    }

    // 통과한 파일 중 남은 슬롯을 넘는 분량만 개수 초과로 거부한다.
    const accepted = validated.slice(0, remainingSlots);
    const rejectedForCount = validated.length > remainingSlots;

    const messages: string[] = [];
    if (rejectedForCount) messages.push('사진은 최대 5장까지 첨부할 수 있어요.');
    if (rejectedForSize) messages.push('3MB 이하 사진만 올릴 수 있어요.');
    if (rejectedForType) messages.push('JPG, PNG, WEBP 사진만 올릴 수 있어요.');
    setPickerError(messages.length > 0 ? messages.join(' ') : null);

    if (accepted.length === 0) return;

    const newItems: PhotoItem[] = accepted.map((file) => ({
      key: nextKey(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: { kind: 'uploading' },
      controller: new AbortController(),
    }));

    emit([...itemsRef.current, ...newItems]);

    // 이번 선택분도 기존 큐 뒤에 이어 붙인다. 여러 번 선택하거나 재시도와 섞여도
    // 전역적으로 한 번에 한 장씩만 업로드된다(설계서 7.2).
    for (const item of newItems) enqueueUpload(item);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const { files } = event.target;
    if (files && files.length > 0) handleFiles(files);
    // 같은 파일을 다시 선택해도 change가 발생하도록 값을 비운다.
    event.target.value = '';
  }

  function removeItem(key: string) {
    if (disabled) return;
    const target = itemsRef.current.find((item) => item.key === key);
    if (!target) return;

    if (target.status.kind === 'uploading') {
      target.controller.abort();
      // abort가 경합에서 져서(이미 서버가 성공으로 응답한 뒤라서) 업로드가 성공으로
      // 끝날 수 있다. 이 키를 기록해 두면 uploadOne이 그 늦은 성공을 감지해 폐기한다.
      removedKeysRef.current.add(key);
    }
    if (target.status.kind === 'uploaded') {
      // fire-and-forget: 실패해도 UI는 이미 제거된 상태를 유지한다(설계서 7.2).
      deleteRequestPhoto(target.status.id).catch(() => {});
    }
    URL.revokeObjectURL(target.previewUrl);
    emit(itemsRef.current.filter((item) => item.key !== key));
  }

  function retryItem(key: string) {
    if (disabled) return;
    const target = itemsRef.current.find((item) => item.key === key);
    if (!target) return;
    const controller = new AbortController();
    const retried: PhotoItem = { ...target, status: { kind: 'uploading' }, controller };
    emit(itemsRef.current.map((item) => (item.key === key ? retried : item)));
    // 재시도도 같은 전역 큐를 탄다: 새 선택이 먼저 큐잉돼 있었다면 그 뒤로 밀린다.
    enqueueUpload(retried);
  }

  const canAddMore = items.length < MAX_PHOTOS && !disabled;

  return (
    <div>
      <span className="text-sm font-bold text-stone-700">사진</span>
      <p className="mt-1 text-xs text-stone-500">
        JPG·PNG·WEBP 정지 이미지, 장당 3MB, 최대 5장. 첫 번째 사진이 대표 사진이 돼요. 사진의 위치
        정보 등 메타데이터는 자동으로 지워져요.
      </p>

      <div className="mt-3 flex flex-wrap gap-3">
        {items.map((item, index) => (
          <div
            key={item.key}
            className="relative w-24 shrink-0 overflow-hidden rounded-xl border border-stone-200 bg-stone-50"
          >
            {index === 0 ? (
              <span className="absolute left-1 top-1 z-10 rounded-full bg-potato-400 px-2 py-0.5 text-[10px] font-bold text-stone-900">
                대표
              </span>
            ) : null}
            <div className="aspect-square w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.previewUrl}
                alt={`사진 ${index + 1} 미리보기`}
                className="size-full object-cover"
              />
            </div>
            {item.status.kind === 'uploading' ? (
              <div
                className="absolute inset-0 grid place-items-center bg-white/70"
                aria-busy="true"
                aria-live="polite"
              >
                <span className="sr-only">사진 {index + 1} 업로드 중</span>
                <span className="size-5 animate-spin rounded-full border-2 border-stone-300 border-t-potato-500" aria-hidden="true" />
              </div>
            ) : null}
            {item.status.kind === 'failed' ? (
              <div className="absolute inset-x-0 bottom-0 bg-red-50/95 p-1 text-center text-[10px] font-semibold text-red-700">
                <p role="alert">{item.status.message}</p>
                <button
                  type="button"
                  onClick={() => retryItem(item.key)}
                  disabled={disabled}
                  className="mt-0.5 underline disabled:cursor-not-allowed disabled:no-underline disabled:text-red-300"
                >
                  다시 시도
                </button>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => removeItem(item.key)}
              disabled={disabled}
              aria-label={`사진 ${index + 1} 삭제`}
              className="absolute right-1 top-1 z-10 grid size-5 place-items-center rounded-full bg-stone-900/70 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <label
        htmlFor={inputId}
        aria-disabled={!canAddMore}
        className={`mt-3 flex min-h-14 w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm ${
          canAddMore
            ? 'border-stone-300 bg-stone-50 text-stone-600 hover:border-potato-300'
            : 'cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400'
        }`}
      >
        <span aria-hidden="true">📷</span>
        <span className="mt-1 font-semibold">사진 추가 ({items.length}/{MAX_PHOTOS})</span>
      </label>
      <input
        ref={fileInputRef}
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        disabled={!canAddMore}
        onChange={handleInputChange}
        className="sr-only"
      />

      {pickerError ? (
        <p className="mt-2 text-sm font-semibold text-red-600" role="alert">
          {pickerError}
        </p>
      ) : null}
    </div>
  );
}
