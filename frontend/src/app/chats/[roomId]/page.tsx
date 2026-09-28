import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { ChatRoomView } from '@/features/chat/components/ChatRoomView';
import { getChatRoom } from '@/lib/api/applications';
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

  let room;
  try {
    room = await getChatRoom(roomId, { baseUrl: resolveServerApiBase(), cookie });
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
      redirect(`/login?next=/chats/${roomId}`);
    }
    if (caught instanceof ApiError && (caught.code === 'NOT_FOUND' || caught.code === 'VALIDATION_ERROR')) {
      notFound();
    }
    throw caught;
  }

  return (
    <div className="mx-auto max-w-[800px] px-4 py-9 sm:px-6 sm:py-12">
      <ChatRoomView room={room} />
    </div>
  );
}
