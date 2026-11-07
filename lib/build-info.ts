import packageInfo from '../package.json';

export const appVersion = packageInfo.version;
export const frontendBuildDate: string = import.meta.env.VITE_TAVERN_BUILD_DATE;
