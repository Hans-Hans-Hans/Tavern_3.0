import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
const source='node_modules/@element-hq/element-call-embedded';
const pkg=JSON.parse(await readFile(`${source}/package.json`,'utf8'));
if(pkg.version!=='0.25.0')throw new Error('Review Element Call assets and widget capabilities before upgrading.');
await mkdir('public/element-call',{recursive:true});
await cp(`${source}/dist`,'public/element-call',{recursive:true});
let html=await readFile('public/element-call/index.html','utf8'),index=0;
for(const match of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]){const name=`tavern-bootstrap-${index++}.js`;await writeFile(`public/element-call/${name}`,match[1]);html=html.replace(match[0],`<script src="./${name}"></script>`);}
if(index!==2)throw new Error('Unexpected Element Call bootstrap. Review its CSP before packaging.');
await writeFile('public/element-call/index.html',html);
await writeFile('public/element-call/config.json',JSON.stringify({matrix_rtc_mode:'compatibility'}));
await cp(`${source}/LICENSE-AGPL-3.0`,'public/element-call/LICENSE-AGPL-3.0');
await cp(`${source}/LICENSE-COMMERCIAL`,'public/element-call/LICENSE-COMMERCIAL');
await writeFile('public/element-call/SOURCE.txt','Element Call embedded 0.25.0\nCorresponding upstream source: https://github.com/element-hq/element-call/tree/efde51b8c1e136fca17d38ec408b0a7dbb2f17e9\nTavern modifications: externalized the two inline bootstrap scripts and supplied local compatibility config. Reproducible modification script: scripts/prepare-call-assets.mjs in the Tavern source distribution.\n');
