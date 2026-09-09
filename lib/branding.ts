export const brandingAsset = (value?: string) => value && /^\/api\/branding\/assets\/[a-f0-9]{64}\.png$/.test(value) ? value : '';
