import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { PINNED_CALL_ASSET, transformCallTelemetry } from './transform-call-telemetry.mjs';
const source='node_modules/@element-hq/element-call-embedded';
const pkg=JSON.parse(await readFile(`${source}/package.json`,'utf8'));
if(pkg.version!=='0.25.0')throw new Error('Review Element Call assets and widget capabilities before upgrading.');
await mkdir('public/element-call',{recursive:true});
await cp(`${source}/dist`,'public/element-call',{recursive:true});
const asset=`${source}/dist/assets/${PINNED_CALL_ASSET}`;
const transformed=transformCallTelemetry(await readFile(asset,'utf8'),await readFile(asset+'.map','utf8'));
await writeFile(`public/element-call/assets/${PINNED_CALL_ASSET}`,transformed.code);
await writeFile(`public/element-call/assets/${PINNED_CALL_ASSET}.map`,transformed.map);
for(const name of ['embedded-call-telemetry','conference-telemetry-protocol','conference-output']){
  const text=await readFile(`lib/${name}.ts`,'utf8');
  const output=ts.transpileModule(text,{fileName:`${name}.ts`,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,sourceMap:true,inlineSources:true}});
  const map=JSON.parse(output.sourceMapText);map.sources=[`../../../../lib/${name}.ts`];
  await writeFile(`public/element-call/assets/${name}.js`,output.outputText);
  await writeFile(`public/element-call/assets/${name}.js.map`,JSON.stringify(map));
}
let html=await readFile('public/element-call/index.html','utf8'),index=0;
for(const match of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]){const name=`tavern-bootstrap-${index++}.js`;await writeFile(`public/element-call/${name}`,match[1]);html=html.replace(match[0],`<script src="./${name}"></script>`);}
if(index!==2)throw new Error('Unexpected Element Call bootstrap. Review its CSP before packaging.');
await writeFile('public/element-call/index.html',html);
await writeFile('public/element-call/config.json',JSON.stringify({matrix_rtc_mode:'compatibility'}));
await cp(`${source}/LICENSE-AGPL-3.0`,'public/element-call/LICENSE-AGPL-3.0');
await cp(`${source}/LICENSE-COMMERCIAL`,'public/element-call/LICENSE-COMMERCIAL');
await writeFile('public/element-call/SOURCE.txt','Element Call embedded 0.25.0\nCorresponding upstream source: https://github.com/element-hq/element-call/tree/efde51b8c1e136fca17d38ec408b0a7dbb2f17e9\nTavern modifications: externalized two inline bootstrap scripts, supplied local compatibility config, and attached bounded telemetry and explicit local playback controls to the existing call view-model lifecycle. Reproducible modification scripts: scripts/prepare-call-assets.mjs and scripts/transform-call-telemetry.mjs; bridge source: lib/embedded-call-telemetry.ts, lib/conference-output.ts and lib/conference-telemetry-protocol.ts in the Tavern source distribution. Composed source maps retain corresponding upstream sources and include the added bridge source.\n');
