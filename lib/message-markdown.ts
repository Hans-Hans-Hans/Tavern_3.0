import MarkdownIt, { type StateInline, type Token } from 'markdown-it';
import { parseRoleMentionUri, type RoleMentionIdentity } from './role-mention-token';

export const markdownLimits = { source: 32000, nodes: 4096, depth: 20 } as const;
export type MessageElement = 'group' | 'p' | 'blockquote' | 'ul' | 'ol' | 'li' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'em' | 'strong' | 'del' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td';
export type MessageMarkdownNode =
  | { type: 'text'; text: string }
  | { type: 'break' | 'rule' }
  | { type: 'code'; text: string; block: boolean; language: string }
  | { type: 'link'; href: string; children: MessageMarkdownNode[] }
  | { type: 'spoiler'; children: MessageMarkdownNode[] }
  | { type: 'element'; tag: MessageElement; start?: number; role?: RoleMentionIdentity; roleLink?: true; children: MessageMarkdownNode[] };
export type ParsedMessageMarkdown = { nodes: MessageMarkdownNode[]; plain: boolean; truncated: boolean };

export function messageLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

const parser = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false, maxNesting: markdownLimits.depth });
parser.validateLink = value => messageLinkUrl(value) !== null || parseRoleMentionUri(value) !== null;
// Preserve explicit http(s) autolinks without turning bare domains, email
// addresses, protocol-relative paths or other URL schemes into navigation.
parser.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
// Code examples never activate roles. This separate one-pass parser only strips
// their explicit role labels from legacy ordinary-mention matching; disabling
// code rules prevents nested backticks/fences from hiding a label from the pass.
const codeMentionParser = new MarkdownIt({ html: false, breaks: true, linkify: false, maxNesting: markdownLimits.depth });
const ordinaryMentionParser = new MarkdownIt({ html: false, breaks: true, linkify: false, maxNesting: markdownLimits.depth });
// Malformed reserved destinations remain inert candidates to remove from
// legacy mention matching. They never become valid roles or navigable links.
ordinaryMentionParser.validateLink = value => messageLinkUrl(value) !== null || /^tavern-role:/i.test(value);
codeMentionParser.validateLink = ordinaryMentionParser.validateLink;
codeMentionParser.disable(['backticks', 'fence', 'code']);

function spoiler(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== '||') return false;
  let end = start + 2;
  while (end < state.posMax) {
    if (state.src[end] === '\\') { end += 2; continue; }
    if (state.src[end] === '`') {
      let count = 1;
      while (state.src[end + count] === '`') count++;
      const marker = '`'.repeat(count);
      let closing = state.src.indexOf(marker, end + count);
      while (closing >= 0 && (state.src[closing - 1] === '`' || state.src[closing + count] === '`')) closing = state.src.indexOf(marker, closing + count);
      if (closing >= 0 && closing < state.posMax) { end = closing + count; continue; }
      end += count; continue;
    }
    if (state.src.slice(end, end + 2) === '||') break;
    end++;
  }
  if (end >= state.posMax || end === start + 2) return false;
  if (!silent) {
    const token = state.push('tavern_spoiler', '', 0);
    token.content = state.src.slice(start + 2, end);
    token.children = [];
    state.md.inline.parse(token.content, state.md, state.env, token.children);
  }
  state.pos = end + 2;
  return true;
}

// The default text rule does not stop at '|'. Preserve its CommonMark handling
// and only shorten its scan at the next possible spoiler delimiter.
const ordinaryText = parser.inline.ruler.getRules('')[0];
parser.inline.ruler.at('text', (state, silent) => {
  const limit = state.posMax, next = state.src.indexOf('||', state.pos);
  if (next >= state.pos && next < limit) state.posMax = next;
  try { return ordinaryText(state, silent); } finally { state.posMax = limit; }
});
parser.inline.ruler.before('emphasis', 'tavern_spoiler', spoiler);

const elements: Record<string, MessageElement> = {
  paragraph: 'p', blockquote: 'blockquote', bullet_list: 'ul', ordered_list: 'ol', list_item: 'li',
  em: 'em', strong: 'strong', s: 'del', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td',
};

function convert(tokens: Token[], depth: number, budget: { left: number }): MessageMarkdownNode[] {
  const result: MessageMarkdownNode[] = [];
  const stack: { closing: string; children: MessageMarkdownNode[] }[] = [{ closing: '', children: result }];
  for (const token of tokens) {
    if (--budget.left < 0 || depth + stack.length > markdownLimits.depth) throw new Error('Markdown bounds exceeded');
    const target = stack[stack.length - 1].children;
    if (token.nesting === -1) {
      if (stack.length < 2 || stack[stack.length - 1].closing !== token.type) throw new Error('Unbalanced Markdown');
      stack.pop(); continue;
    }
    if (token.nesting === 1) {
      const kind = token.type.replace(/_open$/, '');
      const children: MessageMarkdownNode[] = [];
      if (kind === 'link') {
        const href = messageLinkUrl(token.attrGet('href'));
        const role = parseRoleMentionUri(token.attrGet('href'));
        const destination = token.attrGet('href');
        const roleLink = typeof destination === 'string' && /^tavern-role:/i.test(destination);
        target.push(href ? { type: 'link', href, children } : { type: 'element', tag: 'group', children, ...(role ? { role } : {}), ...(roleLink ? { roleLink: true as const } : {}) });
      } else {
        const tag = kind === 'heading' && /^h[1-6]$/.test(token.tag) ? token.tag as MessageElement : elements[kind];
        if (!tag) throw new Error('Unsupported Markdown token');
        const start = Number(token.attrGet('start'));
        target.push({ type: 'element', tag: token.hidden ? 'group' : tag, children,
          ...(tag === 'ol' && Number.isSafeInteger(start) && start >= 1 && start <= 999999999 ? { start } : {}) });
      }
      stack.push({ closing: token.type.replace(/_open$/, '_close'), children }); continue;
    }
    if (token.type === 'inline') target.push(...convert(token.children || [], depth + stack.length, budget));
    else if (token.type === 'text' || token.type === 'text_special' || token.type === 'html_inline' || token.type === 'html_block') target.push({ type: 'text', text: token.content });
    else if (token.type === 'softbreak' || token.type === 'hardbreak') target.push({ type: 'break' });
    else if (token.type === 'hr') target.push({ type: 'rule' });
    else if (token.type === 'fence' || token.type === 'code_block' || token.type === 'code_inline') target.push({ type: 'code', text: token.content, block: token.type !== 'code_inline', language: token.type === 'fence' ? token.info.trim().split(/\s/, 1)[0].slice(0, 30) : '' });
    else if (token.type === 'tavern_spoiler') target.push({ type: 'spoiler', children: convert(token.children || [], depth + stack.length, budget) });
    else if (token.type === 'image') {
      const href = messageLinkUrl(token.attrGet('src'));
      const children: MessageMarkdownNode[] = [{ type: 'text', text: '[Image: ' + (token.content || 'linked image') + ']' }];
      target.push(href ? { type: 'link', href, children } : { type: 'element', tag: 'group', children });
    } else throw new Error('Unsupported Markdown token');
  }
  if (stack.length !== 1) throw new Error('Unbalanced Markdown');
  return result;
}

export function parseMessageMarkdown(value: string): ParsedMessageMarkdown {
  let text = value.slice(0, markdownLimits.source);
  if (text.length < value.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  const truncated = text.length < value.length;
  const fallback = () => ({ nodes: [{ type: 'text' as const, text }], plain: true, truncated });
  if (truncated) return fallback();
  try { return { nodes: convert(parser.parse(text, {}), 0, { left: markdownLimits.nodes }), plain: false, truncated }; }
  catch { return fallback(); }
}

export function containsMessageSpoiler(nodes: MessageMarkdownNode[]): boolean {
  return nodes.some(node => node.type === 'spoiler' || 'children' in node && containsMessageSpoiler(node.children));
}

/** Preview consent must not disclose destinations hidden by the message renderer. */
export function visibleMessageLinks(text: string): string[] {
  const parsed = parseMessageMarkdown(text), links = new Set<string>();
  if (parsed.plain) return [];
  const visit = (nodes: MessageMarkdownNode[]) => {
    for (const node of nodes) {
      if (links.size === 3) return;
      if (node.type === 'spoiler' || node.type === 'code') continue;
      if (node.type === 'link' && !containsMessageSpoiler(node.children)) links.add(node.href);
      else if ('children' in node) visit(node.children);
    }
  };
  visit(parsed.nodes);
  return [...links];
}

/** Notifications only use explicit roles in visible, unquoted message content. */
export function roleMentionLinks(text: string): RoleMentionIdentity[] {
  const parsed = parseMessageMarkdown(text), roles: RoleMentionIdentity[] = [];
  if (parsed.plain) return [];
  const visit = (nodes: MessageMarkdownNode[]) => {
    for (const node of nodes) {
      if (node.type === 'spoiler' || node.type === 'code' || node.type === 'element' && node.tag === 'blockquote') continue;
      if (node.type === 'element' && node.role && !containsMessageSpoiler(node.children)) roles.push(node.role);
      else if ('children' in node) visit(node.children);
    }
  };
  visit(parsed.nodes);
  return roles;
}

/**
 * For a message with an active role mention, keep ordinary mention candidates
 * separate from role labels (including reference links and nested formatting).
 * Code, quotes and spoilers retain the existing ordinary-mention semantics.
 */
export function roleMentionOrdinaryText(text: string): string {
  const fragments: string[] = [], environment: { references?: Record<string, { href: string; title: string }> } = {};
  if (text.length > markdownLimits.source) return '';
  let parsed: MessageMarkdownNode[];
  try { parsed = convert(ordinaryMentionParser.parse(text, environment), 0, { left: markdownLimits.nodes }); }
  catch { return ''; }
  const hasRoleReference = Object.values(environment.references || {}).some(reference => /^tavern-role:/i.test(reference.href));
  const visit = (nodes: MessageMarkdownNode[], codeProjection = false) => {
    for (const node of nodes) {
      if (node.type === 'element' && node.roleLink) continue;
      if (node.type === 'code' && (hasRoleReference || /tavern-role:/i.test(node.text))) {
        if (!codeProjection) {
          try { visit(convert(codeMentionParser.parse(node.text, { references: { ...environment.references } }), 0, { left: markdownLimits.nodes }), true); }
          catch { /* Excessively complex code examples do not create alerts. */ }
        }
      } else if (node.type === 'text' || node.type === 'code') fragments.push(node.text);
      else if ('children' in node) visit(node.children, codeProjection);
    }
  };
  visit(parsed);
  // Formatting boundaries cannot manufacture a new @name or @everyone token.
  return fragments.join(' ');
}
