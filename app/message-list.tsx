import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
export function MessageList<T extends {id:string}>({items,scroll,render,focusId}:{items:T[];scroll:RefObject<HTMLDivElement|null>;render:(item:T,index:number)=>ReactNode;focusId?:{id:string;request:number}|null}) {
  const element=useRef<HTMLDivElement>(null),[margin,setMargin]=useState(0),[viewport,setViewport]=useState<HTMLDivElement|null>(null);
  const getKey=useCallback((index:number)=>items[index].id,[items]);
  const virtualizer=useVirtualizer({count:items.length,getScrollElement:()=>viewport,estimateSize:()=>120,getItemKey:getKey,overscan:8,scrollMargin:margin,anchorTo:'end',followOnAppend:'auto'});
  // A parent's host ref may attach after this child's first layout effect.
  // Hand the completed ref to the virtualizer on the next frame even if no messages change.
  useLayoutEffect(()=>{const attach=()=>setViewport(scroll.current);attach();const frame=requestAnimationFrame(attach);return()=>cancelAnimationFrame(frame);},[scroll]);
  useLayoutEffect(()=>{const measure=()=>{if(element.current&&viewport)setMargin(element.current.getBoundingClientRect().top-viewport.getBoundingClientRect().top+viewport.scrollTop);};measure();const observer=new ResizeObserver(measure);if(viewport)observer.observe(viewport);return()=>observer.disconnect();},[viewport,items.length]);
  useLayoutEffect(()=>{if(!focusId||!viewport)return;const index=items.findIndex(item=>item.id===focusId.id);if(index>=0)virtualizer.scrollToIndex(index,{align:'start'});},[focusId,viewport]);
  return <div ref={element} className="virtual-messages" aria-label="Messages" style={{height:virtualizer.getTotalSize(),position:'relative',width:'100%'}}>{virtualizer.getVirtualItems().map(v=><div key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${v.start-margin}px)`}}>{render(items[v.index],v.index)}</div>)}</div>;
}
