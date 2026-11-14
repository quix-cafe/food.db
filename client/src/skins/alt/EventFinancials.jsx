// An event's financials as a statement read downwards: the revenue, each thing that comes out of
// it with a bar for its share, and the profit that's left; then every dish's cost, revenue and
// profit. Labor's hours and rate are typed on its own line (the default tab's LaborInput).
import { Decimal, money, toDecimal } from '../../format.js';
import { LaborInput } from '../../components/EventTabs.jsx';
import { Tape } from './parts.jsx';

function Line({ label, note, amount, sign = '', of, piece, strong, children }) {
  const d = toDecimal(amount) ?? new Decimal(0);
  const share = of?.gt(0) ? Math.min(100, d.abs().div(of).times(100).toNumber()) : 0;
  return (
    <div className={`st-line ${piece ?? ''} ${strong ? 'strong' : ''}`}>
      <span className="st-label">{label}{note && <small>{note}</small>}</span>
      <span className="st-mid">{children}</span>
      <span className="st-bar" aria-hidden="true">{of && <i style={{ width: `${share}%` }} />}</span>
      <b className="st-amount">{sign}{money(d.abs())}</b>
    </div>
  );
}

export default function EventFinancials({ s, eventId }) {
  const flat = s.kind !== 'market';
  const supper = s.kind === 'supper_club';
  const hoamsy = s.flat?.hoamsyPercent != null;
  const revenue = toDecimal(s.revenue);
  const labor = toDecimal(s.labor.cost);
  const items = [...s.recipes.map((r) => ({ ...r, key: r.recipeId })), ...s.sauces.map((b) => ({ ...b, key: `blend:${b.blendId}`, sauce: true }))];
  const foodOf = (r) => toDecimal(r.scaledCost);
  const listed = items.reduce((a, r) => a.plus(foodOf(r)), new Decimal(0));
  const other = toDecimal(s.totalCost).minus(listed).minus(labor); // amounts set on the shopping list
  const discounts = items.reduce((a, r) => a.plus(r.discount ?? 0), new Decimal(0));
  const loss = toDecimal(s.profit).lt(0);
  const top = items.reduce((m, r) => (toDecimal(r.revenue)?.gt(m) ? toDecimal(r.revenue) : m), new Decimal(0));
  const sum = (key) => items.reduce((a, r) => a.plus(toDecimal(r[key]) ?? 0), new Decimal(0));
  // What the bars measure against: the ticket money before Hoamsy's cut where there is one.
  const whole = hoamsy ? toDecimal(s.flat.gross) : revenue;

  return (
    <div className="statement">
      <section>
        <Tape>Where the money goes</Tape>
        <div className="st-lines">
          {hoamsy && <Line label="Tickets" note={`${s.flat.tickets} × ${money(s.flat.flatPrice)}`} amount={s.flat.gross} />}
          {hoamsy && <Line label="Hoamsy fee" note={`${s.flat.hoamsyPercent}% of the tickets, taken first`} amount={s.hoamsyFee} sign="−" of={whole} piece="fee" />}
          <Line label="Revenue" strong amount={revenue}
            note={supper && !hoamsy ? `${s.flat.tickets} tickets × ${money(s.flat.flatPrice)}`
              : s.kind === 'personal_chef' ? `${money(s.flat.flatPrice)} rate + ${money(s.flat.groceries)} groceries at cost`
              : !discounts.isZero() ? `after ${money(discounts)} in deals, as if every serving sells on its deal` : null} />
          <Line label="Food" note={`${items.length} menu ${items.length === 1 ? 'item' : 'items'}, below`} amount={listed} sign="−" of={whole} piece="food" />
          {!other.toDecimalPlaces(2).isZero() && (
            <Line label="Amounts set on the shopping list" note="instead of scaling with servings" amount={other} sign={other.gt(0) ? '−' : '+'} of={whole} piece="food" />
          )}
          <Line label={<>Labor{s.labor.rate === null && <span className="badge warn">No rate</span>}</>} amount={labor} sign="−" of={whole} piece="labor">
            <span className="st-labor">
              <LaborInput key={`h:${s.labor.hours}`} eventId={eventId} field="hours" value={s.labor.hours} />
              <LaborInput key={`r:${s.labor.rate}`} eventId={eventId} field="rate" value={s.labor.rate} />
            </span>
          </Line>
          {!toDecimal(s.vendorFee).isZero() && <Line label="Vendor fee" amount={s.vendorFee} sign="−" of={whole} piece="fee" />}
          <Line label={loss ? 'Loss' : 'Profit'} strong amount={s.profit} sign={loss ? '−' : ''} of={whole} piece={loss ? 'lost' : 'left'}
            note={`${s.marginPercent == null ? '—' : `${s.marginPercent}%`} net margin, ${s.grossMarginPercent == null ? '—' : `${s.grossMarginPercent}%`} gross margin on food`} />
        </div>
        {flat && toDecimal(s.flat.passThrough)?.gt(0) && (
          <p className="st-note">
            Labor and the vendor fee ({money(s.flat.passThrough)}) come out of the {supper ? 'tickets' : 'rate'} at cost first. What’s left is shared between the dishes by their food cost, so each dish’s margin below is a margin on food.
          </p>
        )}
      </section>

      <section>
        <Tape>By dish</Tape>
        <div className="table-wrap">
          <table className="st-dishes">
            <thead>
              <tr>
                <th>Dish</th><th className="num">Servings</th>
                <th className="num">Cost</th><th className="num">Revenue</th>
                <th className="st-dish-bar"><span className="visually-hidden">Revenue, with the food’s cost filled in</span></th>
                <th className="num">Profit</th><th className="num">Margin</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const cost = foodOf(r);
                const rev = toDecimal(r.revenue) ?? new Decimal(0);
                const profit = rev.minus(cost);
                return (
                  <tr key={r.key}>
                    <td>
                      {r.name}{r.sauce && <span className="badge">Sauce</span>}
                      <small>
                        {r.servingLabel ? `${r.servingLabel} a serving` : r.sauce ? `${r.containers} × ${r.container}` : ''}
                        {!toDecimal(r.discount ?? 0).isZero() && `${r.servingLabel ? ', ' : ''}${money(r.discount)} off in deals`}
                      </small>
                    </td>
                    <td className="num">{r.expectedServings}<small>× {money(r.costPerServing)} cost</small></td>
                    <td className="num">{money(cost)}</td>
                    <td className="num">
                      {money(rev)}
                      <small title={flat ? `${r.share}% of the food cost, so ${r.share}% of what’s shared out` : r.priceSet ? `The recipe’s own price is ${money(r.recommendedPrice)}` : undefined}>
                        {flat ? (r.netPrice == null ? '' : `${money(r.netPrice)} a serving`) : `${money(r.salePrice)} a serving${r.priceSet ? ', set here' : ''}`}
                      </small>
                    </td>
                    <td className="st-dish-bar">
                      {top.gt(0) && rev.gt(0) && (
                        <span className="take-bar" aria-hidden="true"><span style={{ width: `${Math.max(3, rev.div(top).times(100).toNumber())}%` }}><i style={{ width: `${Math.min(100, cost.div(rev).times(100).toNumber())}%` }} /></span></span>
                      )}
                    </td>
                    <td className={`num ${profit.lt(0) ? 'loss' : 'profit'}`}><b>{money(profit)}</b></td>
                    <td className="num">{rev.gt(0) ? `${profit.div(rev).times(100).toFixed(1)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>All dishes{flat && <small>A plate, one serving of each: cost {money(sum('costPerServing'))}, revenue {money(sum('netPrice'))}, profit {money(sum('marginPerServing'))}</small>}</td>
                <td className="num">{items.reduce((a, r) => a + Number(r.expectedServings), 0)}</td>
                <td className="num">{money(listed)}</td>
                <td className="num">{money(sum('revenue'))}</td>
                <td className="st-dish-bar" />
                <td className="num"><b>{money(sum('revenue').minus(listed))}</b></td>
                <td className="num">{sum('revenue').gt(0) ? `${sum('revenue').minus(listed).div(sum('revenue')).times(100).toFixed(1)}%` : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}
