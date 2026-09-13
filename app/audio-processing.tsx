import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { readAudioProcessing, saveAudioProcessing, subscribeAudioProcessing, speechProcessing, musicProcessing, audioProcessingKeys, type AudioProcessing, type AudioProcessingReport } from '@/lib/audio-processing';
import './audio-processing.css';
const names = { noiseSuppression: 'Noise suppression', echoCancellation: 'Echo cancellation', autoGainControl: 'Automatic microphone gain' };
export function AudioProcessingSettings({ report, onChange }: { report?: AudioProcessingReport | null; onChange?: (patch: Partial<AudioProcessing>) => Promise<unknown> }) {
  const settings = useSyncExternalStore(subscribeAudioProcessing, readAudioProcessing);
  const preset = audioProcessingKeys.every(key => settings[key] === speechProcessing[key]) ? 'speech' : audioProcessingKeys.every(key => settings[key] === musicProcessing[key]) ? 'music' : 'custom';
  const confirmed = report?.state === 'applied' && audioProcessingKeys.every(key => report[key] === settings[key]);
  async function change(patch: Partial<AudioProcessing>) {
    try { if (onChange) await onChange(patch); else saveAudioProcessing(patch); }
    catch (error) { toast.error((error as Error).message); }
  }
  return <div className="audio-processing-settings" aria-label="Microphone processing" data-audio-mode={preset} data-audio-confirmed={confirmed}>
    <label>Microphone mode<select aria-label="Microphone mode" value={preset} onChange={event => void change(event.target.value === 'music' ? musicProcessing : speechProcessing)}><option value="speech">Speech — reduce background noise</option><option value="music">Music — preserve microphone detail</option>{preset === 'custom' && <option value="custom" disabled>Custom</option>}</select></label>
    <p>Speech reduces steady background noise and speaker echo. Music keeps echo cancellation and turns off noise suppression and automatic gain. Saved for calls on this browser.</p>
    <details><summary>Advanced microphone processing</summary>{audioProcessingKeys.map(key => <label className="call-check" key={key}><input type="checkbox" checked={settings[key]} onChange={event => void change({ [key]: event.target.checked })}/>{names[key]}</label>)}</details>
    <p role="status">{!report || report.state === 'waiting' ? 'Microphone processing will be checked when your microphone is available.' : report.state === 'applying' || report.state === 'applied' && !confirmed ? 'Applying microphone processing…' : confirmed ? 'Microphone settings confirmed by this browser.' : report.state === 'failed' ? 'The browser could not apply processing. Change the mode or select your microphone again to retry.' : 'This browser cannot confirm every processing setting. Audio processing varies by browser and device.'}</p>
  </div>;
}
