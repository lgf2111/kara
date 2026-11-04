import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App';
import { NoticesProvider } from './notices/Notices.tsx';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root');
}

createRoot(container).render(
  <StrictMode>
    {/*
      The notices outside the app, so a failure thrown while the stage is
      being set up still has somewhere to be said. The tooltips outside both,
      because every icon button in the room is named by one.
    */}
    <TooltipProvider>
      <NoticesProvider>
        <App />
      </NoticesProvider>
    </TooltipProvider>
  </StrictMode>,
);
