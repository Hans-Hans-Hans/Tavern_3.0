import { createRoot } from 'react-dom/client';
import { AdminIntegrations } from '../../../app/admin-integrations';
import { StoragePolicy } from '../../../app/admin-resources';
import { setAccountDevice } from '../../../lib/api';
import '../../../app/product.css';
setAccountDevice('FIXTURE');
createRoot(document.getElementById('root')!).render(location.search.includes('storage') ? <StoragePolicy/> : <AdminIntegrations roomId={new URLSearchParams(location.search).get('room') || undefined}/>);
