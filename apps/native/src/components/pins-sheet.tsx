// Port of apps/frontend/src/lib/components/pins-popover.svelte
// The header's pin button opens a sheet instead of a popover; tapping a pin jumps to the message.
import { Pin, PinOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { chat, selectCanPinInCurrentChannel, useChat } from '@/lib/chat-state';
import { formatDate, formatTime } from '@/lib/format-date';
import { goto } from '@/lib/navigation';
import { toast } from '@/lib/toast';

export function PinsButton({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pins = useChat((state) => state.pinsByChannel[channelId]);
  const canPin = useChat(selectCanPinInCurrentChannel);

  useEffect(() => {
    if (!open) return;
    setError(null);
    chat()
      .loadPins(channelId)
      .catch((e: Error) => setError(e.message));
  }, [open, channelId]);

  const jump = (messageId: string) => {
    setOpen(false);
    goto(chat().messagePath(messageId));
  };

  return (
    <>
      <Button
        variant={open ? 'secondary' : 'ghost'}
        size="icon"
        accessibilityLabel="Pinned messages"
        onPress={() => setOpen(true)}
      >
        <Icon as={Pin} size={20} />
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Pinned messages">
        {error ? (
          <Text className="px-4 py-6 text-center text-muted-foreground">{error}</Text>
        ) : !pins ? (
          <Text className="px-4 py-6 text-center text-muted-foreground">Loading…</Text>
        ) : !pins.length ? (
          <Text className="px-4 py-6 text-center text-muted-foreground">
            No pinned messages yet.
          </Text>
        ) : (
          pins.map((pin) => (
            <View key={pin.id} className="flex-row items-start gap-3 px-4 py-2">
              <Avatar
                src={pin.author.avatarUrl}
                name={pin.author.displayName || pin.author.username}
                className="size-8"
                bgColor={pin.author.avatarColor}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Jumps to the message"
                onPress={() => jump(pin.id)}
                className="min-w-0 flex-1 active:opacity-70"
              >
                <View className="flex-row items-baseline gap-2">
                  <Text className="shrink text-sm font-semibold" numberOfLines={1}>
                    {pin.author.displayName || pin.author.username}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {formatDate(pin.timestamp)} {formatTime(pin.timestamp)}
                  </Text>
                </View>
                {pin.content ? (
                  <Markdown content={pin.content} inline />
                ) : (
                  <Text className="text-sm text-muted-foreground italic">
                    {pin.attachments.length} attachment{pin.attachments.length === 1 ? '' : 's'}
                  </Text>
                )}
              </Pressable>
              {canPin && (
                <Button
                  variant="ghost"
                  size="icon"
                  accessibilityLabel="Unpin message"
                  onPress={() =>
                    chat()
                      .setPinned(channelId, pin.id, false)
                      .catch((e: Error) => toast(e.message, { tone: 'error' }))
                  }
                >
                  <Icon as={PinOff} size={18} className="text-muted-foreground" />
                </Button>
              )}
            </View>
          ))
        )}
      </Sheet>
    </>
  );
}
