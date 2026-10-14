# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kitchen Cost & Recipe Manager, built from `spec.md` (the product spec; read it for intent). npm workspaces: `shared/` (costing math), `server/` (Express 5 + PostgreSQL), `client/` (React 19 + Vite SPA).

## Commands

```bash
npm install
npm run db:up            # Postgres 17 in Docker (also creates kitchen_test)
cp .env.example .env     # DATABASE_URL, TEST_DATABASE_URL, UPLOAD_DIR, PRICE_HIKE_THRESHOLD
npm run seed             # sample data; no-op if ingredients exist
npm run dev              # API :3000 (node --watch) + Vite :5173 (proxies /api)
npm test                 # shared unit tests + server integration tests
npm run build            # client → client/dist, served by the API in production
docker compose up --build   # full stack on :3000
```

Single test file / test: `node --test shared/test/calc.test.js`, or from `server/`: `node --env-file=../.env --test --test-name-pattern="event summary" test/api.test.js`. The server integration tests **drop and recreate the `public` schema of `TEST_DATABASE_URL`**; they skip if it is unset. Migrations (`server/migrations/*.sql`, applied in filename order, tracked in `schema_migrations`) run automatically on server start, or via `npm run migrate`.

## Architecture

- **One costing engine.** `shared/src/calc.js` (`calculateRecipe`, `summarizeEvent`, `completePurchaseCosts`, …) is imported by both the API and the browser. The recipe builder's instant "Expected servings" scaling runs it client-side with no request; the API runs the same code for `/recipes/calculate`, the gallery and event summaries. Change formulas there only.
- **Money is never a float.** All math uses `decimal.js` (the `Decimal` clone exported from shared). Postgres `numeric` comes back as strings (pg default) and API responses keep amounts as decimal strings; the client formats them via `client/src/format.js`. `pg` is configured to return `date` columns as `YYYY-MM-DD` strings (`server/src/db.js`).
- **Price history is append-only.** `ingredient_purchases` rows are never updated; "current price" is always the latest purchase by `purchase_date, created_at` via the `LATEST_PURCHASE` lateral join in `server/src/sql.js`. Recipes store only quantity and Use %, so their cost moves with new purchases.
- **Receipts come in as JSON.** Extraction happens outside the app (e.g. qwen). `POST /api/ingredients/import-receipt` normalises whatever key names the extractor used (`server/src/services/receipt.js`) and saves nothing. Each line returns `match` (auto-resolved through a saved alias in `ingredient_aliases`, else an exact name) or a `suggestion` (closest `pg_trgm` name, never applied automatically). In the Review & Confirm grid (`ReceiptReviewPage` + `ReceiptNameCell`), the receipt's wording is never overwritten. Clicking the name opens an inline combobox to type a new name or pick an existing ingredient. Enter or blur commits, Escape cancels, and "Undo rename" reverts. Only rows ticked to save are committed, via `POST /api/ingredients/purchase`. It resolves by id, then alias, then exact name, creates any missing ingredient, and stores `alias` (the receipt wording) when it differs from the chosen ingredient's name. An existing alias is re-pointed to the new choice. Aliases are listed and removable in the ingredient drawer, and `GET /api/ingredients?q=` matches them too.
- **Receipts and images.** Saving the first lines from the review grid creates a `receipts` row (vendor, date, source JSON, photos) via `POST /api/receipts` (multipart). The server also normalises the source into `receipt_lines` (same order as the import's `items`). Each review row carries its index as `receiptLine`, and saving it sets that line's `purchase_id`. Unsaved lines come back as `pendingLines` on `GET /api/receipts/:id`, grayed in the receipt page and savable later through the same `ReviewLinesTable`. Deleting a purchase un-saves its line. Receipts created before migration 004 are backfilled on first read (`ensureLines`), matching purchases to lines by resolved ingredient + total, then total. Purchases then carry `receipt_id`; deleting a receipt sets it to null and keeps the purchases. Image files live in `UPLOAD_DIR` (relative paths resolve from the repo root; default `data/uploads`; Docker volume `uploads`). The `images` table rows belong to exactly one recipe or receipt (CHECK constraint, cascade). All file I/O goes through `server/src/images.js`: formats are sniffed from file bytes (HEIC rejected), files are removed when their owner is deleted, and duplicating a recipe copies them. Position 0 is a recipe's cover. On the client, `ImageGallery` handles thumbnails, the lightbox and cover controls. Receipt photos travel from the import form to the review page in memory (`receiptDraft.js`), not in router state.
- **Formulas** (spec §7): line cost = unit cost × Use%/100 × qty; scale = expected/base servings; price = cost per serving / (1 − margin/100), rounded to cents, default margin 70. Event shopping list groups by ingredient + latest purchase unit: `quantity` is Σ qty × scale, `usage` additionally applies Use %, and `unitsToBuy` = ceil(usage).
- **Server conventions.** Routes validate input with helpers in `server/src/validate.js` (throw `HttpError`; the error middleware in `app.js` maps it, `CalcError` → 400). API JSON is camelCase via SQL aliases. Multi-statement writes use `tx()`.
- **Client conventions.** `useApi(path)` fetches and refetches whenever `notifyDataChanged()` fires, which every mutation calls. The event planner autosaves (debounced PUT). Styling is plain CSS tokens in `client/src/styles.css`, with Archivo bundled via `@fontsource-variable/archivo`.

`tests/receipt*.json` are real extractor outputs used as fixtures by `server/test/receipt.test.js`. They cover the main receipt shapes: a sections map, `{section, entries}` groups, discount and "PRICE YOU PAY" lines, `"2 @ $2.99 ea"` quantities, and nested totals. When a new extractor format breaks the import, add its JSON there with a test.
