import { Fragment, useState, type ReactNode } from 'react';
import { copyText } from './action-menu';
function Spoiler({children}:{children:ReactNode}){const[open,setOpen]=useState(false);return <button className={'message-spoiler '+(open?'revealed':'')} aria-label={open?'Hide spoiler':'Reveal spoiler'} onClick={()=>setOpen(!open)}>{open?children:'Spoiler'}</button>;}
function inline(text:string):ReactNode[]{return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\|\|[^|]+\|\||\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+|@[\w.-]+)/g).map((part,i)=>{
  if(part.startsWith('`'))return <code key={i}>{part.slice(1,-1)}</code>;
  if(part.startsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
  if(part.startsWith('~~'))return <del key={i}>{part.slice(2,-2)}</del>;
  if(part.startsWith('||'))return <Spoiler key={i}>{part.slice(2,-2)}</Spoiler>;
  const link=/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
  if(link||/^https?:\/\//.test(part)){const url=link?.[2]||part;try{const parsed=new URL(url);if(!parsed.username&&!parsed.password)return <a key={i} href={url} rel="noopener noreferrer" target="_blank" referrerPolicy="no-referrer">{link?.[1]||part}</a>;}catch{}}
  return part.startsWith('@')?<span className="mention" key={i}>{part}</span>:<Fragment key={i}>{part}</Fragment>;
});}
function codeTokens(text:string){return text.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:const|let|var|function|return|if|else|async|await|import|export|from|class|def|for|while|try|catch|except|True|False|None|true|false|null|new|throw)\b|\b\d+(?:\.\d+)?\b)/g).map((part,i)=>/^['"]/.test(part)?<span className="code-string" key={i}>{part}</span>:/^(\/\/|#)/.test(part)?<span className="code-comment" key={i}>{part}</span>:/^(const|let|var|function|return|if|else|async|await|import|export|from|class|def|for|while|try|catch|except|True|False|None|true|false|null|new|throw)$/.test(part)?<span className="code-keyword" key={i}>{part}</span>:/^\d/.test(part)?<span className="code-number" key={i}>{part}</span>:part);}
export function RichMessage({text}:{text:string}){return <>{text.split(/(```[\s\S]*?```)/g).map((block,i)=>{
  if(block.startsWith('```')){const [language,...lines]=block.slice(3,-3).split('\n');const body=lines.length?lines.join('\n'):language;return <div className="message-code" key={i}><div><span>{lines.length?language.slice(0,30):'Code'}</span><button onClick={()=>void copyText(body)}>Copy code</button></div><pre><code>{codeTokens(body)}</code></pre></div>;}
  return <Fragment key={i}>{block.split('\n').map((line,j)=><Fragment key={j}>{j>0&&<br/>}{line.startsWith('> ')?<span className="message-quote">{inline(line.slice(2))}</span>:inline(line)}</Fragment>)}</Fragment>;
})}</>;}
