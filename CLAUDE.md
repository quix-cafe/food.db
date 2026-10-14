# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kitchen Cost & Recipe Manager, built from `spec.md` (the product spec; read it for intent). npm workspaces: `shared/` (costing math), `server/` (Express 5 + PostgreSQL), `client/` (React 19 + Vite SPA).

## Commands

```bash
npm install
npm run db:up            # Postgres 17 in Docker (also creates kitchen_test)
cp .env.example .env     # DATABASE_URL, TEST_DATABASE_URL, PRICE_HIKE_THRESHOLD
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
- **Receipts come in as JSON.** Extraction happens outside the app (e.g. qwen). `POST /api/ingredients/import-receipt` normalises whatever key names the extractor used (`server/src/services/receipt.js`) and suggests matching ingredients via `pg_trgm` similarity. It saves nothing. The client's Review & Confirm grid (`ReceiptReviewPage`) only commits rows the user ticks, via `POST /api/ingredients/purchase`, which matches by id or case-insensitive name and creates missing ingredients.
- **Formulas** (spec §7): line cost = unit cost × Use%/100 × qty; scale = expected/base servings; price = cost per serving / (1 − margin/100), rounded to cents, default margin 70. Event shopping list groups by ingredient + latest purchase unit: `quantity` is Σ qty × scale, `usage` additionally applies Use %, and `unitsToBuy` = ceil(usage).
- **Server conventions.** Routes validate input with helpers in `server/src/validate.js` (throw `HttpError`; the error middleware in `app.js` maps it, `CalcError` → 400). API JSON is camelCase via SQL aliases. Multi-statement writes use `tx()`.
- **Client conventions.** `useApi(path)` fetches and refetches whenever `notifyDataChanged()` fires, which every mutation calls. The event planner autosaves (debounced PUT). Styling is plain CSS tokens in `client/src/styles.css`, with Archivo bundled via `@fontsource-variable/archivo`.

`tests/` holds earlier standalone Python receipt-OCR prototypes (EasyOCR/PaddleOCR/Donut + Ollama). They are not part of the app or its test suite.
