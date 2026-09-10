import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PINNED_CALL_ASSET, transformCallTelemetry } from '../scripts/transform-call-telemetry.mjs';

test('actual transformed view returns through the helper instead of evaluating a return-prefixed identifier', () => {
  const file = new URL('../node_modules/@element-hq/element-call-embedded/dist/assets/' + PINNED_CALL_ASSET, import.meta.url);
  const original = readFileSync(file, 'utf8'), map = readFileSync(new URL(file + '.map'), 'utf8');
  const upstream = ts.createSourceFile('upstream.js', original, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  let originalReturn;
  const find = node => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression) &&
        ['connected$', 'remoteMatrixLivekitMembers$', 'allConnections$'].every(name => node.expression.properties.some(property => property.name?.getText(upstream) === name))) originalReturn = node;
    ts.forEachChild(node, find);
  };
  find(upstream); assert.ok(originalReturn);
  const originalFunction = originalReturn.parent.parent;
  assert.ok(ts.isFunctionDeclaration(originalFunction));
  assert.equal(original.slice(originalReturn.getStart(upstream), originalReturn.expression.getStart(upstream)), 'return', 'fixture must exercise the actual minified return{ boundary');
  const transformed = transformCallTelemetry(original, map).code;
  const check = code => {
    const ast = ts.createSourceFile('patched.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0);
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === originalFunction.name.text);
    assert.ok(fn);
    const statement = fn.body.statements.at(-1);
    assert.ok(ts.isReturnStatement(statement), 'patched view must retain a real return statement');
    assert.ok(ts.isCallExpression(statement.expression));
    assert.equal(statement.expression.expression.getText(ast), '__tavernCallTelemetry');
    assert.equal(statement.expression.arguments.length, 3);
    assert.ok(ts.isObjectLiteralExpression(statement.expression.arguments[2]));
    // Execute the exact transformed return statement. Stub only its existing
    // lexical dependencies; the statement and native result object are intact.
    let calls = 0, captured;
    const stub = new Proxy(function () {}, { apply: () => stub, get: (_, key) => key === Symbol.toPrimitive ? () => '' : stub });
    const scope = new Proxy({}, { get: () => stub }), room = {};
    const names = { [fn.parameters[0].name.text]: scope, [fn.parameters[2].name.text]: room, __tavernCallTelemetry: (actualScope, actualRoom, view) => {
      assert.equal(actualScope, scope); assert.equal(actualRoom, room); calls++; captured = view; return view;
    } };
    const bindings = new Proxy(names, { has: () => true, get: (object, key) => key === Symbol.unscopables ? undefined : Object.hasOwn(object, key) ? object[key] : stub });
    const result = new Function('bindings', 'with(bindings){' + statement.getText(ast) + '}')(bindings);
    assert.equal(calls, 1); assert.equal(result, captured);
    for (const key of ['fatalError$', 'connected$', 'remoteMatrixLivekitMembers$', 'localMatrixLivekitMember$']) assert.ok(Object.hasOwn(result, key));
  };
  check(transformed);
  // The broken output is valid JavaScript too. Parsing alone must never be the
  // success criterion for the known return__tavernCallTelemetry regression.
  const broken = transformed.replace(/return\s+__tavernCallTelemetry\(/, 'return__tavernCallTelemetry(');
  assert.notEqual(broken, transformed);
  assert.throws(() => check(broken), /real return statement/);
});

