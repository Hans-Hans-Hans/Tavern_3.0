import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
export function MessageList<T extends {id:string}>({items,scroll,render}:{items:T[];scroll:RefObject<HTMLDivElement|null>;render:(item:T,index:number)=>ReactNode}) {
  const element=useRef<HTMLDivElement>(null),[margin,setMargin]=useState(0);
  const getKey=useCallback((index:number)=>items[index].id,[items]);
  const virtualizer=useVirtualizer({count:items.length,getScrollElement:()=>scroll.current,estimateSize:()=>120,getItemKey:getKey,overscan:8,scrollMargin:margin,anchorTo:'end',followOnAppend:'auto'});
  useLayoutEffect(()=>{const measure=()=>{if(element.current&&scroll.current)setMargin(element.current.getBoundingClientRect().top-scroll.current.getBoundingClientRect().top+scroll.current.scrollTop);};measure();const observer=new ResizeObserver(measure);if(scroll.current)observer.observe(scroll.current);return()=>observer.disconnect();},[scroll,items.length]);
  return <div ref={element} className="virtual-messages" aria-label="Messages" style={{height:virtualizer.getTotalSize(),position:'relative',width:'100%'}}>{virtualizer.getVirtualItems().map(v=><div key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${v.start-margin}px)`}}>{render(items[v.index],v.index)}</div>)}</div>;
}
