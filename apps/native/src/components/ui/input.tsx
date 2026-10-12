// Port of apps/frontend/src/lib/components/ui/input
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { cssInterop } from 'nativewind';
import * as React from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { useThemeColors } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { fontFamilyFor } from './text';

cssInterop(BottomSheetTextInput, { className: 'style' });

export const Input = React.forwardRef<
  TextInput,
  // `sheet`: the input lives inside a <Sheet>, so it must be a BottomSheetTextInput to move with the keyboard
  TextInputProps & { className?: string; sheet?: boolean }
>(({ className, style, sheet, ...props }, ref) => {
  const Field = sheet ? (BottomSheetTextInput as unknown as typeof TextInput) : TextInput;
  const colors = useThemeColors();
  const classes = cn(
    'min-h-11 rounded-none border border-input bg-background px-3 text-base text-foreground',
    props.editable === false && 'opacity-50',
    className
  );
  return (
    <Field
      ref={ref}
      className={classes}
      style={[{ fontFamily: fontFamilyFor(classes) }, style]}
      placeholderTextColor={colors['muted-foreground']}
      selectionColor={colors.primary}
      {...props}
    />
  );
});
Input.displayName = 'Input';

// Port of apps/frontend/src/lib/components/ui/textarea
export const Textarea = React.forwardRef<TextInput, TextInputProps & { className?: string }>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      multiline
      textAlignVertical="top"
      className={cn('h-auto min-h-24 py-2', className)}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';
