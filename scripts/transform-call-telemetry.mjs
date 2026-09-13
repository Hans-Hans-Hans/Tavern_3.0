import { createHash } from 'node:crypto';
import ts from 'typescript';
import MagicString from 'magic-string';
import remapping from '@jridgewell/remapping';

export const PINNED_CALL_ASSET = 'index-DPkEeOAp.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const ASSET_HASH = 'd430e06908dcf717538fb91a8f6bc85f36f0fb90a2924f429b6848a81477665b';
const MAP_HASH = '151e65d43e328b2930d1a531627953a8b353368ad3f003d196d2e2a44aaac8fe';
const sourceName = '../../src/state/CallViewModel/CallViewModel.ts';

/** Reviewed lifecycle and finite error-projection hooks. Reject changed structure;
 * do not match minified variable names or modify capture/connection behavior. */
export function transformCallTelemetry(code, mapText) {
  if (digest(code) !== ASSET_HASH || digest(mapText) !== MAP_HASH) throw new Error('Element Call telemetry source changed; review the pinned asset and corresponding source.');
  const original = JSON.parse(mapText), sourceIndex = original.sources.indexOf(sourceName);
  if (sourceIndex < 0 || !original.sourcesContent[sourceIndex].includes('export function createCallViewModel$(')) throw new Error('Missing corresponding Element Call view-model source.');
  const ast = ts.createSourceFile(PINNED_CALL_ASSET, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS), matches = [], errors = [];
  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const fields = node.expression.properties.map(property => property.name?.getText(ast));
      if (['connected$', 'reconnecting$', 'localMatrixLivekitMember$', 'remoteMatrixLivekitMembers$', 'allConnections$'].every(field => fields.includes(field))) matches.push(node);
    }
    if (ts.isConstructorDeclaration(node) && node.body && node.parameters.length === 1 && ts.isIdentifier(node.parameters[0].name)) {
      const assignments = [], parameter = node.parameters[0].name.text;
      function collect(part) { if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(part); ts.forEachChild(part, collect); }
      collect(node.body);
      const assignment = assignments.find(expression => expression.left.getText(ast) === 'this.localisedMessageValues' && ts.isObjectLiteralExpression(expression.right)
        && expression.right.properties.length === 1 && expression.right.properties[0].name?.getText(ast) === 'reason'
        && expression.right.properties[0].initializer?.getText(ast) === parameter + '.reasonName');
      const description = assignments.some(expression => expression.left.getText(ast) === 'this.localisedMessageKey' && ts.isCallExpression(expression.right)
        && expression.right.arguments.length === 1 && ts.isStringLiteralLike(expression.right.arguments[0])
        && expression.right.arguments[0].text === 'error.livekit_connection_error_description');
      if (assignment && description) errors.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (ast.parseDiagnostics.length || matches.length !== 1 || errors.length !== 1) throw new Error('Element Call telemetry hooks are no longer unique.');
  const errorSource = original.sources.indexOf('../../src/utils/errors.ts');
  if (errorSource < 0 || !original.sourcesContent[errorSource].includes('export class LivekitConnectionError extends ElementCallError')) throw new Error('Missing corresponding Element Call connection-error source.');
  const target = matches[0]; let parent = target.parent;
  while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
  if (!parent || parent.parameters.length !== 9 || target.parent !== parent.body || !parent.parameters.every(parameter => ts.isIdentifier(parameter.name))) throw new Error('Element Call telemetry lifecycle signature changed.');
  const scope = parent.parameters[0].name.text, room = parent.parameters[2].name.text;
  const changed = new MagicString(code, { filename: PINNED_CALL_ASSET });
  changed.prepend('import { attachEmbeddedCallTelemetry as __tavernCallTelemetry } from "./embedded-call-telemetry.js";\nimport { retainConferenceFailure as __tavernCallFailure } from "./conference-telemetry-protocol.js";\n');
  // The pinned bundle uses `return{...}` without whitespace. Inserting an
  // identifier at the brace must keep it separate from the return keyword.
  changed.appendLeft(target.expression.getStart(ast), ` __tavernCallTelemetry(${scope},${room},`);
  changed.appendRight(target.expression.end, ')');
  const connectionError = errors[0];
  changed.appendLeft(connectionError.body.end - 1, `;__tavernCallFailure(this,${connectionError.parameters[0].name.text});`);
  const intermediate = changed.generateMap({ source: PINNED_CALL_ASSET, file: PINNED_CALL_ASSET, includeContent: true, hires: true });
  const composed = remapping([JSON.parse(intermediate.toString()), original], () => null);
  return { code: changed.toString(), map: JSON.stringify(composed) };
}
