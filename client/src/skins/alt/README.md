# The alternate app (`client/src/skins/alt/`)

A different food.db over the same data: another layout, another way round the app, another look.
It's switched on per browser from the Backup page's Appearance card and is off by default; the
default app is untouched while it is.

## What's different

- **Shell** (`App.jsx`): one rail across the top instead of a sidebar, so pages get the full width:
  the areas, search, Quick add (green), POS (the order screen's own gradient), the light/dark
  switch and a gear for Backup. On a phone the areas are a bar along the bottom with POS in the middle.
- **Four areas instead of six pages**, by what you're doing: Today (`/`), Events, Recipes
  (`/recipes`, and the Spice Lab at `/spice-lab`) and Pantry (`/ingredients`, and Receipts at
  `/purchases`). On a wide screen an area with two pages lists them under it on hover or focus.
  Addresses are the default app's, so links inside its pages still work.
- **Breadcrumbs** (`Crumbs`, from `trailFor` in `App.jsx`): the areas above a page, as links over
  its title ("Pantry › Receipts"). The default pages' own back links are hidden by `theme.css`.
- **Quick add** (`QuickAdd.jsx`): first what you're adding (bought, made or planned), then only
  that thing's form; a recipe, spice blend or sauce goes to its own page.
- **Today** (`TodayPage.jsx`): the next event as a ticket (its money, its menu, Open the plan /
  Shopping list / Take orders), then the last 30 days and best sellers.
- **Events** (`EventsPage.jsx`): a calendar read downwards, what's coming first, then month by
  month. A past event shows its actual revenue, or else what the order screen recorded
  (`recordedRevenue` on the events list).
- **An event** (`EventPage.jsx`): the menu is a view like the others (Menu, Shopping list,
  Financials, Sales, After the event; `?tab=` in the address), holding only what's on it, with an
  "Add dishes" picker for the rest. Each dish (`EventMenu.jsx`) reads as a sum, servings × price =
  revenue with the profit in it, worked out as you type with the shared `eventPricing`, with a bar
  for it against the biggest dish (the food's cost filled in). Serving size, the deal and "Take
  off the menu" fold under the line. At a flat-rate event the figures are the saved summary's.
  The money rail beside it shows revenue, what food, labor and the fee take, and profit, whatever
  view is open. **Financials** (`EventFinancials.jsx`) is a statement read downwards (revenue,
  each thing that comes out of it with a bar, profit; labor's hours and rate typed on its line),
  then every dish's cost, revenue, profit and margin. The plan itself is the default app's
  `useEventPlan` (`pages/EventPlanner.jsx`), so both apps save the same way.
- **Recipes** (`CookbookPage.jsx`): a recipe is a line you can click anywhere on, with a bar as
  long as its price against the dearest recipe's and the food's cost filled in. The Spice Lab's
  sauces and spice blends are the second page.
- **A recipe** (`RecipePage.jsx`) and **a spice blend or sauce** (`BlendPage.jsx`): the name as
  the title, what it makes as a sentence, what goes in as lines that read amount first with a bar
  (a recipe line's share of the cost; a blend item's share of the weight, in its pie color), and a
  tag beside them: cost, price, profit, the margin, then scaling. They edit through
  `useRecipeBuilder` (`pages/RecipeBuilder.jsx`) and `useBlendEditor` (`pages/SpiceLabPage.jsx`).
  The lines are tables because `useRowReorder` looks for `tbody > tr`.
- **Pantry** (`PantryPage.jsx`, `ReceiptsPage.jsx`): the category list filters (All items clears
  it). By name the ingredients sit on shelves by category; by Last bought, Total cost (what a
  pack costs, not per unit) or Most used they're one list. From 1280px the ingredient you open
  sits beside the list. Receipts by month with what each month came to.
- **Checking a receipt** (`ReceiptReviewPage.jsx`): each line reads packs × size at a price =
  total, with its tick box; "Tick the N that are ready" ticks every line with nothing to fix; the
  receipt (photos or text) stays beside the list. Rows and saving are `useReceiptReview`
  (`pages/ReceiptReviewPage.jsx`) and `rowUpdater` (`components/ReviewLines.jsx`).
- **An ingredient, opened** (`IngredientPanel.jsx`): the price and whether it moved at the top, then
  one thing at a time (Price with the stores cheapest first, Purchases as lines you can correct,
  Used in, Details) instead of one long scroll. It's registered with `registerSkinPart`
  (`skin.js`), so the default pages that open an ingredient open this one too. Its data and saves
  are the default panel's `useIngredientPanel`.
- **Shown as they are, restyled**: a saved receipt's page, the order screen, Backup, and the
  event's Shopping list / Sales / Results.

Words: cost, price, revenue, profit and margin, nothing cuter.

## The look (`theme.css`, `parts.jsx`)

A kitchen's own labelling. Soft gray paper (not white), black ink, magenta (`--accent`) for what
you can act on. A bar split into cost and profit has the cost in slate (`--cost`) and the profit
in green (`--basil`); teal (`--teal`) is for other figures (best sellers, the purchases line). Two devices carry it:

- `Tape`: a section's name on a strip of masking tape (Caveat Brush). Section headings on this
  app's own pages only.
- `DayDot`: a date as a day dot, its weekday and day, in one of the eight menu colors the event's
  dishes use, picked by the date (each day three colors on from the one before, so a run of
  Saturdays isn't all one color; the light ones take dark lettering). The dot in "food.db" is today's.

Green is money made, red is money lost or taken. Type is Atkinson Hyperlegible Next (bundled).

## How it's wired

- The switch calls `setSkin('alt')` (`client/src/skin.js`): `data-skin="alt"` on `<html>`, saved as
  `skin` in localStorage, applied before the first paint by `client/index.html`. `?skin=default` on
  any address turns it off, `?skin=alt` on.
- `main.jsx` renders this folder's `App.jsx` instead of the default `App`, lazily, so none of it
  (fonts included) reaches a browser with the theme off. Switching is live.
- `theme.css` stays loaded after switching back, so every rule is nested under
  `:root[data-skin='alt']`. It redefines every token `styles.css` has (those outrank the default's
  dark set, so the dark block here must redefine them too), then overrides the few default classes
  that need it. `styles.css` is still underneath: the default pages keep their own layout rules.
- The rail's wrapper carries the default `.topbar` class on purpose: `useStickyTableHeads` measures
  it for sticky table heads (`--sticky-top`) and hides it on a phone while scrolling down.

## Rules

- Keep the work in this folder. Outside it, only add exports the default app doesn't notice
  (so far: `useEventPlan` and the planner's helpers, `useRecipeBuilder` and its `AmountInput`,
  `useBlendEditor`, `useReceiptReview`, `rowUpdater`, `LaborInput`, `useIngredientPanel` and the
  drawer's inputs,
  `BlendPie`, `DuplicatesNotice`, the shell pieces in `App.jsx`); the default app must look and behave exactly as before.
- Never reimplement a formula or a save: use `shared/`, `api.js`, `hooks.js` and the default
  components. No server changes for the theme's sake.
- Don't put `container-type` or a transform on anything that holds a default page or component:
  their dialogs and drawers are `position: fixed` and would be trapped inside it.
- Phones, dark mode and printing (the shopping list prints via `.print-target`) must keep working.
