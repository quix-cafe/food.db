# Alternate theme (`client/src/skins/alt/`)

A completely different look and structure for food.db, switched on per browser from the Backup
page's Appearance card. It's off by default; the default app is untouched while it is.

## How it's wired

- The switch calls `setSkin('alt')` (`client/src/skin.js`): `data-skin="alt"` on `<html>`, saved as
  `skin` in localStorage, applied before the first paint by `client/index.html`.
- `main.jsx` renders `AltApp` (`App.jsx` here) instead of the default `App` while it's on. It's
  loaded lazily, so none of this folder reaches a browser with the theme off. Switching is live,
  no reload.
- `theme.css` is imported by `AltApp`. Once loaded it stays loaded after switching back, so keep
  every rule scoped under `:root[data-skin='alt']` (dark variant:
  `:root[data-skin='alt'][data-theme='dark']`).
- Way out: `?skin=default` on any URL turns it off (and `?skin=alt` turns it on), in case the
  alternate app drops the Backup page or its switch. Keep a way to switch back in the UI too:
  `setSkin('default')`.

## What you can change

Anything structural: write your own shell, navigation, routes, pages and components here. Reuse
what's useful from the default app rather than copying it:

- Data and behaviour: `api.js` (`api`, `notifyDataChanged`, test mode), `hooks.js` (`useApi`,
  `useLeaveGuard`, `useOpenPos`, `useRowReorder`, …), `format.js`, and `shared/` (all costing math;
  never reimplement a formula).
- Pages and components under `client/src/pages` and `client/src/components` can be rendered as-is
  inside your own layout. `App.jsx` exports its shell pieces (`QuickAdd`, `PosFrame`, `PosButton`,
  `TestModeBar`, `NewBuildBar`, `ThemeToggle`, `AppRoutes`) for reuse.

## Rules

- Keep the work inside this folder. Outside it, only add exports or small hooks the default app
  doesn't notice; the default skin must look and behave exactly as before.
- No server or API changes for the theme's sake.
- The router is a data router (`main.jsx`), so `useBlocker` / `useLeaveGuard` work; the POS opens as
  a modal with `location.state.background` (see `App.jsx`), keep that if you keep the POS.
- Phones (≤ 640px), dark mode and printing (the shopping list prints via `.print-target`) should
  all still work.
