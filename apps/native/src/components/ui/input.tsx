// Port of apps/frontend/src/lib/components/ui/input
import * as React from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { useThemeColors } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { fontFamilyFor } from './text';

export const Input = React.forwardRef<TextInput, TextInputProps & { className?: string }>(
  ({ className, style, ...props }, ref) => {
    const colors = useThemeColors();
    const classes = cn(
      'h-11 rounded-none border border-input bg-background px-3 text-base text-foreground',
      props.editable === false && 'opacity-50',
      className
    );
    return (
      <TextInput
        ref={ref}
        className={classes}
        style={[{ fontFamily: fontFamilyFor(classes) }, style]}
        placeholderTextColor={colors['muted-foreground']}
        selectionColor={colors.primary}
        {...props}
      />
    );
  }
);
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
