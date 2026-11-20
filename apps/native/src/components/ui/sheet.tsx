// Native-only: the phone's version of the web's dialogs, dropdowns and context menus.
// <Sheet open onClose title?>...</Sheet> slides up from the bottom, resizes to its content and follows the keyboard.
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { BackHandler, Keyboard, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { useThemeColors } from '@/lib/theme';
import { Text } from './text';

// how many sheets are up, so the screen behind them can hide from screen readers
export const useOpenSheets = create<{ count: number }>(() => ({ count: 0 }));

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const ref = useRef<BottomSheetModal>(null);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // dismiss() on a sheet that isn't shown leaves it stuck "dismissing", and its next present() renders nothing
  const shown = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (open) {
      shown.current = true;
      // the keyboard of whatever was being typed in would stay up over the sheet
      Keyboard.dismiss();
      ref.current?.present();
    } else if (shown.current) ref.current?.dismiss();
  }, [open]);

  // the system back closes the sheet instead of leaving the app
  useEffect(() => {
    if (!open) return;
    useOpenSheets.setState((s) => ({ count: s.count + 1 }));
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close.current();
      return true;
    });
    return () => {
      subscription.remove();
      useOpenSheets.setState((s) => ({ count: s.count - 1 }));
    };
  }, [open]);

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        accessibilityLabel="Close"
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
      onDismiss={() => {
        shown.current = false;
        onClose();
      }}
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
        accessibilityViewIsModal
      >
        {title ? (
          <View className="border-b border-border px-4 pt-1 pb-3">
            <Text role="heading" numberOfLines={1} className="text-base font-semibold">
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={2} className="text-sm text-muted-foreground">
                {subtitle}
              </Text>
            ) : null}
          </View>
        ) : null}
        {children}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
