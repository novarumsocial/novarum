// Native-only: the web repeats this page frame (constellation, logo, card) in login, register, reset-password and the invite page
import type { LucideIcon } from 'lucide-react-native';
import { ArrowRight } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useController, type Control, type FieldValues, type Path as FieldPath } from 'react-hook-form';
import { useThemeColors } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { ConstellationBackground } from './constellation-background';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Spinner } from './ui/spinner';
import { Text } from './ui/text';

function Logo() {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-2.5">
      <View className="size-9 items-center justify-center bg-primary">
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path
            fill={colors['primary-foreground']}
            d="M23 16a1 1 0 0 1-1 1H2a1 1 0 0 1 0-2h20a1 1 0 0 1 1 1Zm-5 5a1 1 0 0 0 0-2H6a1 1 0 0 0 0 2ZM7 12a1 1 0 0 0 2 0 3 3 0 0 1 6 0 1 1 0 0 0 2 0A5 5 0 0 0 7 12Zm4-7a1 1 0 0 0 2 0V4a1 1 0 0 0-2 0Zm7 7a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2h-1a1 1 0 0 0-1 1ZM4 11a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2Zm1.636-5.364a1 1 0 0 0 0 1.414l.707.707A1 1 0 0 0 7.757 6.343L7.05 5.636a1 1 0 0 0-1.414 0Zm11.314 0-.707.707a1 1 0 1 0 1.414 1.414l.707-.707a1 1 0 1 0-1.414-1.414Z"
          />
        </Svg>
      </View>
      <Text className="text-lg font-semibold tracking-tight">novarum</Text>
    </View>
  );
}

export function AuthCard({
  title,
  description,
  children,
  footer,
  centered = true,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  centered?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background">
      <ConstellationBackground className="absolute inset-0" />
      <KeyboardAwareScrollView
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: 16,
          paddingTop: insets.top + 72,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <View className="absolute left-4 z-20" style={{ top: insets.top + 16 }}>
          <Logo />
        </View>
        <View className="w-full max-w-md gap-5 self-center border border-border bg-card/90 p-6">
          <View className="gap-1">
            <Text className={cn('text-xl font-semibold', centered && 'text-center')}>{title}</Text>
            {description ? (
              <Text className={cn('text-sm text-muted-foreground', centered && 'text-center')}>
                {description}
              </Text>
            ) : null}
          </View>
          {children}
          {footer ? (
            <View className="flex-row flex-wrap items-center justify-center gap-1">{footer}</View>
          ) : null}
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

// a form field with a leading icon, wired to react-hook-form; errors show under it like the web's Form.FieldErrors
export function AuthField<T extends FieldValues>({
  control,
  name,
  label,
  icon,
  right,
  labelRight,
  className,
  ...input
}: {
  control: Control<T>;
  name: FieldPath<T>;
  label: ReactNode;
  icon: LucideIcon;
  right?: ReactNode;
  labelRight?: ReactNode;
  className?: string;
} & TextInputProps) {
  const { field, fieldState } = useController({ control, name });
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Label>{label}</Label>
        {labelRight}
      </View>
      <View>
        <Input
          ref={field.ref as React.Ref<TextInput>}
          value={field.value}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          className={cn('pl-9', right ? 'pr-11' : undefined, className)}
          {...input}
        />
        <View pointerEvents="none" className="absolute top-0 left-3 h-11 justify-center">
          <Icon as={icon} size={16} className="text-muted-foreground" />
        </View>
        {right ? <View className="absolute top-0 right-0 h-11 justify-center">{right}</View> : null}
      </View>
      {fieldState.error ? (
        <Text className="text-xs text-destructive">{fieldState.error.message}</Text>
      ) : null}
    </View>
  );
}

// the label inside a primary button: spinner + loading text, or text + arrow
export function ButtonLabel({
  loading,
  loadingText,
  text,
  icon = ArrowRight,
}: {
  loading: boolean;
  loadingText: string;
  text: string;
  icon?: LucideIcon;
}) {
  return loading ? (
    <>
      <Spinner />
      <Text>{loadingText}</Text>
    </>
  ) : (
    <>
      <Text>{text}</Text>
      <Icon as={icon} size={16} className="text-primary-foreground" />
    </>
  );
}

export const TextLink = ({ onPress, children }: { onPress: () => void; children: ReactNode }) => (
  <Text onPress={onPress} className="text-xs font-medium underline">
    {children}
  </Text>
);
