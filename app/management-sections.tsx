import { useState, type ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import './management-sections.css';

export type ManagementSection = { id: string; title: string; content: ReactNode };

/** Key the parent by its account and server/channel scope. Visited editors remain
 * mounted within that scope, while unopened editors do not fetch or mount. */
export function ManagementSections({ label, sections }: { label: string; sections: ManagementSection[] }) {
  const [selected, setSelected] = useState(() => sections[0]?.id || '');
  const [visited, setVisited] = useState(() => new Set(sections[0] ? [sections[0].id] : []));
  const current = sections.some(section => section.id === selected) ? selected : sections[0]?.id;
  if (!current) return null;
  function choose(id: string) {
    if (!sections.some(section => section.id === id)) return;
    setVisited(previous => previous.has(id) ? previous : new Set([...previous, id]));
    setSelected(id);
  }
  return <Tabs className='management-sections' value={current} onValueChange={choose}>
    <TabsList className='management-section-navigation' aria-label={label}>
      {sections.map(section => <TabsTrigger key={section.id} value={section.id}>{section.title}</TabsTrigger>)}
    </TabsList>
    {sections.map(section => (visited.has(section.id) || current === section.id) && <TabsContent
      key={section.id} value={section.id} forceMount hidden={current !== section.id}
      inert={current !== section.id ? true : undefined} className='management-section-panel'>
      {section.content}
    </TabsContent>)}
  </Tabs>;
}
