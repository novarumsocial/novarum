// Port of apps/frontend/src/lib/components/user-area.svelte
// Differences: the account popover is the `AccountSwitcher` sheet; the settings button opens the settings screens;
// the noise suppression / mic test popover lives in settings > Voice & audio.
import { ConnectionState } from 'livekit-client';
import { router } from 'expo-router';
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  PhoneOff,
  Settings,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AccountSwitcher } from '@/components/account-switcher';
import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { channelPath } from '@/lib/chat-state';
import { goto } from '@/lib/navigation';
import type { SessionUser } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { selectConnected, selectConnecting, useVoice, voice } from '@/lib/voice';

const tiers = [
  { max: 60, icon: Signal, color: 'bg-emerald-500/10', text: 'text-emerald-400' },
  { max: 120, icon: SignalHigh, color: 'bg-lime-500/10', text: 'text-lime-400' },
  { max: 200, icon: SignalMedium, color: 'bg-amber-500/10', text: 'text-amber-400' },
  { max: Infinity, icon: SignalLow, color: 'bg-rose-500/10', text: 'text-rose-400' },
];
const connectingTier = { icon: SignalZero, color: 'bg-amber-500/10', text: 'text-amber-400' };

export function UserArea({
  user,
  voiceChannelName,
  onLeaveVoice,
}: {
  user: SessionUser;
  voiceChannelName: string | null;
  onLeaveVoice: () => void;
}) {
  const insets = useSafeAreaInsets();
  const circleIcons = useSettings((s) => s.circleIcons);
  const connected = useVoice(selectConnected);
  const connecting = useVoice(selectConnecting);
  const connectionState = useVoice((s) => s.connectionState);
  const room = useVoice((s) => s.room);
  const channelId = useVoice((s) => s.channelId);
  const selfMuted = useVoice((s) => s.selfMuted);
  const selfDeafened = useVoice((s) => s.selfDeafened);
  const speaking = useVoice((s) => s.voiceStates.get(user.id)?.speaking ?? false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    setLatency(null);
    if (!connected || !room) return;
    const update = () => setLatency(room.engine.client.rtt || null);
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [connected, room]);

  const reconnecting =
    connectionState === ConnectionState.Reconnecting ||
    connectionState === ConnectionState.SignalReconnecting;
  const tier = connecting
    ? connectingTier
    : (tiers.find((item) => (latency ?? 0) < item.max) ?? tiers[0]!);
  const status = reconnecting
    ? 'Reconnecting'
    : connecting
      ? 'Voice Connecting'
      : 'Voice Connected';
  const name = user.displayName || user.username;

  const openVoiceChannel = () => {
    if (!channelId) return;
    goto(channelPath(channelId));
  };

  // voice() already buzzes on mute and deafen
  const toggle = (action: () => unknown) => () => void action();

  return (
    <View
      className="shrink-0 border-t border-border bg-sidebar-accent/30"
      style={{ paddingBottom: insets.bottom }}
    >
      {(connected || connecting) && (
        <View className="flex-row items-center gap-2 border-b border-border/80 px-3 py-2">
          <View className={cn('size-11 items-center justify-center', tier.color)}>
            <Icon as={tier.icon} size={16} className={tier.text} />
            {latency !== null && !connecting && (
              <Text className={cn('text-[9px] leading-none', tier.text)}>{latency}ms</Text>
            )}
          </View>
          <View className="min-w-0 flex-1">
            <Text
              numberOfLines={1}
              className={cn(
                'text-xs font-semibold tracking-wide uppercase',
                connecting || reconnecting ? 'text-amber-400' : 'text-emerald-400'
              )}
            >
              {status}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${voiceChannelName ?? 'voice channel'}`}
              onPress={openVoiceChannel}
              className="min-h-11 justify-center"
            >
              <Text numberOfLines={1} className="text-[11px] text-muted-foreground">
                {voiceChannelName ?? 'Voice channel'}
              </Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Leave call"
            onPress={onLeaveVoice}
            className={cn(
              'size-11 items-center justify-center active:bg-rose-500/10',
              circleIcons && 'rounded-full'
            )}
          >
            <Icon as={PhoneOff} size={18} className="text-muted-foreground" />
          </Pressable>
        </View>
      )}

      <View className="min-h-14 flex-row items-center gap-1 px-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch account"
          onPress={() => setSwitcherOpen(true)}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2.5 active:bg-sidebar-accent"
        >
          <View>
            <Avatar
              src={user.avatarUrl}
              name={name}
              bgColor={user.avatarColor}
              className="size-8"
            />
            {connected && speaking && (
              <View
                pointerEvents="none"
                className={cn('absolute inset-0 border-2', circleIcons && 'rounded-full')}
                style={{ borderColor: user.speakingRingColor ?? '#00d492' }}
              />
            )}
          </View>
          <View className="min-w-0 flex-1">
            <Text
              numberOfLines={1}
              className="text-sm leading-tight font-medium text-sidebar-foreground"
            >
              {name}
            </Text>
            <Text numberOfLines={1} className="text-[11px] text-muted-foreground">
              @{user.username}:{user.homeserver}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selfDeafened ? 'Undeafen' : selfMuted ? 'Unmute' : 'Mute'}
          onPress={toggle(() =>
            selfDeafened ? voice().setDeafened(false) : voice().setMuted(!selfMuted)
          )}
          className="size-11 items-center justify-center"
        >
          <Icon
            as={selfMuted ? MicOff : Mic}
            size={18}
            className={selfMuted || selfDeafened ? 'text-rose-400' : 'text-muted-foreground'}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selfDeafened ? 'Undeafen' : 'Deafen'}
          onPress={toggle(() => voice().setDeafened(!selfDeafened))}
          className="size-11 items-center justify-center"
        >
          <Icon
            as={selfDeafened ? HeadphoneOff : Headphones}
            size={18}
            className={selfDeafened ? 'text-rose-400' : 'text-muted-foreground'}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="User settings"
          onPress={() => router.push('/settings')}
          className="size-11 items-center justify-center"
        >
          <Icon as={Settings} size={18} className="text-muted-foreground" />
        </Pressable>
      </View>

      <AccountSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </View>
  );
}
