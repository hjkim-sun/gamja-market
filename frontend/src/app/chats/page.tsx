import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { ChatRoomList } from '@/features/chat/components/ChatRoomList';
import { listChatRooms } from '@/lib/api/chat';
import { resolveServerApiBase } from '@/lib/api/serverBase';
import { ApiError } from '@/types/api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '채팅' };

export default async function ChatsPage() {
  const cookie = (await headers()).get('cookie') ?? undefined;

  let list;
  try {
    list = await listChatRooms({ baseUrl: resolveServerApiBase(), cookie });
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
      redirect('/login?next=/chats');
    }
    throw caught;
  }

  return (
    <div className="mx-auto max-w-[800px] px-4 py-9 sm:px-6 sm:py-12">
      <p className="text-sm font-bold text-leaf-700">거래 협의</p>
      <h1 className="mt-1 mb-6 text-3xl font-black tracking-tight text-stone-950">내 채팅</h1>
      <ChatRoomList items={list.items} />
    </div>
  );
}
