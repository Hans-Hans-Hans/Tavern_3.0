import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { loadTs } from './load-ts.mjs';

const roleTokens = loadTs('../lib/role-mention-token.ts');
const { parseMessageMarkdown: parse, messageLinkUrl, markdownLimits, visibleMessageLinks, roleMentionLinks, roleMentionOrdinaryText } = loadTs('../lib/message-markdown.ts', { 'markdown-it': { default: MarkdownIt }, './role-mention-token': roleTokens });
const flatten = nodes => nodes.flatMap(node => [node, ...('children' in node ? flatten(node.children) : [])]);
const all = text => flatten(parse(text).nodes);
const textOf = nodes => nodes.map(node => node.type === 'text' || node.type === 'code' ? node.text : 'children' in node ? textOf(node.children) : '').join('');

test('CommonMark headings, emphasis, nesting and escapes preserve structure', () => {
  const result = parse('# Heading\n\nA *nested **bold** phrase* and __strong__ and ~~gone~~.\n\\*literal\\* and &lt;tag&gt;');
  assert.equal(result.plain, false);
  const nodes = flatten(result.nodes);
  assert.ok(nodes.find(node => node.tag === 'h1'));
  const italic = nodes.find(node => node.tag === 'em');
  assert.ok(italic.children.some(node => node.tag === 'strong'));
  assert.ok(nodes.find(node => node.tag === 'del'));
  assert.match(textOf(result.nodes), /\*literal\* and <tag>/);
});

test('nested lists, ordered start, blockquotes, tables and line breaks stay semantic', () => {
  const nodes = all('- outer\n  - inner\n\n3. third\n4. fourth\n\n> quote\n>\n> > nested\n\nName | Value\n--- | ---\nA | B\n\nnext\nline');
  assert.equal(nodes.filter(node => node.tag === 'ul').length, 2);
  assert.equal(nodes.find(node => node.tag === 'ol').start, 3);
  assert.equal(nodes.filter(node => node.tag === 'blockquote').length, 2);
  assert.equal(nodes.filter(node => node.tag === 'table').length, 1);
  assert.ok(nodes.some(node => node.type === 'break'));
});

test('variable fences and inline code preserve literal Markdown and code payload', () => {
  const source = '````js\nconst html = "<img src=x>";\n```literal```\n||not a spoiler||\n````\n\n``backtick ` and **literal**``\n\n~~~python\nreturn 42\n~~~';
  const nodes = all(source), code = nodes.filter(node => node.type === 'code');
  assert.equal(code.length, 3);
  assert.equal(code[0].language, 'js');
  assert.equal(code[0].text, 'const html = "<img src=x>";\n```literal```\n||not a spoiler||\n');
  assert.equal(code[1].text, 'backtick ` and **literal**');
  assert.equal(code[2].language, 'python');
  assert.equal(nodes.filter(node => node.type === 'spoiler').length, 0);
});

test('spoilers support nested inline formatting and ignore escaped or code delimiters', () => {
  const nodes = all('Before ||**secret** [link](https://example.org) and `||`|| after \\|\\|visible\\|\\|.');
  const spoilers = nodes.filter(node => node.type === 'spoiler');
  assert.equal(spoilers.length, 1);
  assert.equal(spoilers[0].children.find(node => node.tag === 'strong').children[0].text, 'secret');
  assert.ok(spoilers[0].children.find(node => node.type === 'link'));
  assert.ok(nodes.some(node => node.type === 'text' && node.text.includes('||visible||')));
  assert.equal(all('Unmatched || stays literal').filter(node => node.type === 'spoiler').length, 0);
});

test('only explicit credential-free http(s) links can navigate, including references and escaped URLs', () => {
  const nodes = all('[safe **label**](https://example.org/a_(b) "title") and https://example.org/path.\n\n[ref][id]\n\n[id]: https://example.org/ref\n\n[email](mailto:a@example.org) [relative](/admin) [bad](javascript:alert(1))');
  assert.deepEqual(nodes.filter(node => node.type === 'link').map(node => node.href), ['https://example.org/a_(b)', 'https://example.org/path', 'https://example.org/ref']);
  for (const url of ('javascript:alert(1)|data:text/html,evil|file:///tmp/a|blob:https://x/y|ftp://example.org|//example.org|/relative|https://user:pass@example.org|https://user@example.org| https://example.org|https://example.org/\npath').split('|')) assert.equal(messageLinkUrl(url), null, url);
  assert.equal(messageLinkUrl('HTTPS://example.org/a'), 'https://example.org/a');
});

test('HTML remains text and image markup creates explicit links without resource nodes', () => {
  const nodes = all('<script>alert(1)</script>\n<img src="https://tracker.invalid/pixel">\n\n![description](https://example.org/image.svg)');
  assert.ok(textOf(nodes).includes('<script>'));
  assert.equal(nodes.filter(node => node.type === 'link').at(-1).children[0].text, '[Image: description]');
  assert.ok(nodes.every(node => ['text', 'break', 'rule', 'code', 'link', 'spoiler', 'element'].includes(node.type)));
  assert.ok(nodes.every(node => !['script', 'img', 'iframe', 'style', 'video', 'audio', 'object'].includes(node.tag)));
});

test('strict role mention destinations render inert labels and never broaden navigable URLs', () => {
  const valid = roleTokens.roleMentionToken({ serverId: '!server:local', roleId: 'helpers', name: 'Helpers & friends' });
  const result = parse(valid);
  assert.equal(result.plain, false);
  assert.equal(textOf(result.nodes), '@Helpers & friends');
  assert.equal(flatten(result.nodes).filter(node => node.type === 'link').length, 0);
  assert.equal(messageLinkUrl(roleTokens.roleMentionUri('!server:local', 'helpers')), null);
  for (const uri of ['tavern-role:!server:local/helpers', 'tavern-role:%21server%3Alocal/helpers?x', 'TAVERN-ROLE:%21server%3Alocal/helpers', 'tavern-role:%ZZ/helpers', 'other-scheme:role']) {
    const source = '[@label](' + uri + ')';
    const rejected = parse(source);
    assert.equal(textOf(rejected.nodes), source);
    assert.equal(flatten(rejected.nodes).filter(node => node.type === 'link').length, 0);
  }
});

test('preview discovery follows visible rendered links and suppresses spoilers, code and collapsed fallback', () => {
  assert.deepEqual(visibleMessageLinks('||https://hidden.example/secret|| `https://code.example/`\n\n```\nhttps://fenced.example/\n```\n\n[||hidden label||](https://label.example/) [balanced](https://visible.example/a_(b))\nhttps://visible.example/a_(b)'), ['https://visible.example/a_(b)']);
  assert.deepEqual(visibleMessageLinks('***'.repeat(100) + 'https://hidden.example' + '***'.repeat(100)), []);
  assert.deepEqual(visibleMessageLinks('https://hidden.example ' + 'x'.repeat(32000)), []);
  assert.deepEqual(visibleMessageLinks([1, 2, 3, 4].map(id => 'https://visible.example/' + id).join(' ')), [1, 2, 3].map(id => 'https://visible.example/' + id));
});

test('role notification projection excludes quotes, code, hidden spoilers and escaped examples', () => {
  const token = roleTokens.roleMentionToken({ serverId: '!server:local', roleId: 'helpers', name: 'Helpers' });
  const visible = [{ serverId: '!server:local', roleId: 'helpers' }];
  assert.deepEqual(roleMentionLinks('**' + token + '**'), visible);
  for (const body of ['> ' + token, '`' + token + '`', '```\n' + token + '\n```', '||' + token + '||', '\\' + token, '[@||hidden||](tavern-role:%21server%3Alocal/helpers)', '***'.repeat(100) + token + '***'.repeat(100), token + 'x'.repeat(32000)]) assert.deepEqual(roleMentionLinks(body), [], body.slice(0, 100));
  assert.deepEqual(roleMentionLinks('> ' + token + '\n\n' + token), visible);
});

test('ordinary mention projection excludes inline and reference role labels without merging fragments', () => {
  const uri = roleTokens.roleMentionUri('!server:local', 'helpers');
  const source = '[@everyone][role] and [**@Alice**](' + uri + ')\n\n[role]: ' + uri;
  assert.equal(roleMentionLinks(source).length, 2);
  const ordinary = roleMentionOrdinaryText(source);
  assert.doesNotMatch(ordinary, /@everyone|@Alice|tavern-role:/);
  assert.equal(ordinary.trim(), 'and');
  const preserved = roleMentionOrdinaryText('[@Helpers](' + uri + ') **@Alice** `@Code` ||@Spoiler||\n\n> @Quoted\n\n@eve**ryone**');
  for (const name of ['@Alice', '@Code', '@Spoiler', '@Quoted']) assert.ok(preserved.includes(name), name);
  assert.doesNotMatch(preserved, /@Helpers|@everyone/);
  assert.match(preserved, /@eve ryone/);
  assert.equal(roleMentionOrdinaryText('***'.repeat(100) + 'secret' + '***'.repeat(100)), '');
});

test('suppressed role examples cannot fall back to person or room-wide alerts', () => {
  const uri = roleTokens.roleMentionUri('!server:local', 'helpers');
  const token = '[@everyone](' + uri + ')';
  const reference = '[@everyone][role]\n\n[role]: ' + uri;
  for (const source of ['> ' + token, '||' + token + '||', '`' + token + '`', '```\n' + token + '\n```', '```\n' + reference + '\n```', '````\n`' + token + '` @Ordinary\n````']) {
    assert.deepEqual(roleMentionLinks(source), []);
    assert.doesNotMatch(roleMentionOrdinaryText(source), /@everyone|tavern-role:/);
  }
  const code = roleMentionOrdinaryText('```\n' + token + '\n@Ordinary and const value=1;\n```');
  assert.match(code, /@Ordinary and const value=1;/);
  assert.doesNotMatch(roleMentionOrdinaryText('`[@everyone][role]`\n\n[role]: ' + uri), /@everyone/);
  assert.doesNotMatch(roleMentionOrdinaryText('```\n[@everyone][role]\n```\n\n[role]: ' + uri), /@everyone/);
  assert.equal(roleMentionOrdinaryText('```\n@everyone plain code\n```').trim(), '@everyone plain code');
});

test('invalid reserved role syntax cannot become ordinary room or person mentions', () => {
  for (const uri of ['tavern-role:invalid/role', 'TAVERN-ROLE:%21server%3Alocal/helpers', 'tavern-role:%ZZ/helpers']) {
    for (const source of ['[@everyone](' + uri + ') @Ordinary', '[@everyone][role] @Ordinary\n\n[role]: ' + uri, '`[@everyone](' + uri + ')` @Ordinary', '```\n[@everyone][role]\n```\n\n[role]: ' + uri + '\n\n@Ordinary']) {
      assert.deepEqual(roleMentionLinks(source), []);
      assert.doesNotMatch(roleMentionOrdinaryText(source), /@everyone|tavern-role:/i);
      assert.match(roleMentionOrdinaryText(source), /@Ordinary/);
    }
  }
});

test('depth, token budget and source size produce bounded literal fallback without losing surrogate pairs', () => {
  const deep = parse('***'.repeat(100) + 'secret' + '***'.repeat(100));
  assert.equal(deep.plain, true);
  assert.ok(flatten(deep.nodes).length <= markdownLimits.nodes);
  const many = parse('*a* '.repeat(2000)); assert.equal(many.plain, true);
  const large = parse('a'.repeat(markdownLimits.source - 1) + '😀more');
  assert.equal(large.truncated, true); assert.equal(large.plain, true);
  assert.equal(large.nodes[0].text.length, markdownLimits.source - 1);
  assert.equal(parse('ordinary text').plain, false);
});

test('adversarial unbalanced delimiters and links remain bounded and cannot create arbitrary tags', { timeout: 3000 }, () => {
  for (const source of ['[a]('.repeat(2000), '||`\\'.repeat(2000), '*_~'.repeat(3000), '> '.repeat(1000) + 'end', '<x '.repeat(2000)]) {
    const result = parse(source);
    assert.ok(flatten(result.nodes).length <= markdownLimits.nodes);
    assert.ok(result.nodes.length < 5000);
  }
});
