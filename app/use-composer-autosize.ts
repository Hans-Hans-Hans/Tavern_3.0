import { useLayoutEffect, type RefObject } from 'react';

/** Measure real wrapped text, including restored drafts and viewport changes.
 * Keep the textarea bounded when a mobile keyboard reduces available height. */
export function useComposerAutosize(input: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const element = input.current; if (!element) return;
    let width = -1;
    const measure = () => {
      const available = window.visualViewport?.height ?? window.innerHeight;
      const maximum = Math.max(48, Math.min(180, available * 0.28));
      element.style.height = 'auto';
      element.style.height = `${Math.min(maximum, Math.max(42, element.scrollHeight))}px`;
      element.style.overflowY = element.scrollHeight > maximum ? 'auto' : 'hidden';
    };
    measure();
    const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width; if (next !== width) { width = next; measure(); } });
    observer.observe(element); window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', measure); };
  }, [input, value]);
}
