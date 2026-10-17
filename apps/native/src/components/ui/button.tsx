// Port of apps/frontend/src/lib/components/ui/button (shadcn-svelte -> react-native-reusables style)
import { cva, type VariantProps } from 'class-variance-authority';
import { Pressable, type PressableProps } from 'react-native';
import { cn } from '@/lib/utils';
import { TextClassContext } from './text';

const buttonVariants = cva('flex-row items-center justify-center gap-2 rounded-none', {
  variants: {
    variant: {
      default: 'bg-primary active:opacity-80',
      destructive: 'bg-destructive active:opacity-80',
      outline: 'border border-input bg-background active:bg-accent',
      secondary: 'bg-secondary active:opacity-80',
      ghost: 'active:bg-accent',
      link: '',
    },
    size: {
      default: 'min-h-11 px-4',
      sm: 'min-h-9 px-3',
      lg: 'min-h-12 px-6',
      icon: 'min-h-11 min-w-11',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

const buttonTextVariants = cva('text-sm font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
      link: 'text-link underline',
    },
  },
  defaultVariants: { variant: 'default' },
});

type ButtonProps = PressableProps & VariantProps<typeof buttonVariants> & { className?: string };

export function Button({ className, variant, size, disabled, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant })}>
      <Pressable
        role="button"
        disabled={disabled}
        className={cn(buttonVariants({ variant, size }), disabled && 'opacity-50', className)}
        // small buttons still take a finger-sized tap
        hitSlop={size === 'sm' ? 4 : undefined}
        {...props}
      />
    </TextClassContext.Provider>
  );
}
