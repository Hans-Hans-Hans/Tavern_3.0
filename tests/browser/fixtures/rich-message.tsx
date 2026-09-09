import React, { useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { RichMessage } from '../../../app/rich-message';
import { MessageSearch } from '../../../app/message-search';
import '../../../app/globals.css';

export function mountFixture(MessageExpression: ComponentType<{ text: string }>) {
  function Fixture() {
    const [text, setText] = useState((window as any).initialMarkdown || 'Ready');
    (window as any).replaceMarkdown = setText;
    return <main style={{ maxWidth: 650, padding: 12 }}><section aria-label="Rendered message"><MessageExpression text={text}/></section>
      {(window as any).searchMarkdown && <section aria-label="Message search"><MessageSearch initialQuery="find" roomId="!guild:test" onSelect={message => (window as any).openedMessages.push(message.id)}/></section>}
      <section aria-label="Plain rendering"><RichMessage text="A normal message"/></section></main>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
