// The members of the open guild channel or group DM, as a modal over it (the web's right column)
import { GroupMembers } from '@/components/group-members';
import { MemberSidebar } from '@/components/member-sidebar';
import { selectActiveChannel, useChat } from '@/lib/chat-state';
import { useDms } from '@/lib/dms';

export default function Members() {
  const members = useChat((s) => s.members);
  const activeChannel = useChat(selectActiveChannel);
  const group = useDms((s) =>
    s.list.find((dm) => dm.id === activeChannel && dm.type === 'GROUP_DM')
  );
  return group ? <GroupMembers group={group} /> : <MemberSidebar members={members} />;
}
