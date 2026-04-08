'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring',
        className
      )}
      {...props}
    />
  );
}

