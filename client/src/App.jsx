import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, Link } from 'react-router';
import UniversalSearch from './components/UniversalSearch.jsx';
import { NewIngredientForm, ReceiptImportForm } from './components/forms.jsx';
import { Icon, Modal, Tabs, ToastProvider } from './components/ui.jsx';
import IngredientsPage from './pages/IngredientsPage.jsx';
import ReceiptReviewPage from './pages/ReceiptReviewPage.jsx';
import RecipeGallery from './pages/RecipeGallery.jsx';
import RecipeBuilder from './pages/RecipeBuilder.jsx';
import EventsPage from './pages/EventsPage.jsx';
import EventPlanner from './pages/EventPlanner.jsx';
import ReceiptsPage, { ReceiptDetailPage } from './pages/ReceiptsPage.jsx';
import BackupPage from './pages/BackupPage.jsx';

function QuickAdd({ onClose }) {
  const [tab, setTab] = useState('receipt');
  return (
    <Modal title="Quick add" onClose={onClose}>
      <div className="quick-add-tabs">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'receipt', label: 'Import receipt' },
            { value: 'manual', label: 'New ingredient' },
          ]}
        />
        <Link to="/recipes/new" className="tab" onClick={onClose}>New recipe</Link>
      </div>
      {tab === 'manual' ? <NewIngredientForm onDone={onClose} /> : <ReceiptImportForm onDone={onClose} />}
    </Modal>
  );
}

export default function App() {
  const [quickAdd, setQuickAdd] = useState(false);
  return (
    <ToastProvider>
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <Link to="/" className="brand">
            <img src="/favicon.svg" width="28" height="28" alt="" />
            <span className="brand-name">Kitchen Cost</span>
          </Link>
          <div className="nav">
            <NavLink to="/ingredients"><Icon.database /> Ingredients</NavLink>
            <NavLink to="/recipes"><Icon.recipe /> Recipes</NavLink>
            <NavLink to="/events"><Icon.calendar /> Events</NavLink>
            <NavLink to="/receipts"><Icon.receipt /> Receipts</NavLink>
            <NavLink to="/backup"><Icon.archive /> Backup</NavLink>
          </div>
        </nav>
        <div className="main">
          <header className="topbar">
            <UniversalSearch />
            <button className="btn primary" onClick={() => setQuickAdd(true)}>
              <Icon.plus /> Quick add
            </button>
          </header>
          <Routes>
            <Route path="/" element={<Navigate to="/ingredients" replace />} />
            <Route path="/ingredients" element={<IngredientsPage />} />
            <Route path="/ingredients/review" element={<ReceiptReviewPage />} />
            <Route path="/receipts" element={<ReceiptsPage />} />
            <Route path="/receipts/:id" element={<ReceiptDetailPage />} />
            <Route path="/recipes" element={<RecipeGallery />} />
            <Route path="/recipes/new" element={<RecipeBuilder />} />
            <Route path="/recipes/:id" element={<RecipeBuilder />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventPlanner />} />
            <Route path="/backup" element={<BackupPage />} />
            <Route path="*" element={<main className="page"><div className="panel empty"><h2>Page not found</h2><Link className="btn" to="/ingredients">Go to the database</Link></div></main>} />
          </Routes>
        </div>
      </div>
      {quickAdd && <QuickAdd onClose={() => setQuickAdd(false)} />}
    </ToastProvider>
  );
}
