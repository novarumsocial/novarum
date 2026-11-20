// Port of apps/frontend/src/lib/components/group-members.svelte
// The members of a group DM: the members modal on phones, the right column on tablets.
import { Crown, EllipsisVertical, LogOut, Settings, UserPlus, Users } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { BotBadge } from '@/components/bot-badge';
import { GroupSettingsDialog } from '@/components/group-settings-dialog';
import { NewDmDialog } from '@/components/new-dm-dialog';
import { ProfileCard } from '@/components/profile-card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { dms, type DmEntry } from '@/lib/dms';
import { friends, useFriends } from '@/lib/friends';
import { goHome } from '@/lib/navigation';
import { useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import type { Author } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

export function GroupMembers({ group }: { group: DmEntry }) {
  const insets = useSafeAreaInsets();
  const circleIcons = useSettings((s) => s.circleIcons);
  const me = useSession((s) => s.user);
  useFriends((s) => s.accepted); // re-render when someone goes online or offline
  const isOwner = !!me && group.ownerId === me.id;
  const members: Author[] = [
    ...(me ? [{ ...me, userId: me.id, server: me.homeserver } as Author] : []),
    ...group.participants.map(({ homeserver, ...user }) => ({ ...user, server: homeserver })),
  ];

  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [acting, setActing] = useState<Author | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: Promise<string | null>) {
    setActing(null);
    setError(await action);
  }

  async function leave() {
    const failed = await dms().leave(group.id);
    setError(failed);
    if (!failed) goHome();
  }

  return (
    <View className="flex-1 bg-sidebar">
      <View className="min-h-12 flex-row items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel="Add people"
          onPress={() => setAddOpen(true)}
        >
          <Icon as={UserPlus} size={18} />
        </Button>
        {isOwner && (
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel="Group settings"
            onPress={() => setSettingsOpen(true)}
          >
            <Icon as={Settings} size={18} />
          </Button>
        )}
        <View className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel="Leave group"
          onPress={() => void leave()}
        >
          <Icon as={LogOut} size={18} />
        </Button>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 12 }}>
        <View className="min-h-9 flex-row items-center gap-1">
          <Icon as={Users} size={14} className="text-muted-foreground" />
          <Text className="text-xs font-semibold text-muted-foreground">
            Members - {members.length}
          </Text>
        </View>
        {error && <Text className="pb-2 text-xs text-destructive">{error}</Text>}
        {members.map((member) => {
          const name = member.displayName || member.username;
          const self = member.userId === me?.id;
          const offline = !self && !friends().isOnline(member.userId);
          return (
            <View key={member.userId} className="flex-row items-center">
              <ProfileCard user={member} className="flex-1">
                <View className={cn('min-h-11 flex-row items-center gap-2 px-1', offline && 'opacity-60')}>
                  <View>
                    <Avatar
                      src={member.avatarUrl}
                      name={name}
                      bgColor={member.avatarColor}
                      className="size-8"
                    />
                    {(self || friends().isOnline(member.userId)) && (
                      <View
                        className={cn(
                          'absolute -right-px -bottom-px size-3 border-2 border-sidebar bg-emerald-500',
                          circleIcons && 'rounded-full'
                        )}
                      />
                    )}
                  </View>
                  <Text numberOfLines={1} className="shrink text-sm">
                    {name}
                  </Text>
                  {member.isBot && <BotBadge />}
                  {member.userId === group.ownerId && (
                    <Icon
                      as={Crown}
                      size={14}
                      className="text-amber-500"
                      accessibilityLabel="Group owner"
                    />
                  )}
                </View>
              </ProfileCard>
              {isOwner && !self && (
                <Button
                  variant="ghost"
                  size="icon"
                  accessibilityLabel={`Manage ${name}`}
                  onPress={() => setActing(member)}
                >
                  <Icon as={EllipsisVertical} size={16} className="text-muted-foreground" />
                </Button>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Sheet open={!!acting} onClose={() => setActing(null)}>
        {acting && !acting.isBot && (
          <SheetItem
            icon={Crown}
            label="Make Group Owner"
            onPress={() => void act(dms().transferOwner(group.id, acting.userId))}
          />
        )}
        {acting && (
          <SheetItem
            icon={LogOut}
            label="Remove from Group"
            destructive
            onPress={() => void act(dms().kick(group.id, acting.userId))}
          />
        )}
      </Sheet>
      <NewDmDialog open={addOpen} onClose={() => setAddOpen(false)} addTo={group} />
      {isOwner && (
        <GroupSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          group={group}
        />
      )}
    </View>
  );
}
