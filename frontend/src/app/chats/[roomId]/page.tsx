import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { ChatRoomView } from '@/features/chat/components/ChatRoomView';
import { getChatRoom } from '@/lib/api/applications';
import { listMessages } from '@/lib/api/chat';
import { resolveServerApiBase } from '@/lib/api/serverBase';
import { ApiError } from '@/types/api';

export const dynamic = 'force-dynamic';

interface ChatRoomPageProps {
  params: Promise<{ roomId: string }>;
}

export async function generateMetadata({ params }: ChatRoomPageProps): Promise<Metadata> {
  const { roomId } = await params;
  try {
    const cookie = (await headers()).get('cookie') ?? undefined;
    const room = await getChatRoom(roomId, { baseUrl: resolveServerApiBase(), cookie });
    return { title: `${room.request.title} 채팅방` };
  } catch {
    return { title: '채팅방' };
  }
}

export default async function ChatRoomPage({ params }: ChatRoomPageProps) {
  const { roomId } = await params;
  const cookie = (await headers()).get('cookie') ?? undefined;

  const baseUrl = resolveServerApiBase();
  // 메시지 SSR 실패는 페이지를 깨지 않는다. 클라이언트의 첫 폴링이 다시 시도한다(설계서 P1).
  const messagesPromise = listMessages(roomId, { limit: 100, baseUrl, cookie }).catch(() => null);

  let room;
  try {
    room = await getChatRoom(roomId, { baseUrl, cookie });
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
      redirect(`/login?next=/chats/${roomId}`);
    }
    if (caught instanceof ApiError && (caught.code === 'NOT_FOUND' || caught.code === 'VALIDATION_ERROR')) {
      notFound();
    }
    throw caught;
  }

  const initialMessages = await messagesPromise;

  return (
    <div className="mx-auto max-w-[800px] px-4 py-9 sm:px-6 sm:py-12">
      <ChatRoomView room={room} initialMessages={initialMessages} />
    </div>
  );
}
