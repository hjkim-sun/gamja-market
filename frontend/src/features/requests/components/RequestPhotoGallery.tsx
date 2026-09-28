'use client';

import { useState } from 'react';

import type { RequestPhoto } from '@/types/request';

interface RequestPhotoGalleryProps {
  photos: RequestPhoto[];
  title: string;
}

/**
 * 설계서 7.4 — 상세 화면 사진 갤러리. 서버가 준 URL을 그대로 `<img src>`에 쓴다
 * (안전성 검사는 `src/lib/api/requests.ts`의 파싱 단계에서 이미 끝났다).
 */
export function RequestPhotoGallery({ photos, title }: RequestPhotoGalleryProps) {
  const [selected, setSelected] = useState(0);

  if (photos.length === 0) return null;

  const activeIndex = Math.min(selected, photos.length - 1);
  const active = photos[activeIndex];

  return (
    <div className="mt-6">
      <div className="aspect-[4/3] overflow-hidden rounded-2xl bg-stone-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={active.url}
          alt={`${title} 사진 ${activeIndex + 1}/${photos.length}`}
          className="size-full object-contain"
        />
      </div>
      {photos.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {photos.map((photo, index) => (
            <button
              key={photo.id}
              type="button"
              onClick={() => setSelected(index)}
              aria-pressed={index === activeIndex}
              aria-label={`사진 ${index + 1} / ${photos.length}`}
              className={`size-16 overflow-hidden rounded-lg border-2 transition ${
                index === activeIndex ? 'border-potato-400' : 'border-transparent'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.url} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
