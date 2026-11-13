import { orderTimes } from '@kitchen/shared';
import { useTick } from '../hooks.js';
import { duration } from '../format.js';
import { time } from './Sales.jsx';

/** How long an order has taken since it was placed, counting up while it's in progress. */
export function OrderTiming({ order }) {
  const open = order.status === 'in_progress';
  useTick(open);
  const t = orderTimes(order);
  if (t.total === null && t.making === null) return null; // handed over on the spot
  const when = [
    `Placed ${time(order.createdAt)}`,
    order.inProgressAt && new Date(order.inProgressAt) - new Date(order.createdAt) > 1000 && `started ${time(order.inProgressAt)}`,
    order.completedAt && `completed ${time(order.completedAt)}`,
  ].filter(Boolean).join(', ');
  const seconds = t.total ?? t.making;
  return (
    <dl className="order-timing" title={when}>
      <div className={open ? 'running' : ''}>
        <dt>{open ? 'Waiting' : 'Took'}</dt>
        <dd>{seconds === null ? '—' : duration(seconds)}</dd>
      </div>
    </dl>
  );
}
