// Port of apps/frontend/src/lib/components/member-sidebar.svelte
import { FlashList } from '@shopify/flash-list';
import { Users } from 'lucide-react-native';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { ProfileCard } from '@/components/profile-card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSettings } from '@/lib/settings';
import type { Author, Server } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

type Row = { kind: 'title'; label: string; online: boolean } | { kind: 'member'; member: Author };

export function MemberSidebar({ members }: { server: Server; members: Author[] }) {
  const insets = useSafeAreaInsets();
  const showMemberList = useSettings((s) => s.showMemberList);
  const circleIcons = useSettings((s) => s.circleIcons);
  if (!showMemberList) return null;

  const online = members.filter((member) => member.status !== 'OFFLINE');
  const offline = members.filter((member) => member.status === 'OFFLINE');
  const rows: Row[] = [
    { kind: 'title', label: `Online - ${online.length}`, online: true },
    ...online.map((member) => ({ kind: 'member' as const, member })),
    ...(offline.length > 0
      ? [
          { kind: 'title' as const, label: `Offline - ${offline.length}`, online: false },
          ...offline.map((member) => ({ kind: 'member' as const, member })),
        ]
      : []),
  ];

  return (
    <View className="flex-1 bg-sidebar">
      <View className="shrink-0 border-b border-border" style={{ minHeight: 48 + insets.top }} />
      <FlashList
        data={rows}
        getItemType={(row) => row.kind}
        keyExtractor={(row) => (row.kind === 'title' ? row.label : row.member.userId)}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => {
          if (item.kind === 'title') {
            return (
              <View className={cn('min-h-9 flex-row items-center gap-1', !item.online && 'mt-3')}>
                {item.online && <Icon as={Users} size={14} className="text-muted-foreground" />}
                <Text className="text-xs font-semibold text-muted-foreground">{item.label}</Text>
              </View>
            );
          }
          const { member } = item;
          const name = member.displayName || member.username;
          return (
            <ProfileCard user={member}>
              <View
                className={cn(
                  'min-h-11 flex-row items-center gap-2 px-1',
                  member.status === 'OFFLINE' && 'opacity-50'
                )}
              >
                <View>
                  <Avatar
                    src={member.avatarUrl}
                    name={name}
                    bgColor={member.avatarColor}
                    className="size-8"
                  />
                  {member.status !== 'OFFLINE' && (
                    <View
                      className={cn(
                        'absolute -right-px -bottom-px size-3 border-2 border-sidebar bg-emerald-500',
                        circleIcons && 'rounded-full'
                      )}
                    />
                  )}
                </View>
                <Text numberOfLines={1} className="flex-1 text-sm">
                  {name}
                </Text>
              </View>
            </ProfileCard>
          );
        }}
      />
    </View>
  );
}
