import { cn } from '@/lib/cn';

type Variant = 'success' | 'warning' | 'danger' | 'muted' | 'primary';

export function Badge({
  className,
  variant = 'muted',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  const variants: Record<Variant, string> = {
    success: 'bg-success/15 text-success border-success/25',
    warning: 'bg-warning/15 text-warning border-warning/25',
    danger: 'bg-danger/15 text-danger border-danger/25',
    primary: 'bg-primary/15 text-primary border-primary/25',
    muted: 'bg-muted text-muted-foreground border-border',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        variants[variant],
        className
      )}
      {...props}
    />
  );
}

