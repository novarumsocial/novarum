// The members of the open guild channel, pushed over it (the web's right column)
import { View } from 'react-native';
import { MemberSidebar } from '@/components/member-sidebar';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useChat } from '@/lib/chat-state';

export default function Members() {
  const members = useChat((s) => s.members);
  return (
    <View className="flex-1 bg-sidebar">
      <ScreenHeader>
        <Text role="heading" className="text-base font-semibold">
          Members
        </Text>
      </ScreenHeader>
      <MemberSidebar members={members} />
    </View>
  );
}
