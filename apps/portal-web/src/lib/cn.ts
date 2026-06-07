import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Une classes Tailwind resolvendo conflitos (ultima vence). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
