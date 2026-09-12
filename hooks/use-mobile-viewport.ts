import { useEffect, useState } from 'react';

/** Keep the composer above a phone's keyboard without treating pinch zoom as a
 * new layout size. The browser remains responsible for scrolling focused inputs. */
export function useMobileViewport(mobile: boolean) {
  const [viewport, setViewport] = useState<{ height?: number; keyboard: boolean }>({ keyboard: false });
  useEffect(() => {
    const visual = window.visualViewport;
    if (!mobile || !visual) { setViewport({ keyboard: false }); return; }
    const update = () => {
      if (Math.abs(visual.scale - 1) > 0.01) return;
      const editing = document.activeElement?.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), [contenteditable=true]') || false;
      const height = Math.round(visual.height);
      const keyboard = editing && window.innerHeight - height > 120;
      setViewport(previous => previous.height === height && previous.keyboard === keyboard ? previous : { height, keyboard });
    };
    update();
    visual.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    window.addEventListener('resize', update);
    return () => {
      visual.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      window.removeEventListener('resize', update);
    };
  }, [mobile]);
  return mobile ? viewport : { keyboard: false };
}
