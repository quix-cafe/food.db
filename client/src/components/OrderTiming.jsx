import { orderTimes } from '@kitchen/shared';
import { useTick } from '../hooks.js';
import { duration } from '../format.js';
import { time } from './Sales.jsx';

/** How long an order waited, was being made and took overall, counting up on the stage it's at. */
export function OrderTiming({ order }) {
  const open = order.status === 'placed' || order.status === 'in_progress';
  useTick(open);
  const t = orderTimes(order);
  if (t.total === null && t.waiting === null) return null; // handed over on the spot
  const stages = [['waiting', open && t.running === 'waiting' ? 'Waiting' : 'Waited'], ['making', 'Making'], ['total', 'Total']];
  const when = [
    `Placed ${time(order.createdAt)}`,
    order.inProgressAt && `started ${time(order.inProgressAt)}`,
    order.completedAt && `completed ${time(order.completedAt)}`,
  ].filter(Boolean).join(', ');
  return (
    <dl className="order-timing" title={when}>
      {stages.map(([key, label]) => (
        <div key={key} className={t.running === key ? 'running' : ''}>
          <dt>{label}</dt>
          <dd>{t[key] === null ? '—' : duration(t[key])}</dd>
        </div>
      ))}
    </dl>
  );
}
