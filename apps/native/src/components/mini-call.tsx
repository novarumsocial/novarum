// Native-only (the plan's "mini call view"): a compact bar over the top of the chat while you are in a call
// and browsing somewhere else. Tap it to go back to the call; mute and leave work from here.
import * as Haptics from 'expo-haptics';
import { Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { selectConnected, useVoice, voice } from '@/lib/voice';

export function MiniCall({
  name,
  hidden = false,
  top = 0,
  onOpen,
}: {
  // the call's channel name
  name: string;
  // true while the call's own channel is on screen
  hidden?: boolean;
  // distance from the top of the center panel (below its header)
  top?: number;
  onOpen: () => void;
}) {
  const connected = useVoice(selectConnected);
  const selfMuted = useVoice((s) => s.selfMuted);
  const circleIcons = useSettings((s) => s.circleIcons);

  if (!connected || hidden) return null;

  return (
    <View
      className={cn(
        'absolute inset-x-2 z-20 flex-row items-center border border-border bg-card',
        circleIcons && 'rounded-full pl-2'
      )}
      style={{ top }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`In a call in ${name}. Return to the call`}
        onPress={onOpen}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 px-3 active:opacity-70"
      >
        <Icon as={Volume2} size={16} className="text-emerald-400" />
        <Text className="min-w-0 flex-1 text-sm font-medium" numberOfLines={1}>
          {name}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={selfMuted ? 'Unmute' : 'Mute'}
        accessibilityState={{ selected: selfMuted }}
        onPress={() => {
          void Haptics.selectionAsync();
          void voice().setMuted(!selfMuted);
        }}
        className={cn(
          'size-11 items-center justify-center active:bg-accent',
          circleIcons && 'rounded-full'
        )}
      >
        <Icon
          as={selfMuted ? MicOff : Mic}
          size={18}
          className={selfMuted ? 'text-rose-400' : 'text-muted-foreground'}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Leave call"
        onPress={() => void voice().leave()}
        className={cn(
          'size-11 items-center justify-center active:bg-rose-500/10',
          circleIcons && 'rounded-full'
        )}
      >
        <Icon as={PhoneOff} size={18} className="text-rose-400" />
      </Pressable>
    </View>
  );
}
