// The members of the open guild channel or group DM, pushed over it (the web's right column)
import { View } from 'react-native';
import { GroupMembers } from '@/components/group-members';
import { MemberSidebar } from '@/components/member-sidebar';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { selectActiveChannel, useChat } from '@/lib/chat-state';
import { useDms } from '@/lib/dms';

export default function Members() {
  const members = useChat((s) => s.members);
  const activeChannel = useChat(selectActiveChannel);
  const group = useDms((s) =>
    s.list.find((dm) => dm.id === activeChannel && dm.type === 'GROUP_DM')
  );
  return (
    <View className="flex-1 bg-sidebar">
      <ScreenHeader>
        <Text role="heading" className="text-base font-semibold">
          Members
        </Text>
      </ScreenHeader>
      {group ? <GroupMembers group={group} /> : <MemberSidebar members={members} />}
    </View>
  );
}
