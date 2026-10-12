// Port of apps/frontend/src/lib/components/call-ringing.svelte
// Mount once in the app shell (above the panels): <CallRinging onAccept={(channelId) => router.push(dmPath(channelId))} />
import * as Haptics from 'expo-haptics';
import { Phone, PhoneOff } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Vibration, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useChat } from '@/lib/chat-state';
import { RING_TIMEOUT, useDms } from '@/lib/dms';
import { notificationSound } from '@/lib/notifications';
import { realtime } from '@/lib/realtime';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { useVoice } from '@/lib/voice';

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

export function CallRinging({ onAccept }: { onAccept: (channelId: string) => void }) {
  const insets = useSafeAreaInsets();
  const circleIcons = useSettings((s) => s.circleIcons);
  const call = useDms((s) => s.incomingCall);
  const outgoing = useDms((s) => s.outgoingCall);
  const { setIncomingCall, setOutgoingCall } = useDms.getState();
  const voiceChannelId = useVoice((s) => s.channelId);
  const callerCount = useChat((s) => (call ? (s.voiceStates[call.channelId]?.length ?? 0) : 0));
  const outgoingCount = useChat((s) => (outgoing ? (s.voiceStates[outgoing]?.length ?? 0) : 0));
  const callerSeen = useRef(false);

  const name = call ? call.user.displayName || call.user.username : '';

  useEffect(() => {
    if (call && voiceChannelId === call.channelId) setIncomingCall(null);
  }, [call, voiceChannelId, setIncomingCall]);

  // the ring can arrive before the caller's presence, so only stop once they've been seen and left.
  useEffect(() => {
    if (!call) callerSeen.current = false;
    else if (callerCount) callerSeen.current = true;
    else if (callerSeen.current) setIncomingCall(null);
  }, [call, callerCount, setIncomingCall]);

  // stop ringing out once they pick up or we hang up.
  useEffect(() => {
    if (outgoing && (voiceChannelId !== outgoing || outgoingCount > 1)) setOutgoingCall(null);
  }, [outgoing, voiceChannelId, outgoingCount, setOutgoingCall]);

  useRinging(call?.channelId ?? null, () => setIncomingCall(null), true);
  useRinging(outgoing, () => setOutgoingCall(null));

  if (!call) return null;

  return (
    <Animated.View
      entering={FadeInUp.duration(200)}
      exiting={FadeOutUp.duration(200)}
      accessibilityRole="alert"
      accessibilityLabel={`Incoming call from ${name}`}
      className={cn(
        'absolute inset-x-4 z-50 mx-auto w-full max-w-sm flex-row items-center gap-3 border border-border bg-sidebar/80 p-3',
        circleIcons && 'rounded-xl'
      )}
      style={{ top: insets.top + 16 }}
    >
      <Avatar
        src={call.user.avatarUrl}
        name={name}
        bgColor={call.user.avatarColor}
        className="size-10 shrink-0"
      />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-semibold">
          {name}
        </Text>
        <Text className="text-xs text-muted-foreground">Incoming call…</Text>
      </View>
      <Button
        variant="destructive"
        className={cn('size-12', circleIcons && 'rounded-full')}
        accessibilityLabel="Decline"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          realtime().ringCall(call.channelId, false);
          setIncomingCall(null);
        }}
      >
        <Icon as={PhoneOff} size={20} className="text-destructive-foreground" />
      </Button>
      <Button
        className={cn(
          'size-12 bg-green-500/20 active:bg-green-500/30',
          circleIcons && 'rounded-full'
        )}
        accessibilityLabel="Accept"
        onPress={() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setIncomingCall(null);
          onAccept(call.channelId);
        }}
      >
        <Icon as={Phone} size={20} className="text-green-500" />
      </Button>
    </Animated.View>
  );
}
