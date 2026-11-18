// Port of apps/frontend/src/lib/components/user-area.svelte, reshaped for a phone: the hub's bottom tab bar.
// Differences: the desktop user bar (name, mute, deafen, settings gear) is gone. Mute, deafen and leave only show
// in the call row above the tabs while you are in a call. The tabs are Messages (this hub), Friends and You
// (settings; long-press it to switch accounts, like the account popover on the web). The noise suppression /
// mic test popover lives in settings > Voice & audio.
import { ConnectionState } from 'livekit-client';
import { router } from 'expo-router';
import {
  HeadphoneOff,
  Headphones,
  MessageCircle,
  Mic,
  MicOff,
  PhoneOff,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
  Users,
  type LucideIcon,
} from 'lucide-react-native';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AccountSwitcher } from '@/components/account-switcher';
import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { channelPath } from '@/lib/chat-state';
import { useFriends } from '@/lib/friends';
import { goto } from '@/lib/navigation';
import type { SessionUser } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { selectConnected, selectConnecting, useVoice, voice } from '@/lib/voice';

const tiers = [
  { max: 60, icon: Signal, text: 'text-emerald-400' },
  { max: 120, icon: SignalHigh, text: 'text-lime-400' },
  { max: 200, icon: SignalMedium, text: 'text-amber-400' },
  { max: Infinity, icon: SignalLow, text: 'text-rose-400' },
];
const connectingTier = { icon: SignalZero, text: 'text-amber-400' };

function CallButton({
  label,
  icon,
  active,
  danger,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      onPress={onPress}
      className={cn(
        'size-12 items-center justify-center',
        danger ? 'bg-rose-600 active:opacity-80' : active ? 'bg-rose-500/15' : 'active:bg-accent',
        circleIcons && 'rounded-full'
      )}
    >
      <Icon
        as={icon}
        size={20}
        className={danger ? 'text-white' : active ? 'text-rose-400' : 'text-foreground'}
      />
    </Pressable>
  );
}

function CallRow({
  user,
  voiceChannelName,
  onLeaveVoice,
}: {
  user: SessionUser;
  voiceChannelName: string | null;
  onLeaveVoice: () => void;
}) {
  const connecting = useVoice(selectConnecting);
  const connectionState = useVoice((s) => s.connectionState);
  const room = useVoice((s) => s.room);
  const channelId = useVoice((s) => s.channelId);
  const selfMuted = useVoice((s) => s.selfMuted);
  const selfDeafened = useVoice((s) => s.selfDeafened);
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    setLatency(null);
    if (connecting || !room) return;
    // Media-path RTT from the active ICE pair; the signal client's rtt runs over the
    // WebSocket and includes proxy/TLS/event-loop delay.
    const update = async () => {
      const pc = room.engine.pcManager;
      const stats = await (pc?.subscriber ?? pc?.publisher)?.getStats();
      stats?.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null)
          setLatency(Math.round(s.currentRoundTripTime * 1000));
      });
    };
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [connecting, room]);

  const reconnecting =
    connectionState === ConnectionState.Reconnecting ||
    connectionState === ConnectionState.SignalReconnecting;
  const tier = connecting
    ? connectingTier
    : (tiers.find((item) => (latency ?? 0) < item.max) ?? tiers[0]!);
  const status = reconnecting ? 'Reconnecting' : connecting ? 'Connecting' : 'Voice connected';
  const name = voiceChannelName ?? 'Voice channel';

  return (
    <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${status}, ${name}${latency !== null ? `, ${latency} milliseconds` : ''}. Open the call`}
        onPress={() => channelId && goto(channelPath(channelId))}
        className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2.5 px-2 active:opacity-70"
      >
        <Icon as={tier.icon} size={18} className={tier.text} />
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={cn(
              'text-sm font-semibold',
              connecting || reconnecting ? 'text-amber-400' : 'text-emerald-400'
            )}
          >
            {status}
            {latency !== null && !connecting ? (
              <Text className="text-xs font-normal text-muted-foreground"> · {latency}ms</Text>
            ) : null}
          </Text>
          <Text numberOfLines={1} className="text-sm text-muted-foreground">
            {name}
          </Text>
        </View>
      </Pressable>
      <CallButton
        // deafened also mutes, so the button says what tapping it will do
        label={selfDeafened ? 'Unmute (also undeafens)' : selfMuted ? 'Unmute' : 'Mute'}
        icon={selfMuted || selfDeafened ? MicOff : Mic}
        active={selfMuted || selfDeafened}
        onPress={() =>
          void (selfDeafened ? voice().setDeafened(false) : voice().setMuted(!selfMuted))
        }
      />
      <CallButton
        label={selfDeafened ? 'Undeafen' : 'Deafen'}
        icon={selfDeafened ? HeadphoneOff : Headphones}
        active={selfDeafened}
        onPress={() => void voice().setDeafened(!selfDeafened)}
      />
      <View className="w-2" />
      <CallButton label="Leave call" icon={PhoneOff} danger onPress={onLeaveVoice} />
    </View>
  );
}

function Tab({
  label,
  active,
  badge,
  onPress,
  onLongPress,
  hint,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  onPress: () => void;
  onLongPress?: () => void;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Pressable
      role="tab"
      accessibilityLabel={badge ? `${label}, ${badge} pending` : label}
      accessibilityHint={hint}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      onLongPress={onLongPress}
      className="min-h-14 flex-1 items-center justify-center gap-0.5 active:opacity-70"
    >
      <View>
        {children}
        {badge ? (
          <View className="absolute -top-1.5 -right-3 h-5 min-w-5 items-center justify-center rounded-full bg-sidebar-primary px-1">
            <Text className="text-xs leading-none font-bold text-sidebar-primary-foreground">
              {badge > 99 ? '99+' : badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        className={cn(
          'text-xs',
          active ? 'font-semibold text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// memo: the hub re-renders on every server switch, this bar doesn't need to
export const UserArea = memo(function UserArea({
  user,
  voiceChannelName,
  onLeaveVoice,
  onMessages,
}: {
  user: SessionUser;
  voiceChannelName: string | null;
  onLeaveVoice: () => void;
  onMessages: () => void;
}) {
  const insets = useSafeAreaInsets();
  const connected = useVoice(selectConnected);
  const connecting = useVoice(selectConnecting);
  const requests = useFriends((s) => s.incoming.length);
  const circleIcons = useSettings((s) => s.circleIcons);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const name = user.displayName || user.username;

  return (
    <View
      className="shrink-0 border-t border-border bg-sidebar"
      style={{ paddingBottom: insets.bottom }}
    >
      {(connected || connecting) && (
        <CallRow user={user} voiceChannelName={voiceChannelName} onLeaveVoice={onLeaveVoice} />
      )}
      <View role="tablist" className="flex-row">
        <Tab label="Messages" active onPress={onMessages}>
          <Icon as={MessageCircle} size={22} className="text-foreground" />
        </Tab>
        <Tab label="Friends" badge={requests} onPress={() => goto('/guilds/friends')}>
          <Icon as={Users} size={22} className="text-muted-foreground" />
        </Tab>
        <Tab
          label="You"
          hint="Long-press to switch accounts"
          onPress={() => router.push('/settings')}
          onLongPress={() => setSwitcherOpen(true)}
        >
          <Avatar
            src={user.avatarUrl}
            name={name}
            bgColor={user.avatarColor}
            className={cn('size-6', circleIcons && 'rounded-full')}
          />
        </Tab>
      </View>

      <AccountSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </View>
  );
});
