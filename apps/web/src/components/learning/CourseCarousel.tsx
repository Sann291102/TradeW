'use client';

import { useRef } from 'react';
import { IconButton, cn } from '@tradew/ui';

function ChevronIcon(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export interface CourseCarouselProps {
  children: React.ReactNode;
  className?: string;
  'aria-label': string;
}

/**
 * CourseCarousel — hand-rolled scroll-snap horizontal rail (no carousel
 * library installed in apps/web). Chevron buttons scroll by one viewport
 * width; native touch/trackpad scrolling works regardless.
 */
export function CourseCarousel({ children, className, 'aria-label': ariaLabel }: CourseCarouselProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const scrollBy = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };

  return (
    <div className={cn('relative', className)}>
      <div
        ref={trackRef}
        role="group"
        aria-label={ariaLabel}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden items-center justify-between sm:flex">
        <IconButton
          aria-label="Scroll left"
          onClick={() => scrollBy(-1)}
          className="pointer-events-auto -ml-3 bg-card shadow-card"
        >
          <ChevronIcon className="rotate-180" />
        </IconButton>
        <IconButton
          aria-label="Scroll right"
          onClick={() => scrollBy(1)}
          className="pointer-events-auto -mr-3 bg-card shadow-card"
        >
          <ChevronIcon />
        </IconButton>
      </div>
    </div>
  );
}
