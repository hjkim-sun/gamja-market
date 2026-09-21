export default function HomeLoading() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6 sm:py-14">
      <div className="h-96 animate-pulse rounded-2xl border border-stone-200 bg-white" aria-label="구매요청 불러오는 중" role="status" />
    </div>
  );
}
