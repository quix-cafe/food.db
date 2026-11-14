// The alternate theme's app. While the Backup page's "Alternate theme" switch is on, main.jsx
// renders this in place of the default App, so everything structural is yours to change:
// layout, navigation, routes, pages, components. See README.md beside this file.
//
// It starts as the default app with this skin's stylesheet; replace it freely.
import './theme.css';
import DefaultApp from '../../App.jsx';

export default function AltApp() {
  return <DefaultApp />;
}
