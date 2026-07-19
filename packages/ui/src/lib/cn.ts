import { clsx, type ClassValue } from 'clsx';

/**
 * Merge class names. Thin wrapper over clsx — the single class-composition
 * helper for the whole design system, so components don't each reinvent it.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
