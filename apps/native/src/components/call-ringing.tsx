// Port of apps/frontend/src/lib/components/call-ringing.svelte
// Mounted once above the chat stack: <CallRinging onAccept={(channelId) => router.push(dmPath(channelId))} />
// The web shows a small card; a phone takes the whole screen, like its own calls. It also comes up over the
// lock screen when the ring notification opens the app (modules/incoming-call, lib/call-link.ts).
import * as Haptics from 'expo-haptics';
import { Phone, PhoneOff, type LucideIcon } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Pressable, Vibration, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IncomingCall } from '../../modules/incoming-call';
import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { setCallLink, useCallLink } from '@/lib/call-link';
import { useChat } from '@/lib/chat-state';
import { dmDisplay, RING_TIMEOUT, useDms } from '@/lib/dms';
import { notificationSound } from '@/lib/notifications';
import { realtime, useRealtime } from '@/lib/realtime';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { voice, useVoice } from '@/lib/voice';

// Ring sound every 2s (plus a vibration pattern when it is incoming) and give up after RING_TIMEOUT.
// `key` identifies the call, so a different call restarts the ring and its timeout.
function useRinging(key: string | null, onTimeout: () => void, vibrate = false) {
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;

  useEffect(() => {
    if (!key) return;
    notificationSound();
    if (vibrate) Vibration.vibrate([0, 500, 300, 500, 1200], true);
    const ring = setInterval(notificationSound, 2000);
    const timeout = setTimeout(() => timeoutRef.current(), RING_TIMEOUT);
    return () => {
      clearInterval(ring);
      clearTimeout(timeout);
      if (vibrate) Vibration.cancel();
    };
  }, [key, vibrate]);
}

// one ring of the ripple around the avatar, `delay` ms behind the first
function Ripple({ delay, round }: { delay: number; round: boolean }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1)
    );
  }, [delay, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - progress.value),
    transform: [{ scale: 1 + progress.value * 0.45 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      className={cn('absolute inset-0 border-2 border-primary', round && 'rounded-full')}
      style={style}
    />
  );
}

function CallAction({
  label,
  icon,
  className,
  iconClassName,
  round,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  className: string;
  iconClassName: string;
  round: boolean;
  onPress: () => void;
}) {
  return (
    <View className="items-center gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        className={cn(
          'size-[72px] items-center justify-center active:opacity-80',
          round && 'rounded-full',
          className
        )}
      >
        <Icon as={icon} size={28} className={iconClassName} />
      </Pressable>
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
    </View>
  );
}

export function CallRinging({ onAccept }: { onAccept: (channelId: string) => void }) {
  const insets = useSafeAreaInsets();
  const circleIcons = useSettings((s) => s.circleIcons);
  const call = useDms((s) => s.incomingCall);
  const outgoing = useDms((s) => s.outgoingCall);
  const { setIncomingCall, setOutgoingCall } = useDms.getState();
  const link = useCallLink((s) => s.link);
  const connected = useRealtime((s) => s.connected);
  const voiceChannelId = useVoice((s) => s.channelId);
  const callerCount = useChat((s) => (call ? (s.voiceStates[call.channelId]?.length ?? 0) : 0));
  const outgoingCount = useChat((s) => (outgoing ? (s.voiceStates[outgoing]?.length ?? 0) : 0));
  const callerSeen = useRef(false);

  // from the notification, the ring itself arrives once the socket is up: until then the DM says who it is
  const lockScreen = link && !link.answer ? link.channelId : null;
  const channelId = call?.channelId ?? lockScreen;
  const dm = useDms((s) => (channelId ? s.get(channelId) : null));
  const display = dm ? dmDisplay(dm) : null;
  const group = dm?.type === 'GROUP_DM';
  const caller = call?.user ?? null;
  const name = caller ? caller.displayName || caller.username : (display?.name ?? 'Incoming call');

  // done ringing on this phone: the notification goes, and so does the lock screen if it brought us here
  function finish(answered: boolean) {
    if (channelId) IncomingCall?.cancel(channelId);
    if (useCallLink.getState().link) {
      if (answered) IncomingCall?.unlock();
      else IncomingCall?.release();
      setCallLink(null);
    }
    setIncomingCall(null);
  }

  // the notification's Answer button: straight into the call
  useEffect(() => {
    if (!link?.answer) return;
    setCallLink(null);
    IncomingCall?.cancel(link.channelId);
    void voice()
      .join(link.channelId)
      .catch(() => null);
  }, [link]);

  // the app rings from here on, so the notification stops
  useEffect(() => {
    if (channelId) IncomingCall?.cancel(channelId);
  }, [channelId]);

  // opened from the notification but the ring is over: back to the lock screen
  useEffect(() => {
    if (!lockScreen || call || !connected) return;
    const timeout = setTimeout(() => finish(false), 4000);
    return () => clearTimeout(timeout);
  }, [lockScreen, call, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // the homeserver ended the ring (hung up, answered elsewhere, timed out) while the lock screen was up
  const hadCall = useRef(false);
  useEffect(() => {
    if (call) hadCall.current = true;
    else if (hadCall.current && lockScreen) finish(false);
    if (!call && !lockScreen) hadCall.current = false;
  }, [call, lockScreen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (call && voiceChannelId === call.channelId) finish(true);
  }, [call, voiceChannelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // the ring can arrive before the caller's presence, so only stop once they've been seen and left.
  useEffect(() => {
    if (!call) callerSeen.current = false;
    else if (callerCount) callerSeen.current = true;
    else if (callerSeen.current) finish(false);
  }, [call, callerCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // stop ringing out once they pick up or we hang up.
  useEffect(() => {
    if (outgoing && (voiceChannelId !== outgoing || outgoingCount > 1)) setOutgoingCall(null);
  }, [outgoing, voiceChannelId, outgoingCount, setOutgoingCall]);

  useRinging(channelId, () => finish(false), true);
  useRinging(outgoing, () => setOutgoingCall(null));

  if (!channelId) return null;

  const decline = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // in a group, one person saying no shouldn't stop it ringing for the others
    if (!group) realtime().ringCall(channelId, false);
    finish(false);
  };
  const accept = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    finish(true);
    onAccept(channelId);
  };

  const members = group ? (dm?.participants ?? []).filter((user) => !user.isBot) : [];
  const shown = members.slice(0, 5);

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      accessibilityRole="alert"
      accessibilityLabel={`Incoming call from ${name}`}
      className="absolute inset-0 z-50 bg-background"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 40 }}
    >
      <View className="items-center">
        <View
          className={cn(
            'flex-row items-center gap-2 border border-border/15 bg-sidebar px-3 py-1.5',
            circleIcons && 'rounded-full'
          )}
        >
          <View className="size-1.5 rounded-full bg-emerald-500" />
          <Text className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
            {group ? 'Group call' : 'Incoming call'}
          </Text>
        </View>
      </View>

      <View className="flex-1 items-center justify-center gap-14 px-8">
        <View className="size-36 items-center justify-center">
          <Ripple delay={0} round={circleIcons} />
          <Ripple delay={800} round={circleIcons} />
          <Ripple delay={1600} round={circleIcons} />
          <Avatar
            src={caller?.avatarUrl ?? display?.avatarUrl}
            name={name}
            bgColor={caller?.avatarColor ?? display?.avatarColor}
            className="size-36"
            textClassName="text-5xl"
          />
        </View>

        <View className="items-center gap-1.5">
          <Text numberOfLines={2} className="text-center text-3xl font-semibold tracking-tight">
            {name}
          </Text>
          {group && display ? (
            <Text numberOfLines={1} className="text-center text-sm text-muted-foreground">
              Calling {display.name}
            </Text>
          ) : caller ? (
            <Text numberOfLines={1} className="font-mono text-xs text-muted-foreground">
              @{caller.username}:{caller.homeserver}
            </Text>
          ) : null}
        </View>

        {shown.length > 0 && (
          <View className="flex-row items-center">
            {shown.map((member, i) => (
              <Avatar
                key={member.userId}
                src={member.avatarUrl}
                name={member.displayName || member.username}
                bgColor={member.avatarColor}
                className={cn('size-8 border-2 border-background', i > 0 && '-ml-2')}
              />
            ))}
            {members.length > shown.length && (
              <Text className="ml-2 text-xs text-muted-foreground">
                +{members.length - shown.length}
              </Text>
            )}
          </View>
        )}
      </View>

      <View className="flex-row justify-center gap-20">
        <CallAction
          label="Decline"
          icon={PhoneOff}
          round={circleIcons}
          className="bg-destructive"
          iconClassName="text-destructive-foreground"
          onPress={decline}
        />
        <CallAction
          label="Accept"
          icon={Phone}
          round={circleIcons}
          className="bg-emerald-500"
          iconClassName="text-white"
          onPress={accept}
        />
      </View>
    </Animated.View>
  );
}
