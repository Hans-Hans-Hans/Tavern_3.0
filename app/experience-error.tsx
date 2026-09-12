import { experienceError } from '@/lib/experience-errors';
export function ExperienceError({ error, context = 'save', draft, retry, onSettings }: { error: unknown; context?: Parameters<typeof experienceError>[1]; draft?: string; retry?: () => void; onSettings?: () => void }) {
  if (!error) return null;
  const value = experienceError(error, context);
  return <div className="experience-error" role="alert"><p>{value.message}</p>{draft && <p>{draft}</p>}<div className="product-actions">{retry && <button type="button" className="secondary-button" onClick={retry}>Retry</button>}{onSettings && <button type="button" className="secondary-button" onClick={onSettings}>Open settings</button>}</div>{(value.code || value.status) && <details><summary>Technical details</summary><p>{value.code && <>Code: {value.code}<br/></>}{value.status && <>HTTP status: {value.status}</>}</p></details>}</div>;
}
