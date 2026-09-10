import type { ConferenceFailure } from '@/lib/conference-telemetry-protocol';
import { copyText } from './action-menu';
import { toast } from 'sonner';

export function ConferenceDiagnostics({ failure }: { failure: ConferenceFailure | null | undefined }) {
  if (!failure) return null;
  const message = failure.code === 'OPEN_ID_ERROR' ? 'The call could not obtain authorization from its call service.'
    : ['CONNECTION_LOST_ERROR', 'INTERNAL_MEMBERSHIP_MANAGER'].includes(failure.code) ? 'The call could not keep its room membership active.'
    : failure.code === 'E2EE_NOT_SUPPORTED' ? 'This browser could not enable call encryption.'
    : failure.code === 'INSUFFICIENT_CAPACITY_ERROR' ? 'The call server has reached a capacity limit.'
    : failure.code === 'MISSING_MATRIX_RTC_TRANSPORT' ? 'No configured call service was available.'
    : failure.code === 'SFU_ERROR' || failure.code === 'FAILED_TO_START_LIVEKIT' ? 'The active media connection failed.'
    : 'The active call encountered an error.';
  // Only fields validated by the telemetry protocol are copied. There is no
  // raw exception, token, URL, account identifier or browser console dump.
  const details = JSON.stringify({ code: failure.code, cause: failure.cause, status: failure.status, reason: failure.reason, matrixCode: failure.matrixCode }, null, 2);
  return <section className="conference-diagnostic" role="alert" aria-label="Call error details">
    <strong>Call connection needs attention</strong><p>{message}</p>
    <details open><summary>Error details for your administrator</summary><pre>{details}</pre></details>
    <button className="secondary-button" onClick={() => void copyText(details, 'Call error details copied').catch(() => toast.error('Copy was unavailable. Select the displayed error details instead.'))}>Copy call error details</button>
  </section>;
}
