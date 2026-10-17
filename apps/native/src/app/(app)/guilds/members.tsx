// The members of the open guild channel, as a modal over it (the web's right column)
import { MemberSidebar } from '@/components/member-sidebar';
import { useChat } from '@/lib/chat-state';

export default function Members() {
  return <MemberSidebar members={useChat((s) => s.members)} />;
}
