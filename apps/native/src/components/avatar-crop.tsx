// Port of apps/frontend/src/lib/components/avatar-crop-dialog.svelte
// A full-screen modal: pinch and drag the picture under a fixed frame, then `expo-image-manipulator` cuts that part out.
import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import { useEffect, useState } from 'react';
import { Modal, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { Text } from './ui/text';

const MAX_ZOOM = 4;

export function AvatarCrop({
  image,
  onClose,
  onCrop,
  title = 'Crop Avatar',
  description = 'Adjust the image to fit your profile.',
  actionLabel = 'Use Avatar',
  outputWidth = 512,
  outputHeight = 512,
}: {
  // the picked picture; `null` keeps the modal closed
  image: { uri: string; width: number; height: number } | null;
  onClose: () => void;
  // the cropped picture as a PNG file
  onCrop: (uri: string) => void;
  title?: string;
  description?: string;
  actionLabel?: string;
  outputWidth?: number;
  outputHeight?: number;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);

  const frameW = Math.min(screenWidth - 32, 420);
  const frameH = (frameW * outputHeight) / outputWidth;
  // the picture starts "covering" the frame; `zoom` multiplies on top of that
  const cover = image ? Math.max(frameW / image.width, frameH / image.height) : 1;
  const shownW = image ? image.width * cover : 0;
  const shownH = image ? image.height * cover : 0;

  const zoom = useSharedValue(1);
  const startZoom = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  useEffect(() => {
    zoom.value = 1;
    x.value = 0;
    y.value = 0;
  }, [image, zoom, x, y]);

  // keep the frame fully covered by the picture
  const limit = (value: number, size: number, frame: number, z: number) => {
    'worklet';
    const max = Math.max(0, (size * z - frame) / 2);
    return Math.min(max, Math.max(-max, value));
  };

  const gesture = Gesture.Simultaneous(
    Gesture.Pan()
      .onStart(() => {
        startX.value = x.value;
        startY.value = y.value;
      })
      .onUpdate((e) => {
        x.value = limit(startX.value + e.translationX, shownW, frameW, zoom.value);
        y.value = limit(startY.value + e.translationY, shownH, frameH, zoom.value);
      }),
    Gesture.Pinch()
      .onStart(() => {
        startZoom.value = zoom.value;
      })
      .onUpdate((e) => {
        zoom.value = Math.min(MAX_ZOOM, Math.max(1, startZoom.value * e.scale));
        x.value = limit(x.value, shownW, frameW, zoom.value);
        y.value = limit(y.value, shownH, frameH, zoom.value);
      })
  );

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }],
  }));

  async function crop() {
    if (!image) return;
    setSaving(true);
    try {
      // screen pixels per picture pixel, then the visible part in picture pixels
      const s = cover * zoom.value;
      const width = Math.min(image.width, Math.round(frameW / s));
      const height = Math.min(image.height, Math.round(frameH / s));
      const originX = Math.max(
        0,
        Math.min(image.width - width, Math.round(image.width / 2 - x.value / s - width / 2))
      );
      const originY = Math.max(
        0,
        Math.min(image.height - height, Math.round(image.height / 2 - y.value / s - height / 2))
      );

      const rendered = await ImageManipulator.ImageManipulator.manipulate(image.uri)
        .crop({ originX, originY, width, height })
        .resize({ width: outputWidth, height: outputHeight })
        .renderAsync();
      const saved = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.PNG });
      onCrop(saved.uri);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      visible={image !== null}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* a Modal is outside the app's root view, so gestures need their own root */}
      <GestureHandlerRootView className="flex-1 bg-background">
        <View
          className="flex-1 gap-6 px-4"
          style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }}
        >
          <View className="gap-1">
            <Text className="text-lg font-semibold">{title}</Text>
            <Text className="text-sm text-muted-foreground">{description}</Text>
          </View>

          <View className="flex-1 items-center justify-center">
            <GestureDetector gesture={gesture}>
              <View
                className="items-center justify-center overflow-hidden bg-muted"
                style={{ width: frameW, height: frameH }}
              >
                {image && (
                  <Animated.View style={[{ width: shownW, height: shownH }, imageStyle]}>
                    <Image source={{ uri: image.uri }} style={{ width: '100%', height: '100%' }} />
                  </Animated.View>
                )}
              </View>
            </GestureDetector>
            <Text className="mt-3 text-xs text-muted-foreground">Pinch to zoom, drag to move</Text>
          </View>

          <View className="flex-row justify-end gap-2">
            <Button variant="outline" onPress={onClose} disabled={saving}>
              <Text>Cancel</Text>
            </Button>
            <Button onPress={crop} disabled={saving}>
              {saving && <Spinner />}
              <Text>{actionLabel}</Text>
            </Button>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
