// Native-only: lets a lucide icon take its color from a class, e.g. <Icon as={Hash} className="text-muted-foreground" />
import type { LucideIcon, LucideProps } from 'lucide-react-native';
import { cssInterop } from 'nativewind';
import { cn } from '@/lib/utils';

const wrapped = new WeakSet<object>();

export function Icon({
  as: Component,
  className,
  size = 16,
  ...props
}: LucideProps & { as: LucideIcon; className?: string }) {
  if (!wrapped.has(Component)) {
    cssInterop(Component, { className: { target: 'style', nativeStyleToProp: { color: true } } });
    wrapped.add(Component);
  }
  return <Component className={cn('text-foreground', className)} size={size} {...props} />;
}
