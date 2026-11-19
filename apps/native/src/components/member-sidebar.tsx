// Port of apps/frontend/src/lib/components/member-sidebar.svelte
// Differences: a search field filters by name or handle, and each row shows the handle (display names repeat);
// the web's right-click menu is a long-press sheet with just Kick and Ban, shown to those who may use them
import { FlashList } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { Ban, UserRoundX, Users } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { ProfileCard } from '@/components/profile-card';
import { SearchField } from '@/components/search-field';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { BotBadge } from '@/components/bot-badge';
import { selectCurrentServer, useChat } from '@/lib/chat-state';
import { canModerate, moderation } from '@/lib/moderation';
import { useSettings } from '@/lib/settings';
import type { Author } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

type Row = { kind: 'title'; label: string; online: boolean } | { kind: 'member'; member: Author };

const handle = (member: Author) => `@${member.username}:${member.server}`;

// the members screen on phones, the right column next to the chat on tablets
export function MemberSidebar({ members }: { members: Author[] }) {
  const circleIcons = useSettings((s) => s.circleIcons);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const server = useChat(selectCurrentServer);
  const [target, setTarget] = useState<Author | null>(null);
  const act = (kind: 'kick' | 'ban') => {
    if (server && target) moderation().ask({ kind, server, member: target });
    setTarget(null);
  };

  const needle = query.trim().toLowerCase();
  const matching = needle
    ? members.filter((member) =>
        `${member.displayName ?? ''} ${handle(member)}`.toLowerCase().includes(needle)
      )
    : members;
  const online = matching.filter((member) => member.status !== 'OFFLINE');
  const offline = matching.filter((member) => member.status === 'OFFLINE');
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
      <FlashList
        data={rows}
        getItemType={(row) => row.kind}
        keyExtractor={(row) => (row.kind === 'title' ? row.label : row.member.userId)}
        contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 12 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          members.length > 8 ? (
            <SearchField
              placeholder="Search members"
              value={query}
              onChangeText={setQuery}
              className="mb-2"
            />
          ) : null
        }
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
          const offline = member.status === 'OFFLINE';
          return (
            <ProfileCard
              user={member}
              onLongPress={
                server && canModerate(server, member)
                  ? () => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setTarget(member);
                    }
                  : undefined
              }
            >
              <View className="min-h-14 flex-row items-center gap-3 px-1">
                <View className={cn(offline && 'opacity-60')}>
                  <Avatar
                    src={member.avatarUrl}
                    name={name}
                    bgColor={member.avatarColor}
                    className="size-9"
                  />
                  {!offline && (
                    <View
                      className={cn(
                        'absolute -right-0.5 -bottom-0.5 size-3.5 border-2 border-sidebar bg-emerald-500',
                        circleIcons && 'rounded-full'
                      )}
                    />
                  )}
                </View>
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-1.5">
                    <Text
                      numberOfLines={1}
                      className={cn('shrink text-sm', offline && 'text-muted-foreground')}
                    >
                      {name}
                    </Text>
                    {member.isBot && <BotBadge />}
                  </View>
                  <Text numberOfLines={1} className="text-xs text-muted-foreground">
                    {handle(member)}
                  </Text>
                </View>
              </View>
            </ProfileCard>
          );
        }}
      />
      <Sheet
        open={!!target}
        onClose={() => setTarget(null)}
        title={target ? target.displayName || target.username : undefined}
      >
        <SheetItem icon={UserRoundX} label="Kick" destructive onPress={() => act('kick')} />
        <SheetItem icon={Ban} label="Ban" destructive onPress={() => act('ban')} />
      </Sheet>
    </View>
  );
}
