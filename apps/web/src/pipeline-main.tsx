import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PipelineApp } from './PipelineApp.tsx';
import './styles.css';
import './spike.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root');
}

createRoot(container).render(
  <StrictMode>
    <PipelineApp />
  </StrictMode>,
);
