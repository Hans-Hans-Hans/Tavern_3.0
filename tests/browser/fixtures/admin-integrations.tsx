import { createRoot } from 'react-dom/client';
import { AdminIntegrations } from '../../../app/admin-integrations';
import { StoragePolicy } from '../../../app/admin-resources';
import '../../../app/product.css';
createRoot(document.getElementById('root')!).render(location.search.includes('storage') ? <StoragePolicy/> : <AdminIntegrations/>);
