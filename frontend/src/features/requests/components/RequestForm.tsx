'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { FormAlert } from '@/features/auth/components/FieldError';
import { deleteRequestPhoto } from '@/lib/api/requestPhotos';
import { createRequest } from '@/lib/api/requests';
import { requestCategories } from '@/features/requests/categories';
import { PhotoPicker, type PhotoPickerSummary } from '@/features/requests/components/PhotoPicker';
import { ApiError } from '@/types/api';
import type { ProductCondition } from '@/types/request';

type FieldName =
  | 'title'
  | 'category'
  | 'description'
  | 'priceMin'
  | 'priceMax'
  | 'condition'
  | 'region'
  | 'photos';

type FormErrors = Partial<Record<FieldName, string>>;

const conditions: Array<{ value: ProductCondition; label: string; description: string }> = [
  { value: 'any', label: '상관없음', description: '어떤 상태든 제안받아요' },
  { value: 'new', label: '새상품', description: '미개봉 또는 미사용' },
  { value: 'like_new', label: '거의 새것', description: '사용감이 거의 없음' },
  { value: 'used', label: '중고', description: '사용감이 있어도 괜찮음' },
];

const inputClassName =
  'mt-2 min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-base text-stone-900 outline-none placeholder:text-stone-400 focus:border-potato-400 focus:ring-2 focus:ring-potato-200 aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-100';

function ErrorMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-2 text-sm font-semibold text-red-600" role="alert">
      {message}
    </p>
  );
}

const initialPhotoSummary: PhotoPickerSummary = { uploadedIds: [], pendingCount: 0, failedCount: 0 };

export function RequestForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({});
  const [formAlert, setFormAlert] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [photoSummary, setPhotoSummary] = useState<PhotoPickerSummary>(initialPhotoSummary);
  const [photoPickerResetKey, setPhotoPickerResetKey] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get('title') ?? '').trim();
    const category = String(data.get('category') ?? '');
    const description = String(data.get('description') ?? '').trim();
    const priceMinRaw = String(data.get('priceMin') ?? '');
    const priceMaxRaw = String(data.get('priceMax') ?? '');
    const priceMin = Number(priceMinRaw);
    const priceMax = Number(priceMaxRaw);
    const condition = String(data.get('condition') ?? '') as ProductCondition | '';
    const region = String(data.get('region') ?? '').trim();
    const nextErrors: FormErrors = {};

    if (title.length < 2 || title.length > 60) {
      nextErrors.title = '제목은 2자 이상 60자 이하로 입력해 주세요.';
    }
    if (!category) nextErrors.category = '카테고리를 선택해 주세요.';
    if (description.length < 10 || description.length > 1000) {
      nextErrors.description = '원하는 스펙은 10자 이상 1000자 이하로 입력해 주세요.';
    }
    if (!priceMinRaw || !Number.isFinite(priceMin) || priceMin < 0) {
      nextErrors.priceMin = '최소가는 0원 이상으로 입력해 주세요.';
    }
    if (!priceMaxRaw || !Number.isFinite(priceMax) || priceMax < 0) {
      nextErrors.priceMax = '최대가는 0원 이상으로 입력해 주세요.';
    }
    if (!nextErrors.priceMin && !nextErrors.priceMax && priceMin > priceMax) {
      nextErrors.priceMax = '최대가는 최소가보다 크거나 같아야 합니다.';
    }
    if (!condition) nextErrors.condition = '희망 상태를 선택해 주세요.';
    if (!region) nextErrors.region = '거래 지역을 입력해 주세요.';
    if (photoSummary.failedCount > 0) {
      nextErrors.photos = '업로드에 실패한 사진을 다시 시도하거나 삭제해 주세요.';
    }

    setErrors(nextErrors);
    setFormAlert(null);
    setReauthRequired(false);

    if (Object.keys(nextErrors).length > 0) return;
    // 버튼 disabled는 UI 힌트일 뿐이다. 트리거된 제출 이벤트(예: Enter 키 제출, 경합 중
    // 재렌더 이전의 클릭)가 버튼 상태를 우회할 수 있으므로 여기서도 다시 막는다.
    if (photoSummary.pendingCount > 0) return;

    setSubmitting(true);
    try {
      const created = await createRequest({
        title,
        category,
        description,
        priceMin,
        priceMax,
        condition: condition as ProductCondition,
        region,
        photoIds: photoSummary.uploadedIds,
      });
      router.push(`/requests/${created.id}`);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === 'VALIDATION_ERROR') {
          const { photoIds: photosMessage, ...rest } = caught.fields;
          const serverErrors: FormErrors = { ...rest };
          if (photosMessage) {
            serverErrors.photos = photosMessage;
            // 만료·재사용된 사진은 되살릴 수 없으므로 항목을 모두 비운다(설계서 7.3).
            setPhotoPickerResetKey((key) => key + 1);
            setPhotoSummary(initialPhotoSummary);
          }
          setErrors(serverErrors);
          if (Object.keys(serverErrors).length === 0) setFormAlert(caught.message);
        } else if (caught.code === 'UNAUTHENTICATED') {
          setReauthRequired(true);
        } else if (caught.code === 'INVALID_ORIGIN') {
          setFormAlert('요청을 처리할 수 없습니다. 새로고침 후 다시 시도해 주세요.');
        } else {
          setFormAlert('잠시 후 다시 시도해 주세요.');
        }
      } else {
        setFormAlert('잠시 후 다시 시도해 주세요.');
      }
      setSubmitting(false);
    }
  }

  function handleReset() {
    if (submitting) return;
    setErrors({});
    setFormAlert(null);
    setReauthRequired(false);
    // 이미 업로드된 사진은 fire-and-forget으로 폐기하고, PhotoPicker는 key를 바꿔 새로 마운트한다.
    for (const id of photoSummary.uploadedIds) {
      deleteRequestPhoto(id).catch(() => {});
    }
    setPhotoPickerResetKey((key) => key + 1);
    setPhotoSummary(initialPhotoSummary);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-8">
      <FormAlert message={formAlert} />

      {reauthRequired ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold leading-6 text-red-700" role="alert">
          다시 로그인해 주세요.{' '}
          <Link href="/login?next=/requests/new" className="underline">
            다시 로그인
          </Link>
        </div>
      ) : null}

      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card sm:p-8" aria-labelledby="basic-info-heading">
        <h2 id="basic-info-heading" className="text-xl font-black text-stone-900">무엇을 찾고 있나요?</h2>
        <p className="mt-1 text-sm text-stone-500">판매자가 물건을 바로 알아볼 수 있게 구체적으로 적어주세요.</p>

        <div className="mt-7 space-y-6">
          <div>
            <label htmlFor="title" className="text-sm font-bold text-stone-700">제목 <span className="text-red-500" aria-hidden="true">*</span></label>
            <input
              id="title"
              name="title"
              type="text"
              minLength={2}
              maxLength={60}
              placeholder="예: 아이패드 프로 11인치 M2 구합니다"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? 'title-error' : undefined}
              className={inputClassName}
            />
            <ErrorMessage id="title-error" message={errors.title} />
          </div>

          <div>
            <label htmlFor="category" className="text-sm font-bold text-stone-700">카테고리 <span className="text-red-500" aria-hidden="true">*</span></label>
            <select
              id="category"
              name="category"
              defaultValue=""
              aria-invalid={Boolean(errors.category)}
              aria-describedby={errors.category ? 'category-error' : undefined}
              className={inputClassName}
            >
              <option value="" disabled>카테고리를 선택하세요</option>
              {requestCategories.map((category) => <option key={category}>{category}</option>)}
            </select>
            <ErrorMessage id="category-error" message={errors.category} />
          </div>

          <div>
            <label htmlFor="description" className="text-sm font-bold text-stone-700">원하는 스펙 <span className="text-red-500" aria-hidden="true">*</span></label>
            <textarea
              id="description"
              name="description"
              rows={7}
              minLength={10}
              maxLength={1000}
              placeholder="모델, 색상, 용량, 꼭 필요한 구성품 등 원하는 조건을 알려주세요."
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'description-error' : 'description-help'}
              className={`${inputClassName} resize-y py-3 leading-7`}
            />
            <p id="description-help" className="mt-2 text-xs text-stone-400">10~1000자</p>
            <ErrorMessage id="description-error" message={errors.description} />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-card sm:p-8" aria-labelledby="conditions-heading">
        <h2 id="conditions-heading" className="text-xl font-black text-stone-900">거래 조건을 알려주세요</h2>
        <div className="mt-7 space-y-7">
          <fieldset>
            <legend className="text-sm font-bold text-stone-700">희망 가격대 <span className="text-red-500" aria-hidden="true">*</span></legend>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
              <div>
                <label htmlFor="priceMin" className="sr-only">희망 최소가</label>
                <div className="relative">
                  <input
                    id="priceMin"
                    name="priceMin"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="최소가"
                    aria-invalid={Boolean(errors.priceMin)}
                    aria-describedby={errors.priceMin ? 'price-min-error' : undefined}
                    className={`${inputClassName} mt-0 pr-9`}
                  />
                  <span className="pointer-events-none absolute right-3 top-3 text-stone-400">원</span>
                </div>
              </div>
              <span className="text-stone-400" aria-hidden="true">~</span>
              <div>
                <label htmlFor="priceMax" className="sr-only">희망 최대가</label>
                <div className="relative">
                  <input
                    id="priceMax"
                    name="priceMax"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="최대가"
                    aria-invalid={Boolean(errors.priceMax)}
                    aria-describedby={errors.priceMax ? 'price-max-error' : undefined}
                    className={`${inputClassName} mt-0 pr-9`}
                  />
                  <span className="pointer-events-none absolute right-3 top-3 text-stone-400">원</span>
                </div>
              </div>
            </div>
            <ErrorMessage id="price-min-error" message={errors.priceMin} />
            <ErrorMessage id="price-max-error" message={errors.priceMax} />
          </fieldset>

          <fieldset aria-describedby={errors.condition ? 'condition-error' : undefined}>
            <legend className="text-sm font-bold text-stone-700">희망 상태 <span className="text-red-500" aria-hidden="true">*</span></legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {conditions.map((condition) => (
                <label key={condition.value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 p-4 transition hover:border-potato-300 has-[:checked]:border-potato-400 has-[:checked]:bg-potato-50">
                  <input type="radio" name="condition" value={condition.value} className="mt-1 size-4 accent-potato-500" />
                  <span>
                    <span className="block text-sm font-bold text-stone-800">{condition.label}</span>
                    <span className="mt-0.5 block text-xs text-stone-500">{condition.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <ErrorMessage id="condition-error" message={errors.condition} />
          </fieldset>

          <div>
            <label htmlFor="region" className="text-sm font-bold text-stone-700">거래 지역 <span className="text-red-500" aria-hidden="true">*</span></label>
            <input
              id="region"
              name="region"
              type="text"
              placeholder="예: 서울 강남구"
              aria-invalid={Boolean(errors.region)}
              aria-describedby={errors.region ? 'region-error' : undefined}
              className={inputClassName}
            />
            <ErrorMessage id="region-error" message={errors.region} />
          </div>

          <div>
            <PhotoPicker
              key={photoPickerResetKey}
              onChange={setPhotoSummary}
              disabled={submitting}
            />
            <ErrorMessage id="photos-error" message={errors.photos} />
          </div>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
        {photoSummary.pendingCount > 0 ? (
          <p className="text-sm font-semibold text-stone-500 sm:mr-auto">
            사진 업로드가 끝나면 등록할 수 있어요.
          </p>
        ) : null}
        <Button type="reset" disabled={submitting} variant="secondary" className="sm:min-w-28" onClick={handleReset}>
          초기화
        </Button>
        <Button
          type="submit"
          disabled={submitting || photoSummary.pendingCount > 0}
          className="sm:min-w-48"
        >
          {submitting ? '등록 중…' : '구매요청 등록'}
        </Button>
      </div>
    </form>
  );
}
