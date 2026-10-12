// Port of apps/frontend/src/lib/components/profile-card.svelte
// The web popover is a bottom sheet here. <ProfileCard user>children</ProfileCard> opens it when tapped.
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import {
  MessageSquare,
  UserRoundArrowLeft,
  UserRoundCog,
  UserRoundMinus,
  UserRoundPlus,
  type LucideIcon,
} from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { dms } from '@/lib/dms';
import { friends, useFriends, type FriendStatus } from '@/lib/friends';
import { useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import type { Author } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

const friendActions: Record<FriendStatus, { label: string; icon: LucideIcon }> = {
  INCOMING: { label: 'Accept request', icon: UserRoundArrowLeft },
  OUTGOING: { label: 'Cancel request', icon: UserRoundCog },
  FRIEND: { label: 'Remove friend', icon: UserRoundMinus },
  NONE: { label: 'Add friend', icon: UserRoundPlus },
};

export function ProfileSheet({
  user,
  open,
  onClose,
}: {
  user: Author;
  open: boolean;
  onClose: () => void;
}) {
  const self = useSession((s) => s.user);
  const circleIcons = useSettings((s) => s.circleIcons);
  const friendStatus = useFriends((s) => s.statusFor(user.username, user.server));
  const friendshipUserId = useFriends((s) => s.userIdFor(user.username, user.server));
  const busyUserIds = useFriends((s) => s.busyUserIds);
  const name = user.displayName || user.username;
  const isSelf = user.username === self?.username && user.server === self?.homeserver;
  const busy =
    busyUserIds.includes(user.userId) ||
    (!!friendshipUserId && busyUserIds.includes(friendshipUserId));
  const canAddFriend = Boolean(user.userId) && user.userId !== self?.id && !user.isBot;
  const action = friendActions[friendStatus];

  const runFriendAction = () => {
    if (friendStatus === 'NONE') return void friends().request(user.userId, user.username, user.server);
    if (!friendshipUserId) return;
    if (friendStatus === 'INCOMING') return void friends().accept(friendshipUserId);
    if (friendStatus === 'OUTGOING') return void friends().remove(friendshipUserId);

    Alert.alert(`Remove ${name}?`, 'They will no longer be in your friends list.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void friends().remove(friendshipUserId) },
    ]);
  };

  const message = async () => {
    onClose();
    await dms().open(user.userId);
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <View
        className="aspect-[3/1] overflow-hidden bg-primary/20"
        style={user.avatarColor ? { backgroundColor: user.avatarColor } : undefined}
      >
        {user.bannerUrl && (
          <Image
            source={{ uri: user.bannerUrl }}
            contentFit="cover"
            style={{ width: '100%', height: '100%' }}
          />
        )}
      </View>

      <View className="px-4 pb-2">
        <View className="-mt-8 w-fit self-start">
          <Avatar
            src={user.avatarUrl}
            name={name}
            className="size-16 border-4 border-popover"
            bgColor={user.avatarColor}
          />
          {user.status && (
            <View
              accessibilityLabel={user.status === 'ONLINE' ? 'Online' : 'Offline'}
              className={cn(
                'absolute right-0 bottom-0 size-4 border-[3px] border-popover',
                user.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-muted-foreground/60',
                circleIcons && 'rounded-full'
              )}
            />
          )}
        </View>

        <View className="mt-2 flex-row items-center gap-2">
          <Text className="shrink text-lg font-semibold" numberOfLines={1}>
            {name}
          </Text>
          {user.isBot && (
            <View className="bg-primary/15 px-1.5 py-0.5">
              <Text className="text-[9px] font-bold tracking-wider text-primary">BOT</Text>
            </View>
          )}
        </View>
        <Text className="font-mono text-xs text-muted-foreground" numberOfLines={1}>
          @{user.username}:{user.server}
        </Text>

        {user.about ? (
          <View className="mt-3">
            <Text className="text-[10px] font-bold tracking-wider text-muted-foreground">
              ABOUT
            </Text>
            <Text className="mt-1 text-sm leading-5 text-foreground/80">{user.about}</Text>
          </View>
        ) : null}

        {!isSelf && (
          <View className="mt-4 flex-row gap-2">
            {user.userId && (
              <Button className="flex-1" onPress={message}>
                <Icon as={MessageSquare} size={16} className="text-primary-foreground" />
                <Text>Message</Text>
              </Button>
            )}
            {canAddFriend && (
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                onPress={() => {
                  void Haptics.selectionAsync();
                  runFriendAction();
                }}
              >
                <Icon
                  as={action.icon}
                  size={16}
                  className={friendStatus === 'FRIEND' ? 'text-destructive' : 'text-foreground'}
                />
                <Text className={friendStatus === 'FRIEND' ? 'text-destructive' : undefined}>
                  {action.label}
                </Text>
              </Button>
            )}
          </View>
        )}
      </View>
    </Sheet>
  );
}

export function ProfileCard({
  user,
  children,
  className,
}: {
  user: Author;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // the sheet is mounted on first tap only, so a long message list doesn't create one per message
  const [mounted, setMounted] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open profile of ${user.displayName || user.username}`}
        className={className}
        onPress={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        {children}
      </Pressable>
      {mounted && <ProfileSheet user={user} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
