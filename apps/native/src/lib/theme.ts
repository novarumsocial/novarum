// Native-only: the same colors as the class names (generated from the web theme), for places that
// can't take a class: icon colors in props, placeholder text, native switch tracks, ...
import { useColorScheme } from 'nativewind';
import theme from '../../theme.generated.json';

type Token = keyof typeof theme;

export function useThemeColors() {
  const { colorScheme } = useColorScheme();
  return Object.fromEntries(
    Object.entries(theme).map(([name, value]) => [name, value[colorScheme ?? 'dark']])
  ) as Record<Token, string>;
}
