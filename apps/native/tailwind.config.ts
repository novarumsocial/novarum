import type { Config } from 'tailwindcss';
import { hairlineWidth } from 'nativewind/theme';
import theme from './theme.generated.json';

// Every color from the web theme as `rgb(var(--name) / alpha)`, so `bg-primary/10` works like on the web.
const colors = Object.fromEntries(
  Object.entries(theme).map(([name, { alpha }]) => [
    name,
    `rgb(var(--${name}) / ${alpha === 1 ? '<alpha-value>' : alpha})`,
  ])
);

export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors,
      borderWidth: { hairline: hairlineWidth() },
    },
  },
} satisfies Config;
