export type DeviceLayoutInput = {
  width: number;
  height: number;
  userAgent: string;
  mobileHint?: boolean;
  coarsePointer: boolean;
};

/** Size governs available space; phone hints keep landscape phones compact.
 * A touch screen alone must not turn a roomy tablet or laptop into a phone. */
export function compactDeviceLayout(input: DeviceLayoutInput): boolean {
  if (input.width < 768) return true;
  const phone = (input.mobileHint === true && !/iPad/i.test(input.userAgent)) || /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(input.userAgent);
  return phone || input.coarsePointer && Math.min(input.width, input.height) < 600;
}

export function readCompactDeviceLayout(): boolean {
  if (typeof window === 'undefined') return false;
  const browser = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return compactDeviceLayout({ width: window.innerWidth, height: window.innerHeight,
    userAgent: browser.userAgent, mobileHint: browser.userAgentData?.mobile,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches });
}
