/** The active voice page supplies geometry; the persistent iframe never moves. */
export type VoiceChannelView = { roomId: string; left: number; top: number; width: number; height: number } | null;
let state: VoiceChannelView = null;
let owner: object | null = null;
const listeners = new Set<() => void>();
export const voiceChannelView = () => state;
export function subscribeVoiceChannelView(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function attachVoiceChannelView(roomId: string, element: HTMLElement) {
  const identity = {}; owner = identity;
  const measure = () => {
    if (owner !== identity || !element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const next = rect.width > 0 && rect.height > 0 ? { roomId, left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; listeners.forEach(listener => listener()); }
  };
  const observer = new ResizeObserver(measure); observer.observe(element);
  window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
  window.visualViewport?.addEventListener('resize', measure); window.visualViewport?.addEventListener('scroll', measure);
  measure();
  return () => {
    observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true);
    window.visualViewport?.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('scroll', measure);
    if (owner === identity) { owner = null; state = null; listeners.forEach(listener => listener()); }
  };
}
