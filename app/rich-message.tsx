import { createElement, Fragment, useMemo, useState, type ReactNode } from 'react';
import { containsMessageSpoiler, parseMessageMarkdown, type MessageMarkdownNode } from '@/lib/message-markdown';
import { copyText } from './action-menu';
import './rich-message.css';

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <span className={'message-spoiler ' + (open ? 'revealed' : '')}>
    <button type="button" aria-label={open ? 'Hide spoiler' : 'Reveal spoiler'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide spoiler' : 'Spoiler'}</button>
    {open && <span className="message-spoiler-content">{children}</span>}
  </span>;
}

function codeTokens(text: string) {
  return text.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:const|let|var|function|return|if|else|async|await|import|export|from|class|def|for|while|try|catch|except|True|False|None|true|false|null|new|throw)\b|\b\d+(?:\.\d+)?\b)/g).map((part, i) =>
    /^['"]/.test(part) ? <span className="code-string" key={i}>{part}</span> : /^(\/\/|#)/.test(part) ? <span className="code-comment" key={i}>{part}</span> :
      /^(const|let|var|function|return|if|else|async|await|import|export|from|class|def|for|while|try|catch|except|True|False|None|true|false|null|new|throw)$/.test(part) ? <span className="code-keyword" key={i}>{part}</span> :
        /^\d/.test(part) ? <span className="code-number" key={i}>{part}</span> : part);
}

function CodeBlock({ text, language }: { text: string; language: string }) {
  const [error, setError] = useState(''), [copied, setCopied] = useState(false);
  return <div className="message-code"><div><span>{language || 'Code'}</span><button type="button" onClick={() => {
    setError(''); void copyText(text, 'Code copied').then(() => setCopied(true)).catch(() => setError('Code could not be copied. Select the code and copy it manually.'));
  }}>{copied ? 'Copy code again' : 'Copy code'}</button></div><pre><code>{codeTokens(text)}</code></pre>{error && <p role="alert">{error}</p>}</div>;
}

function renderNodes(nodes: MessageMarkdownNode[], renderText?: (text: string) => ReactNode, inLink = false): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return <Fragment key={index}>{node.text.split(/(@[\w.-]+)/g).map((part, piece) => part.startsWith('@')
      ? <span className="mention" key={piece}>{part}</span> : <Fragment key={piece}>{renderText ? renderText(part) : part}</Fragment>)}</Fragment>;
    if (node.type === 'break') return <br key={index}/>;
    if (node.type === 'rule') return <hr key={index}/>;
    if (node.type === 'code') return node.block ? <CodeBlock key={index} text={node.text} language={node.language}/> : <code key={index}>{node.text}</code>;
    if (node.type === 'spoiler') return <Spoiler key={index}>{renderNodes(node.children, renderText, inLink)}</Spoiler>;
    if (node.type === 'link') {
      // A spoiler in a link label keeps its reveal control; its enclosing
      // destination stays inactive. Nested image links are also flattened.
      if (inLink || containsMessageSpoiler(node.children)) return <Fragment key={index}>{renderNodes(node.children, renderText, inLink)}</Fragment>;
      return <a key={index} href={node.href} rel="noopener noreferrer" target="_blank" referrerPolicy="no-referrer">{renderNodes(node.children, renderText, true)}</a>;
    }
    if (node.type === 'element') {
      const children = renderNodes(node.children, renderText, inLink);
      return node.tag === 'group' ? <Fragment key={index}>{children}</Fragment> : createElement(node.tag, { key: index,
        ...(node.tag === 'blockquote' ? { className: 'message-quote' } : {}), ...(node.tag === 'ol' && node.start ? { start: node.start } : {}) }, children);
    }
    return null;
  });
}

export function RichMessage({ text, renderText }: { text: string; renderText?: (text: string) => ReactNode }) {
  const parsed = useMemo(() => parseMessageMarkdown(text), [text]);
  // An edit must not inherit an already-open spoiler from older content.
  return <div className="rich-message"><Fragment key={text}>{parsed.plain
    ? <details className="message-format-fallback"><summary>{parsed.truncated ? 'Message is too long. Show shortened plain text' : 'Message formatting is too complex. Show plain text'}</summary><pre>{parsed.nodes.map(node => node.type === 'text' ? node.text : '').join('')}</pre></details>
    : renderNodes(parsed.nodes, renderText)}</Fragment></div>;
}
