import { useEffect, useRef, useState } from 'react';
import { matrixFileBlob } from '@/lib/matrix';
export function AttachmentThumbnail({ preview, name }: { preview: { url: string; file?: any; type: string }; name: string }) {
  const anchor = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false), [url, setUrl] = useState('');
  useEffect(() => { const node = anchor.current; if (!node) return; const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '100px' }); observer.observe(node); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!visible) return; const controller = new AbortController(); let local = ''; void matrixFileBlob(preview, controller.signal, 512 * 1024).then(blob => { if (controller.signal.aborted || !blob.type.startsWith('image/')) return; local = URL.createObjectURL(blob); setUrl(local); }).catch(() => {}); return () => { controller.abort(); if (local) URL.revokeObjectURL(local); }; }, [visible, preview.url]);
  return <span ref={anchor} className="attachment-thumbnail">{url && <img src={url} alt={name} loading="lazy" decoding="async" />}</span>;
}
