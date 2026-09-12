import {createRoot} from 'react-dom/client';
import {ServerDialog} from '../../../app/server-dialog';
import '../../../app/globals.css';
import '../../../app/product.css';
createRoot(document.getElementById('root')!).render(<ServerDialog open naming="standard" onClose={()=>{}} onCreated={async(...args)=>{(window as any).completed.push(args);}}/>);
