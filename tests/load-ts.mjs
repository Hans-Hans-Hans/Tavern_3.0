import ts from 'typescript';
import { readFileSync } from 'node:fs';
export function loadTs(path, dependencies) {
  const result=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
  const exports={};new Function('require','exports',result.outputText)(name=>{if(!(name in dependencies))throw new Error('Unexpected dependency: '+name);return dependencies[name];},exports);return exports;
}
