// Generates our own eight-color-frame clip; no camera, recording timing or external asset.
// Container fields: https://www.webmproject.org/docs/container/
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
try {
  const page = await browser.newPage();
  const frames = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; const drawing = canvas.getContext('2d');
    return Array.from({ length: 8 }, (_, index) => { drawing.fillStyle = index % 2 ? '#aa6633' : '#337799'; drawing.fillRect(0, 0, 160, 90); return canvas.toDataURL('image/webp', .8).split(',')[1]; });
  });
  const number = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const element = (id, value) => { const bytes = Array.isArray(value) ? Buffer.concat(value) : value, size = Buffer.alloc(2); if (bytes.length >= 16383) throw Error('Fixture element exceeds the small-container budget'); size.writeUInt16BE(0x4000 | bytes.length); return Buffer.concat([Buffer.from(id, 'hex'), size, bytes]); };
  const integer = (id, value) => element(id, number(value)), text = (id, value) => element(id, Buffer.from(value));
  const duration = Buffer.alloc(8); duration.writeDoubleBE(4000);
  const header = element('1a45dfa3', [integer('4286', 1), integer('42f7', 1), integer('42f2', 4), integer('42f3', 8), text('4282', 'webm'), integer('4287', 2), integer('4285', 2)]);
  const info = element('1549a966', [integer('2ad7b1', 1000000), text('4d80', 'Tavern fixture'), text('5741', 'Tavern fixture'), element('4489', duration)]);
  const tracks = element('1654ae6b', [element('ae', [integer('d7', 1), integer('73c5', 1), integer('83', 1), integer('9c', 0), text('86', 'V_VP8'), element('e0', [integer('b0', 160), integer('ba', 90)])])]);
  const clusters = frames.map((frame, index) => {
    const webp = Buffer.from(frame, 'base64'); let offset = 12, vp8;
    while (offset + 8 <= webp.length) { const size = webp.readUInt32LE(offset + 4); if (webp.toString('ascii', offset, offset + 4) === 'VP8 ') { vp8 = webp.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + size % 2; }
    if (!vp8) throw Error('The browser did not produce a VP8 still frame');
    return element('1f43b675', [integer('e7', index * 500), element('a3', Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), vp8]))]);
  });
  const seek = (id, position) => element('4dbb', [element('53ab', Buffer.from(id, 'hex')), integer('53ac', position)]);
  const seekHead = positions => element('114d9b74', [seek('1549a966', positions[0]), seek('1654ae6b', positions[1]), seek('1c53bb6b', positions[2])]);
  const start = seekHead([0, 0, 0]).length, firstCluster = start + info.length + tracks.length; let offset = firstCluster;
  const cues = element('1c53bb6b', clusters.map((cluster, index) => { const position = offset; offset += cluster.length; return element('bb', [integer('b3', index * 500), element('b7', [integer('f7', 1), integer('f1', position)])]); }));
  const result = Buffer.concat([header, element('18538067', [seekHead([start, start + info.length, offset]), info, tracks, ...clusters, cues])]);
  writeFileSync(new URL('../tests/browser/fixtures/recording.webm', import.meta.url), result);
  console.log(`Generated ${result.length}-byte 160×90 VP8 fixture with 4 seconds of synthetic frames.`);
} finally { await browser.close(); }
