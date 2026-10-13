// Native-only: the phone's version of the web's dialogs, dropdowns and context menus.
// <Sheet open onClose>...</Sheet> slides up from the bottom, resizes to its content and follows the keyboard.
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '@/lib/theme';

export function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<BottomSheetModal>(null);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

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
      // grows with its content up to just below the status bar, then scrolls
      maxDynamicContentSize={height - insets.top - 24}
      onDismiss={onClose}
      // swiping or tapping the backdrop closes it without always firing onDismiss; without this `open` stays true and it never reopens
      onChange={(index) => index === -1 && onClose()}
      backdropComponent={backdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backgroundStyle={{ backgroundColor: colors.popover, borderRadius: 0 }}
      handleIndicatorStyle={{ backgroundColor: colors['muted-foreground'] }}
    >
      <BottomSheetScrollView
        // a tap on a button while typing presses it instead of only closing the keyboard
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}
      >
        {children}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
