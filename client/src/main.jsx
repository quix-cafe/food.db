import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/roboto-slab';
import './styles.css';
import App from './App.jsx';
import { useSkin } from './skin.js';

// The alternate theme (Backup page) is a whole app of its own, loaded only when switched on.
const AltApp = lazy(() => import('./skins/alt/App.jsx'));

function Root() {
  return useSkin() === 'alt' ? <Suspense fallback={null}><AltApp /></Suspense> : <App />;
}

// A data router (rather than <BrowserRouter>) so pages can use useBlocker to confirm
// leaving with unsaved changes. App keeps its own <Routes> under the catch-all.
const router = createBrowserRouter([{ path: '*', element: <Root /> }]);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
