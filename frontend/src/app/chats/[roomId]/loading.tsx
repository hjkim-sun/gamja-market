export default function ChatRoomLoading() {
  return (
    <div className="mx-auto max-w-[800px] px-4 py-9 sm:px-6 sm:py-12">
      <div className="h-[420px] animate-pulse rounded-2xl border border-stone-200 bg-white" aria-label="채팅방 불러오는 중" role="status" />
    </div>
  );
}
