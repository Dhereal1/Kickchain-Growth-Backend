'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:pointer-events-none';
  const sizes = size === 'sm' ? 'h-8 px-3' : 'h-10 px-4';
  const variants: Record<Variant, string> = {
    primary: 'bg-primary text-primary-foreground border-transparent hover:opacity-90',
    secondary: 'bg-muted text-foreground border-border hover:bg-muted/80',
    ghost: 'bg-transparent text-foreground border-transparent hover:bg-muted',
    danger: 'bg-danger text-background border-transparent hover:opacity-90',
  };

  return <button className={cn(base, sizes, variants[variant], className)} {...props} />;
}

