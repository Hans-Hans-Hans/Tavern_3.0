import { createRoot } from 'react-dom/client';
import { InstanceBranding, AdminSecurityPolicy } from '../../../app/instance-admin';
import { SecurityEnrollment } from '../../../app/security-enrollment';
import '../../../app/product.css';
const session: any = { userId: '@owner:test', deviceId: 'CURRENT-DEVICE', admin: true };
createRoot(document.getElementById('root')!).render(location.search.includes('enrollment') ? <SecurityEnrollment onComplete={async () => { document.body.dataset.completed = 'yes'; }}/> : location.search.includes('security') ? <AdminSecurityPolicy/> : <InstanceBranding session={session}/>);
