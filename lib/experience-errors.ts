export function experienceError(error: unknown, context: 'upload' | 'login' | 'invite' | 'call' | 'save' = 'save') {
  const value = error as any;
  const status = Number(value?.httpStatus ?? value?.status);
  const rawCode = value?.data?.errcode ?? value?.details?.errcode ?? value?.errcode ?? value?.code;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode) ? rawCode : '';
  const raw = typeof value?.message === 'string' ? value.message : typeof error === 'string' ? error : '';
  let message = raw.length <= 500 && !/(?:https?:|wss?:|access_token|Bearer\s|password\s*[:=]|secret\s*[:=]|eyJ[A-Za-z0-9_-]{12})/i.test(raw) ? raw : '';
  if (context === 'upload' && (status === 413 || code === 'M_TOO_LARGE')) message = 'This file is larger than the server or reverse proxy allows. Choose a smaller file or ask an administrator to check Admin → Storage.';
  else if (status === 429) message = 'Too many attempts in a short time. Wait a moment, then try again.';
  else if (status === 401 && context !== 'login') message = 'Your session needs attention. Sign in again, then retry.';
  else if (value?.name === 'TimeoutError' || /^(Failed to fetch|NetworkError|Load failed)/i.test(raw)) message = 'The server could not be reached. Check your connection, then retry.';
  else if (status >= 500 && !message) message = 'The server could not finish this request. Try again in a moment.';
  return { message: message || 'This request could not be completed. Try again.', code, status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined };
}
