export function sharedLocalTime(instant: number, zone: string, locale?: string) {
  if (!Number.isFinite(instant) || !zone) return null;
  try {
    const formatter = new Intl.DateTimeFormat(locale, {timeZone:zone,weekday:'short',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
    const hour = Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).format(instant));
    return {label:formatter.format(instant),daytime:hour>=8&&hour<22};
  } catch { return null; }
}
export function localDateInput(instant: number) {
  const date=new Date(instant),pad=(n:number)=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
