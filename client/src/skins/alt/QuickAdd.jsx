// Add: first what it is, then only that thing's form. Three things have a form here (a receipt,
// an ingredient, an event); the rest are built on their own page, so choosing one goes there.
import { useState } from 'react';
import { Link } from 'react-router';
import { NewIngredientForm, ReceiptImportForm } from '../../components/forms.jsx';
import { Icon, Modal } from '../../components/ui.jsx';
import { NewEventForm } from '../../pages/EventsPage.jsx';
import { AltIcon } from './parts.jsx';

const GROUPS = [
  ['Bought', [
    { key: 'receipt', label: 'Receipt', hint: 'A shopping trip: its lines become purchases and prices', icon: AltIcon.orders, title: 'Import a receipt' },
    { key: 'ingredient', label: 'Ingredient', hint: 'One ingredient, with its first purchase if you have it', icon: Icon.carrot, title: 'New ingredient' },
  ]],
  ['Made', [
    { to: '/recipes/new', label: 'Recipe', hint: 'A dish, costed from its ingredients', icon: Icon.chefHat },
    { to: '/spice-lab/new', label: 'Spice blend', hint: 'Spices by the pinch or teaspoon, used like one ingredient', icon: Icon.starburst },
    { to: '/spice-lab/new-sauce', label: 'Sauce', hint: 'Made by the container, sold by the serving', icon: AltIcon.pantry },
  ]],
  ['Planned', [
    { key: 'event', label: 'Event', hint: 'A market, supper club or private job', icon: AltIcon.events, title: 'Plan an event' },
  ]],
];
const CHOICES = GROUPS.flatMap(([, list]) => list);

export default function QuickAdd({ onClose }) {
  const [picked, setPicked] = useState(null);
  const choice = CHOICES.find((c) => c.key === picked);
  return (
    <Modal title={choice ? choice.title : 'What are you adding?'} onClose={onClose} className="alt-add-modal">
      {!choice ? (
        <div className="add-groups">
          {GROUPS.map(([name, list]) => (
            <section key={name}>
              <h3>{name}</h3>
              <div className="add-choices">
                {list.map((c) => {
                  const inner = <><c.icon /><b>{c.label}</b><small>{c.hint}</small></>;
                  return c.to
                    ? <Link key={c.label} to={c.to} className="add-choice" onClick={onClose}>{inner}</Link>
                    : <button key={c.label} type="button" className="add-choice" onClick={() => setPicked(c.key)}>{inner}</button>;
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <>
          <button type="button" className="link-btn add-back" onClick={() => setPicked(null)}>Add something else</button>
          {picked === 'ingredient' ? <NewIngredientForm onDone={onClose} />
            : picked === 'event' ? <NewEventForm bare onCancel={onClose} />
            : <ReceiptImportForm onDone={onClose} />}
        </>
      )}
    </Modal>
  );
}
