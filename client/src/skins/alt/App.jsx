// The alternate app. While the Backup page's "Alternate theme" switch is on, main.jsx renders this
// in place of the default App. It has its own shell and its own pages for everything you browse
// (Today, Events, an event, the Cookbook, the Pantry); the deep editors (recipe builder, Spice Lab
// editor, receipt review, POS, backup) are the default app's, shown inside this shell and restyled
// by theme.css. See README.md beside this file.
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource/caveat-brush';
import './theme.css';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import UniversalSearch from '../../components/UniversalSearch.jsx';
import { useOpenPos, useStickyTableHeads } from '../../hooks.js';
import { Icon, ToastProvider } from '../../components/ui.jsx';
import { NewBuildBar, PosFrame, TestModeBar, ThemeToggle } from '../../App.jsx';
import { ReceiptDetailPage } from '../../pages/PurchasesPage.jsx';
import BackupPage from '../../pages/BackupPage.jsx';
import { AltIcon, Crumbs, todayDot } from './parts.jsx';
import QuickAdd from './QuickAdd.jsx';
import TodayPage from './TodayPage.jsx';
import EventsPage from './EventsPage.jsx';
import EventPage from './EventPage.jsx';
import CookbookPage from './CookbookPage.jsx';
import PantryPage from './PantryPage.jsx';
import ReceiptsPage from './ReceiptsPage.jsx';
import ReceiptReviewPage from './ReceiptReviewPage.jsx';
import RecipePage from './RecipePage.jsx';
import BlendPage from './BlendPage.jsx';
import IngredientPanel from './IngredientPanel.jsx';
import { registerSkinPart } from '../../skin.js';

// Wherever the default pages open an ingredient (recipe builder, shopping list, Spice Lab), this app's panel opens.
registerSkinPart('IngredientDrawer', IngredientPanel);

// The app by what you're doing rather than by table: the day, the events, what you cook, what you buy.
// `pages`: an area's pages, offered as a dropdown under it on a wide screen.
const AREAS = [
  { to: '/', label: 'Today', icon: AltIcon.today, match: (p) => p === '/' },
  { to: '/events', label: 'Events', icon: AltIcon.events, match: (p) => p.startsWith('/events') },
  { to: '/recipes', label: 'Recipes', icon: AltIcon.cookbook, match: (p) => p.startsWith('/recipes') || p.startsWith('/spice-lab'), pages: [['Recipes', '/recipes'], ['Spice Lab', '/spice-lab']] },
  { to: '/ingredients', label: 'Pantry', icon: AltIcon.pantry, match: (p) => p.startsWith('/ingredients') || p.startsWith('/purchases'), pages: [['Ingredients', '/ingredients'], ['Receipts', '/purchases']] },
];

/** The areas a page sits under, for its breadcrumbs: nothing on an area's own first page. */
function trailFor(p) {
  if (/^\/events\/./.test(p)) return [['Events', '/events']];
  if (/^\/recipes\/./.test(p)) return [['Recipes', '/recipes']];
  if (p === '/spice-lab') return [['Recipes', '/recipes']];
  if (/^\/spice-lab\/./.test(p)) return [['Recipes', '/recipes'], ['Spice Lab', '/spice-lab']];
  if (p === '/purchases') return [['Pantry', '/ingredients']];
  if (/^\/purchases\/./.test(p) || p === '/ingredients/review') return [['Pantry', '/ingredients'], ['Receipts', '/purchases']];
  return [];
}

function AreaLink({ area, pathname, menu = false }) {
  const on = area.match(pathname);
  const link = (
    <Link to={area.to} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
      <area.icon /> <span>{area.label}</span>{menu && area.pages && <Icon.down />}
    </Link>
  );
  if (!menu || !area.pages) return link;
  // Opens on hover or keyboard focus (CSS); every link in it is an ordinary link. A click lets go of
  // the focus, or the menu would stay open (:focus-within) until clicking somewhere else.
  const letGo = (e) => e.currentTarget.blur();
  return (
    <span className="nav-item">
      <Link to={area.to} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined} onClick={letGo}>
        <area.icon /> <span>{area.label}</span><Icon.down />
      </Link>
      <span className="nav-menu">
        {area.pages.map(([label, to]) => <Link key={to} to={to} className={pathname === to ? 'here' : ''} onClick={letGo}>{label}</Link>)}
      </span>
    </span>
  );
}

function OldReceiptRedirect() {
  const { id } = useParams();
  return <Navigate to={`/purchases/${id}`} replace />;
}

function AltRoutes({ location }) {
  return (
    <Routes location={location}>
      <Route path="/" element={<TodayPage />} />
      <Route path="/events" element={<EventsPage />} />
      <Route path="/events/:id" element={<EventPage />} />
      <Route path="/recipes" element={<CookbookPage show="dishes" />} />
      <Route path="/recipes/new" element={<RecipePage />} />
      <Route path="/recipes/:id" element={<RecipePage />} />
      <Route path="/spice-lab" element={<CookbookPage show="lab" />} />
      <Route path="/spice-lab/new" element={<BlendPage key="new" />} />
      <Route path="/spice-lab/new-sauce" element={<BlendPage key="new-sauce" kind="sauce" />} />
      <Route path="/spice-lab/:id" element={<BlendPage />} />
      <Route path="/ingredients" element={<PantryPage />} />
      <Route path="/ingredients/review" element={<ReceiptReviewPage />} />
      <Route path="/purchases" element={<ReceiptsPage />} />
      <Route path="/purchases/:id" element={<ReceiptDetailPage />} />
      <Route path="/receipts" element={<Navigate to="/purchases" replace />} />
      <Route path="/receipts/:id" element={<OldReceiptRedirect />} />
      <Route path="/backup" element={<BackupPage />} />
      <Route path="*" element={<main className="page"><div className="panel empty"><h2>Page not found</h2><Link className="btn" to="/">Go to Today</Link></div></main>} />
    </Routes>
  );
}

export default function AltApp() {
  const [quickAdd, setQuickAdd] = useState(false);
  const location = useLocation();
  // Opened from a page, the POS is a modal over it; the page underneath keeps its place and its edits.
  const background = location.pathname === '/pos' ? location.state?.background : null;
  const openPos = useOpenPos();
  useStickyTableHeads();
  if (location.pathname === '/pos' && !background) return <ToastProvider><PosFrame /></ToastProvider>;
  const here = background ?? location;
  const settings = here.pathname.startsWith('/backup');
  return (
    <ToastProvider>
      <div className="alt-shell" inert={!!background}>
        {!background && <NewBuildBar />}
        {/* `.topbar`: the sticky-heads hook measures it, and tucks it away on a phone while scrolling down. */}
        <div className="alt-top topbar">
        <TestModeBar />
        <header className="alt-rail">
          <Link to="/" className="alt-brand" aria-label="food.db, Today">food<i className={`brand-dot ${todayDot()}`} title="Today’s day dot" />db</Link>
          <nav className="alt-nav" aria-label="Main">
            {AREAS.map((a) => <AreaLink key={a.to} area={a} pathname={here.pathname} menu />)}
          </nav>
          <UniversalSearch />
          <div className="alt-rail-actions">
            <button className="btn alt-add" onClick={() => setQuickAdd(true)} aria-label="Quick add" title="Add a receipt, ingredient, event, recipe, spice blend or sauce">
              <Icon.plus /> <span className="btn-label">Quick add</span>
            </button>
            <a className="btn alt-orders" href="/pos" onClick={openPos('/pos')} title="Open the order screen" aria-label="POS: open the order screen">
              <AltIcon.orders /> <span className="btn-label">POS</span>
            </a>
            <ThemeToggle />
            <Link to="/backup" className={`icon-btn alt-gear ${settings ? 'active' : ''}`} aria-label="Settings and backup" title="Settings and backup"><AltIcon.gear /></Link>
          </div>
        </header>
        </div>
        <Crumbs trail={trailFor(here.pathname)} />
        <AltRoutes location={here} />
        {/* Phones: the areas along the bottom, under the thumb, with the order screen in the middle. */}
        <nav className="alt-tabbar" aria-label="Main">
          {AREAS.slice(0, 2).map((a) => <AreaLink key={a.to} area={a} pathname={here.pathname} />)}
          <a href="/pos" className="orders" onClick={openPos('/pos')} aria-label="POS: open the order screen"><AltIcon.orders /> <span>POS</span></a>
          {AREAS.slice(2).map((a) => <AreaLink key={a.to} area={a} pathname={here.pathname} />)}
        </nav>
      </div>
      {background && <PosFrame />}
      {quickAdd && <QuickAdd onClose={() => setQuickAdd(false)} />}
    </ToastProvider>
  );
}
