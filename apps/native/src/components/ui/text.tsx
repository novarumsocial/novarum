// Native-only building block: the web styles text through CSS, React Native needs a Text component.
// Custom fonts have no synthetic weights, so `font-medium` / `font-bold` pick the matching IBM Plex file.
import * as React from 'react';
import { Text as RNText, type TextProps } from 'react-native';
import { cn } from '@/lib/utils';

export const TextClassContext = React.createContext<string | undefined>(undefined);

const families = {
  'font-mono': 'IBMPlexMono_400Regular',
  'font-medium': 'IBMPlexSans_500Medium',
  'font-semibold': 'IBMPlexSans_600SemiBold',
  'font-bold': 'IBMPlexSans_700Bold',
} as const;

export function fontFamilyFor(className: string) {
  const names = className.split(/\s+/);
  const match = (Object.keys(families) as (keyof typeof families)[]).find((n) => names.includes(n));
  return match ? families[match] : 'IBMPlexSans_400Regular';
}

export function Text({ className, style, ...props }: TextProps & { className?: string }) {
  const inherited = React.useContext(TextClassContext);
  const classes = cn('text-base text-foreground', inherited, className);
  return (
    <RNText
      className={classes}
      style={[{ fontFamily: fontFamilyFor(classes) }, style]}
      {...props}
    />
  );
}
