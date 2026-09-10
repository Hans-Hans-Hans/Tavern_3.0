import { createHash } from 'node:crypto';
import ts from 'typescript';
import MagicString from 'magic-string';
import remapping from '@jridgewell/remapping';

export const PINNED_CALL_ASSET = 'index-DPkEeOAp.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const ASSET_HASH = 'd430e06908dcf717538fb91a8f6bc85f36f0fb90a2924f429b6848a81477665b';
const MAP_HASH = '151e65d43e328b2930d1a531627953a8b353368ad3f003d196d2e2a44aaac8fe';
const sourceName = '../../src/state/CallViewModel/CallViewModel.ts';

/** One reviewed native lifecycle hook. Reject upgrades or changed structure;
 * do not match minified variable names or modify capture/connection behavior. */
export function transformCallTelemetry(code, mapText) {
  if (digest(code) !== ASSET_HASH || digest(mapText) !== MAP_HASH) throw new Error('Element Call telemetry source changed; review the pinned asset and corresponding source.');
  const original = JSON.parse(mapText), sourceIndex = original.sources.indexOf(sourceName);
  if (sourceIndex < 0 || !original.sourcesContent[sourceIndex].includes('export function createCallViewModel$(')) throw new Error('Missing corresponding Element Call view-model source.');
  const ast = ts.createSourceFile(PINNED_CALL_ASSET, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS), matches = [];
  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const fields = node.expression.properties.map(property => property.name?.getText(ast));
      if (['connected$', 'reconnecting$', 'localMatrixLivekitMember$', 'remoteMatrixLivekitMembers$', 'allConnections$'].every(field => fields.includes(field))) matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (ast.parseDiagnostics.length || matches.length !== 1) throw new Error('Element Call telemetry hook is no longer unique.');
  const target = matches[0]; let parent = target.parent;
  while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
  if (!parent || parent.parameters.length !== 9 || target.parent !== parent.body || !parent.parameters.every(parameter => ts.isIdentifier(parameter.name))) throw new Error('Element Call telemetry lifecycle signature changed.');
  const scope = parent.parameters[0].name.text, room = parent.parameters[2].name.text;
  const changed = new MagicString(code, { filename: PINNED_CALL_ASSET });
  changed.prepend('import { attachEmbeddedCallTelemetry as __tavernCallTelemetry } from "./embedded-call-telemetry.js";\n');
  changed.appendLeft(target.expression.getStart(ast), `__tavernCallTelemetry(${scope},${room},`);
  changed.appendRight(target.expression.end, ')');
  const intermediate = changed.generateMap({ source: PINNED_CALL_ASSET, file: PINNED_CALL_ASSET, includeContent: true, hires: true });
  const composed = remapping([JSON.parse(intermediate.toString()), original], () => null);
  return { code: changed.toString(), map: JSON.stringify(composed) };
}
