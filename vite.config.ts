import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function offlineShell(): Plugin {
  return { name: 'tavern-offline-shell', apply: 'build', enforce: 'post', generateBundle(_options, bundle) {
    const files = Object.keys(bundle).filter(name => name === 'index.html' || /^assets\/[A-Za-z0-9_.-]+\.(js|css|wasm|woff2?)$/.test(name)).sort();
    const icons = ['manifest.webmanifest', 'favicon.svg', 'tavern-icon.svg', 'tavern-icon-192.png', 'tavern-icon-512.png', 'tavern-icon-maskable.png'];
    const hash = createHash('sha256');
    for (const name of files) { const asset = bundle[name]; hash.update(name).update(asset.type === 'chunk' ? asset.code : asset.source); }
    for (const name of icons) hash.update(readFileSync(fileURLToPath(new URL('./public/' + name, import.meta.url))));
    const template = readFileSync(fileURLToPath(new URL('./scripts/service-worker.js', import.meta.url)), 'utf8'); hash.update(template);
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__TAVERN_BUILD__', hash.digest('hex').slice(0, 20)).replace('__TAVERN_STATIC_FILES__', JSON.stringify([...files, ...icons].map(name => '/' + name))) });
  } };
}

export default defineConfig({
  plugins: [react(), offlineShell()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  build: { outDir: 'dist', target: 'es2022' },
});
