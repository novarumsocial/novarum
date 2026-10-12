// Native-only: the phone's version of the web's dialogs, dropdowns and context menus.
// <Sheet open onClose>...</Sheet> slides up from the bottom, resizes to its content and follows the keyboard.
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '@/lib/theme';

export function Sheet({
  open,
  onClose,
  children,
  scroll = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  // long lists scroll inside the sheet instead of resizing it
  scroll?: boolean;
}) {
  const ref = useRef<BottomSheetModal>(null);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    []
  );

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      maxDynamicContentSize={800}
      onDismiss={onClose}
      backdropComponent={backdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{ backgroundColor: colors.popover, borderRadius: 0 }}
      handleIndicatorStyle={{ backgroundColor: colors['muted-foreground'] }}
    >
      {scroll ? (
        <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}>
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={{ paddingBottom: insets.bottom + 8 }}>{children}</BottomSheetView>
      )}
    </BottomSheetModal>
  );
}
