import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import App from './App.jsx';

// A data router (rather than <BrowserRouter>) so pages can use useBlocker to confirm
// leaving with unsaved changes. App keeps its own <Routes> under the catch-all.
const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
