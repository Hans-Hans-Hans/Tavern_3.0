import {createRoot} from 'react-dom/client';
import {ServerDialog} from '../../../app/server-dialog';
import '../../../app/globals.css';
import '../../../app/product.css';
createRoot(document.getElementById('root')!).render(<ServerDialog open naming="standard" onClose={()=>{}} onCreated={async(id,roomId,isCurrent)=>{const w=window as any;if(w.delayOpen)await new Promise(resolve=>{w.resolveOpen=resolve;});if(isCurrent())w.completed.push([id,roomId]);}}/>);
