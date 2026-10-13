const STARS = [1, 2, 3, 4, 5] as const;

/** 별점은 색만으로 전달하지 않는다. 시각 장치는 숨기고 “5점 만점에 4점” 텍스트를 함께 둔다(설계서 11.6). */
export function RatingStars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center">
      <span aria-hidden="true" className="text-lg leading-none tracking-wider text-potato-500">
        {STARS.map((value) => (value <= rating ? '★' : '☆')).join('')}
      </span>
      <span className="sr-only">5점 만점에 {rating}점</span>
    </span>
  );
}
