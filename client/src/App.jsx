import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, Link, useLocation, useParams } from 'react-router';
import UniversalSearch from './components/UniversalSearch.jsx';
import { setTestMode } from './api.js';
import { useTestMode } from './hooks.js';
import { NewIngredientForm, ReceiptImportForm } from './components/forms.jsx';
import { Icon, Modal, ToastProvider } from './components/ui.jsx';
import IngredientsPage from './pages/IngredientsPage.jsx';
import ReceiptReviewPage from './pages/ReceiptReviewPage.jsx';
import RecipeGallery from './pages/RecipeGallery.jsx';
import RecipeBuilder from './pages/RecipeBuilder.jsx';
import EventsPage, { NewEventForm } from './pages/EventsPage.jsx';
import EventPlanner from './pages/EventPlanner.jsx';
import PurchasesPage, { ReceiptDetailPage } from './pages/PurchasesPage.jsx';
import BackupPage from './pages/BackupPage.jsx';
import SpiceLabPage, { BlendEditor } from './pages/SpiceLabPage.jsx';

// What Quick add makes, in order: a tab shows its form here, a link opens its page.
const QUICK_ADD = [
  { tab: 'receipt', label: 'Receipt' },
  { tab: 'ingredient', label: 'Ingredient' },
  { to: '/recipes/new', label: 'Recipe' },
  { to: '/spice-lab/new', label: 'Blend' },
  { to: '/spice-lab/new-sauce', label: 'Sauce' },
  { tab: 'event', label: 'Event' },
];

function QuickAdd({ onClose }) {
  const [tab, setTab] = useState('receipt');
  return (
    <Modal title="Quick add" onClose={onClose}>
      <div className="quick-add-tabs">
        <div role="tablist" aria-label="New">
          {QUICK_ADD.map((q) => (q.tab
            ? <button key={q.label} role="tab" className="tab" aria-selected={tab === q.tab} onClick={() => setTab(q.tab)}>{q.label}</button>
            : <Link key={q.label} to={q.to} className="tab" onClick={onClose}>{q.label}</Link>))}
        </div>
      </div>
      {tab === 'ingredient' ? <NewIngredientForm onDone={onClose} />
        : tab === 'event' ? <NewEventForm bare onCancel={onClose} />
        : <ReceiptImportForm onDone={onClose} />}
    </Modal>
  );
}

function TestModeBar() {
  const on = useTestMode();
  if (!on) return null;
  return (
    <div className="test-mode-bar" role="status">
      <span><b>Test mode.</b> Everything you add is marked as test data, which you can clear from <Link to="/backup#test-data">Backup</Link>.</span>
      <button className="btn small" onClick={() => setTestMode(false)}>Turn off</button>
    </div>
  );
}

function OldReceiptRedirect() {
  const { id } = useParams();
  return <Navigate to={`/purchases/${id}`} replace />;
}

export default function App() {
  const [quickAdd, setQuickAdd] = useState(false);
  // On phones the menu collapses behind a button; it closes on navigation, Escape or a tap outside.
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  return (
    <ToastProvider>
      <div className="shell">
        <nav className={`sidebar ${menuOpen ? 'menu-open' : ''}`} aria-label="Main">
          <Link to="/" className="brand">
            <img src="/favicon.svg" width="28" height="28" alt="" />
            <span className="brand-name">food.db</span>
          </Link>
          <button className="icon-btn menu-toggle" aria-expanded={menuOpen} aria-controls="main-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <Icon.close /> : <Icon.menu />}
          </button>
          {menuOpen && <div className="menu-scrim" onClick={() => setMenuOpen(false)} />}
          <div className="nav" id="main-menu">
            <NavLink to="/ingredients" title="Ingredients"><Icon.carrot /> <span>Ingredients</span></NavLink>
            <NavLink to="/recipes" title="Recipes"><Icon.chefHat /> <span>Recipes</span></NavLink>
            <NavLink to="/purchases" title="Purchases"><Icon.cart /> <span>Purchases</span></NavLink>
            <NavLink to="/events" title="Events"><Icon.calendar /> <span>Events</span></NavLink>
            <NavLink to="/backup" title="Backup"><Icon.history /> <span>Backup</span></NavLink>
            <NavLink to="/spice-lab" title="Spice Lab"><Icon.starburst /> <span>Spice Lab</span></NavLink>
          </div>
        </nav>
        <div className="main">
          <TestModeBar />
          <header className="topbar">
            <UniversalSearch />
            <button className="btn quick-add-btn" onClick={() => setQuickAdd(true)} aria-label="Quick add">
              <Icon.plus /> <span className="btn-label">Quick add</span>
            </button>
          </header>
          <Routes>
            <Route path="/" element={<Navigate to="/ingredients" replace />} />
            <Route path="/ingredients" element={<IngredientsPage />} />
            <Route path="/ingredients/review" element={<ReceiptReviewPage />} />
            <Route path="/purchases" element={<PurchasesPage />} />
            <Route path="/purchases/:id" element={<ReceiptDetailPage />} />
            {/* Old addresses from before the page was renamed. */}
            <Route path="/receipts" element={<Navigate to="/purchases" replace />} />
            <Route path="/receipts/:id" element={<OldReceiptRedirect />} />
            <Route path="/recipes" element={<RecipeGallery />} />
            <Route path="/recipes/new" element={<RecipeBuilder />} />
            <Route path="/recipes/:id" element={<RecipeBuilder />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventPlanner />} />
            <Route path="/backup" element={<BackupPage />} />
            <Route path="/spice-lab" element={<SpiceLabPage />} />
            <Route path="/spice-lab/new" element={<BlendEditor key="new" />} />
            <Route path="/spice-lab/new-sauce" element={<BlendEditor key="new-sauce" kind="sauce" />} />
            <Route path="/spice-lab/:id" element={<BlendEditor />} />
            <Route path="*" element={<main className="page"><div className="panel empty"><h2>Page not found</h2><Link className="btn" to="/ingredients">Go to ingredients</Link></div></main>} />
          </Routes>
        </div>
      </div>
      {quickAdd && <QuickAdd onClose={() => setQuickAdd(false)} />}
    </ToastProvider>
  );
}
