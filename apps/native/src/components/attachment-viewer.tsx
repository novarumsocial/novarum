// Port of apps/frontend/src/lib/components/attachment-viewer.svelte
// Full-screen viewer: page between attachments, pinch / double-tap to zoom, swipe down to close,
// save to photos and share. It lives in the `viewer` modal route; `openAttachmentViewer` opens it.
import * as Haptics from 'expo-haptics';
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { router, type Href } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { Download, FileText, Music, Share2, Video, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Alert, FlatList, Pressable, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';
import { Avatar } from '@/components/avatar';
import { AudioPlayer } from '@/components/audio-player';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VideoPlayer } from '@/components/video-player';
import { formatDate, formatTime } from '@/lib/format-date';
import type { Attachment, Author } from '@/lib/types/chat';
import { cn, formatBytes } from '@/lib/utils';

const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  previewUrl: z.string(),
});

// what the `viewer` route receives (route params are strings, so the list travels as JSON)
export const viewerParamsSchema = z.object({
  attachments: z.string().transform((value, ctx) => {
    try {
      return z.array(attachmentSchema).parse(JSON.parse(value));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid attachments' });
      return z.NEVER;
    }
  }),
  index: z.coerce.number().int().min(0).catch(0),
  authorName: z.string().default(''),
  avatarUrl: z.string().optional(),
  avatarColor: z.string().optional(),
  timestamp: z.string().optional(),
});

export function openAttachmentViewer({
  attachments,
  index,
  author,
  timestamp,
}: {
  attachments: Attachment[];
  index: number;
  author: Author;
  timestamp: Date;
}) {
  router.push({
    pathname: '/viewer',
    params: {
      attachments: JSON.stringify(attachments),
      index: String(Math.max(index, 0)),
      authorName: author.displayName || author.username,
      ...(author.avatarUrl && { avatarUrl: author.avatarUrl }),
      ...(author.avatarColor && { avatarColor: author.avatarColor }),
      timestamp: timestamp.toISOString(),
    },
  } as Href);
}

const MAX_ZOOM = 4;
const clamp = (value: number, min: number, max: number) => {
  'worklet';
  return Math.min(max, Math.max(min, value));
};

async function download(attachment: Attachment) {
  new Directory(Paths.cache, 'viewer').create({ idempotent: true });
  const file = new File(Paths.cache, 'viewer', `${attachment.id}-${attachment.filename}`);
  if (!file.exists) await File.downloadFileAsync(attachment.url, file);
  return file.uri;
}

// pinch, double-tap and (while zoomed) drag the image around; one finger at 1x is left to the pager
function ZoomableImage({
  attachment,
  width,
  height,
  onZoomChange,
  onTap,
}: {
  attachment: Attachment;
  width: number;
  height: number;
  onZoomChange: (zoomed: boolean) => void;
  onTap: () => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const zoomed = useSharedValue(false);

  const setZoomed = (value: boolean) => {
    'worklet';
    if (zoomed.value === value) return;
    zoomed.value = value;
    runOnJS(onZoomChange)(value);
  };
  const keepInside = () => {
    'worklet';
    const maxX = (width * (scale.value - 1)) / 2;
    const maxY = (height * (scale.value - 1)) / 2;
    x.value = withSpring(clamp(x.value, -maxX, maxX));
    y.value = withSpring(clamp(y.value, -maxY, maxY));
  };
  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    x.value = withTiming(0);
    y.value = withTiming(0);
    setZoomed(false);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = clamp(savedScale.value * event.scale, 1, MAX_ZOOM);
      if (scale.value > 1.02) setZoomed(true);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value < 1.05) reset();
      else keepInside();
    });

  // only takes over from the pager once zoomed in
  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesMove((_event, manager) => {
      if (scale.value > 1.02) manager.activate();
      else manager.fail();
    })
    .onUpdate((event) => {
      x.value = savedX.value + event.translationX;
      y.value = savedY.value + event.translationY;
    })
    .onEnd(() => {
      keepInside();
    })
    .onFinalize(() => {
      savedX.value = x.value;
      savedY.value = y.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.value > 1.05) return reset();
      const next = 2.5;
      scale.value = withTiming(next);
      savedScale.value = next;
      // zoom towards the tapped point
      x.value = withTiming(
        clamp(
          (width / 2 - event.x) * (next - 1),
          -(width * (next - 1)) / 2,
          (width * (next - 1)) / 2
        )
      );
      y.value = withTiming(
        clamp(
          (height / 2 - event.y) * (next - 1),
          -(height * (next - 1)) / 2,
          (height * (next - 1)) / 2
        )
      );
      savedX.value = x.value;
      savedY.value = y.value;
      setZoomed(true);
    });
  const singleTap = Gesture.Tap().onEnd(() => runOnJS(onTap)());

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector
      gesture={Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, pan), singleTap)}
    >
      <Animated.View style={[{ width, height }, style]}>
        <Image
          source={{ uri: attachment.url }}
          placeholder={{ uri: attachment.previewUrl }}
          contentFit="contain"
          style={{ width: '100%', height: '100%' }}
        />
      </Animated.View>
    </GestureDetector>
  );
}

function Page({
  attachment,
  width,
  height,
  active,
  onZoomChange,
  onTap,
}: {
  attachment: Attachment;
  width: number;
  height: number;
  active: boolean;
  onZoomChange: (zoomed: boolean) => void;
  onTap: () => void;
}) {
  const type = attachment.contentType;

  return (
    <View style={{ width, height }} className="items-center justify-center">
      {type.startsWith('image/') ? (
        <ZoomableImage
          attachment={attachment}
          width={width}
          height={height}
          onZoomChange={onZoomChange}
          onTap={onTap}
        />
      ) : type.startsWith('video/') ? (
        <View className="w-full">
          <VideoPlayer attachment={attachment} autoPlay={active} />
        </View>
      ) : type.startsWith('audio/') ? (
        <View className="w-full px-4">
          <AudioPlayer attachment={attachment} />
        </View>
      ) : (
        <View className="items-center gap-4 px-6">
          <Icon as={FileText} size={48} className="text-muted-foreground" />
          <Text className="text-center text-sm">{attachment.filename}</Text>
          <Button onPress={() => void WebBrowser.openBrowserAsync(attachment.url)}>
            <Text>Open</Text>
          </Button>
        </View>
      )}
    </View>
  );
}

export function AttachmentViewer({
  attachments,
  initialIndex = 0,
  authorName,
  avatarUrl,
  avatarColor,
  timestamp,
  onClose,
}: {
  attachments: Attachment[];
  initialIndex?: number;
  authorName: string;
  avatarUrl?: string | null;
  avatarColor?: string | null;
  timestamp?: Date;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const start = Math.min(initialIndex, attachments.length - 1);
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [pager, setPager] = useState({ width, height: 0 });
  const list = useRef<FlatList<Attachment>>(null);
  const attachment = attachments[index];

  // swipe down to close (the pager owns horizontal drags, a zoomed image owns everything)
  const dragY = useSharedValue(0);
  const dismiss = Gesture.Pan()
    .enabled(!zoomed)
    .activeOffsetY([-15, 15])
    .failOffsetX([-15, 15])
    .onUpdate((event) => {
      dragY.value = event.translationY;
    })
    .onEnd((event) => {
      if (Math.abs(event.translationY) > 120 || Math.abs(event.velocityY) > 900) {
        dragY.value = withTiming(event.translationY > 0 ? 800 : -800, { duration: 180 });
        runOnJS(onClose)();
      } else {
        dragY.value = withSpring(0);
      }
    });
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(dragY.value), [0, 300], [1, 0.2], 'clamp'),
  }));

  async function run(kind: 'save' | 'share') {
    if (busy) return;
    setBusy(kind);
    try {
      const uri = await download(attachment);
      if (kind === 'share') {
        await Sharing.shareAsync(uri);
      } else {
        const permission = await MediaLibrary.requestPermissionsAsync(true);
        if (!permission.granted) return Alert.alert('Allow photo access in Settings to save.');
        await MediaLibrary.Asset.create(uri);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Saved to your photos');
      }
    } catch {
      Alert.alert(kind === 'save' ? 'Could not save the file' : 'Could not share the file');
    } finally {
      setBusy(null);
    }
  }

  const canSave =
    attachment.contentType.startsWith('image/') || attachment.contentType.startsWith('video/');

  return (
    <View className="flex-1">
      <Animated.View style={backdropStyle} className="absolute inset-0 bg-black/95" />
      <GestureDetector gesture={dismiss}>
        <Animated.View style={contentStyle} className="flex-1">
          {/* the bars float over the pager, so toggling them doesn't resize the image */}
          {chrome && (
            <View
              className="absolute inset-x-0 top-0 z-10 flex-row items-center gap-3 bg-black/60 px-3 pb-2"
              style={{ paddingTop: insets.top + 8 }}
            >
              <Avatar src={avatarUrl} name={authorName} bgColor={avatarColor} className="size-9" />
              <View className="min-w-0 flex-1">
                <View className="flex-row items-baseline gap-2">
                  <Text className="shrink text-sm font-semibold text-white" numberOfLines={1}>
                    {authorName}
                  </Text>
                  {timestamp && (
                    <Text className="shrink-0 text-[11px] text-white/60">
                      {formatDate(timestamp)} at {formatTime(timestamp)}
                    </Text>
                  )}
                </View>
                <Text className="text-[11px] text-white/60" numberOfLines={1}>
                  {attachment.filename}, {formatBytes(attachment.size)}
                </Text>
              </View>
              {busy ? (
                <View className="size-11 items-center justify-center">
                  <Spinner />
                </View>
              ) : (
                <>
                  {canSave && (
                    <Button
                      variant="ghost"
                      size="icon"
                      accessibilityLabel="Save to photos"
                      onPress={() => void run('save')}
                    >
                      <Icon as={Download} size={20} className="text-white" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    accessibilityLabel="Share"
                    onPress={() => void run('share')}
                  >
                    <Icon as={Share2} size={20} className="text-white" />
                  </Button>
                </>
              )}
              <Button variant="ghost" size="icon" accessibilityLabel="Close" onPress={onClose}>
                <Icon as={X} size={22} className="text-white" />
              </Button>
            </View>
          )}

          <View className="flex-1" onLayout={(event) => setPager(event.nativeEvent.layout)}>
            {pager.height > 0 && (
              <FlatList
                ref={list}
                data={attachments}
                keyExtractor={(item) => item.id}
                horizontal
                pagingEnabled
                scrollEnabled={!zoomed}
                showsHorizontalScrollIndicator={false}
                initialScrollIndex={start}
                getItemLayout={(_, i) => ({
                  length: pager.width,
                  offset: pager.width * i,
                  index: i,
                })}
                windowSize={3}
                onMomentumScrollEnd={(event) =>
                  setIndex(Math.round(event.nativeEvent.contentOffset.x / pager.width))
                }
                renderItem={({ item, index: i }) => (
                  <Page
                    attachment={item}
                    width={pager.width}
                    height={pager.height}
                    active={i === index}
                    onZoomChange={setZoomed}
                    onTap={() => setChrome((value) => !value)}
                  />
                )}
              />
            )}
          </View>

          {chrome && attachments.length > 1 && (
            <View
              className="absolute inset-x-0 bottom-0 z-10 flex-row justify-center gap-1.5 bg-black/60 px-3 pt-2"
              style={{ paddingBottom: insets.bottom + 8 }}
            >
              {attachments.map((item, i) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${item.filename}`}
                  onPress={() => {
                    setIndex(i);
                    list.current?.scrollToIndex({ index: i, animated: true });
                  }}
                  className={cn(
                    'size-11 items-center justify-center overflow-hidden bg-muted opacity-40',
                    i === index && 'border-2 border-primary opacity-100'
                  )}
                >
                  {item.contentType.startsWith('image/') ? (
                    <Image
                      source={{ uri: item.previewUrl }}
                      contentFit="cover"
                      style={{ width: '100%', height: '100%' }}
                    />
                  ) : (
                    <Icon
                      as={
                        item.contentType.startsWith('video/')
                          ? Video
                          : item.contentType.startsWith('audio/')
                            ? Music
                            : FileText
                      }
                      size={16}
                      className="text-muted-foreground"
                    />
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
