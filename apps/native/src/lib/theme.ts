// Native-only: the same colors as the class names (generated from the web theme), for places that
// can't take a class: icon colors in props, placeholder text, native switch tracks, ...
import { useColorScheme } from 'nativewind';
import theme from '../../theme.generated.json';

type Token = keyof typeof theme;

// built once, so every caller gets the same object (no new one per render)
const palette = (scheme: 'light' | 'dark') =>
  Object.fromEntries(Object.entries(theme).map(([name, value]) => [name, value[scheme]])) as Record<
    Token,
    string
  >;
const palettes = { light: palette('light'), dark: palette('dark') };

export function useThemeColors() {
  const { colorScheme } = useColorScheme();
  return palettes[colorScheme ?? 'dark'];
}
