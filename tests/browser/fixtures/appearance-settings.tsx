import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceSettings } from '../../../app/appearance-settings';
import { initializeAppearance } from '../../../lib/appearance';
import { getMatrixClient } from '../../../lib/matrix';
import '../../../app/globals.css';
import '../../../app/product.css';
export function mountFixture() {
  initializeAppearance(getMatrixClient()!);
  createRoot(document.getElementById('root')!).render(<main style={{ padding: 16, maxWidth: 650 }}>
    <nav><button className='channel-link'>A channel</button></nav>
    <div className='message compact' data-testid='spacing-sample'><span>Existing compact message</span></div>
    <AppearanceSettings/>
  </main>);
}
