# Kitchen Cost

Kitchen Cost is a recipe costing and kitchen purchasing app. It keeps the price history of every ingredient you buy, costs recipes from the latest prices, and scales them to any number of servings. It also plans events with combined shopping lists, and imports receipts that you have already turned into JSON (for example with qwen).

It runs as a Node.js server with a PostgreSQL database and opens in your browser. Everything stays on your machine.

## Requirements

| | Linux | macOS |
|---|---|---|
| **Docker** (option 1 and 2) | Docker Engine with the Compose plugin. Install it from your distribution or [docs.docker.com/engine/install](https://docs.docker.com/engine/install/). | [Docker Desktop](https://www.docker.com/products/docker-desktop/), [OrbStack](https://orbstack.dev) or Colima. |
| **Node.js 22+** (option 2 and 3) | [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`), or your distribution's `nodejs` package if it is 22 or newer. | `brew install node@22`, or nvm. |
| **PostgreSQL 15+** (option 3 only) | See [Without Docker](#option-3-without-docker) | `brew install postgresql@17` |
| **git** | `sudo apt install git` / `sudo dnf install git` | `xcode-select --install` |

Check versions with `docker compose version` and `node -v`. On Linux, if `docker` needs `sudo`, add yourself to the `docker` group (`sudo usermod -aG docker $USER`), then log out and back in.

Get the code:

```bash
git clone https://github.com/quix-cafe/food.db.git
cd food.db
```

## Option 1: Run everything with Docker (recommended)

This needs only Docker; Node.js is not required.

```bash
docker compose up -d --build
```

Open **http://localhost:3000**. The first start builds the app image and runs the database migrations automatically.

To load sample ingredients, recipes and an event into an empty database:

```bash
docker compose exec app node server/src/seed.js
```

Day to day:

```bash
docker compose stop            # stop (data is kept)
docker compose start           # start again
docker compose logs -f app     # follow the server log
git pull && docker compose up -d --build   # update to the latest version
```

Your data lives in Docker volumes: `pgdata` (the database), `uploads` (recipe and receipt photos) and `backups` (automatic copies made before a restore). They survive restarts and rebuilds. `docker compose down -v` **deletes them**, so download a backup first.

## Option 2: Development setup (Node.js + Docker database)

Use this if you want to change the code. The database runs in Docker. The API and the web app run on your machine with live reload.

```bash
npm install
cp .env.example .env
npm run db:up        # PostgreSQL in Docker on port 5432 (also creates the kitchen_test database)
npm run seed         # optional sample data
npm run dev          # API on :3000, web app on :5173
```

Open **http://localhost:5173**. The web app forwards `/api` requests to the API on port 3000.

Don't run this alongside option 1. Both use port 3000, so stop the Docker app first with `docker compose stop app`.

Other commands:

```bash
npm test             # all tests (the server tests wipe and recreate the kitchen_test database)
npm run build        # build the web app into client/dist
npm start            # serve the API and the built web app together on :3000
npm run migrate      # apply database migrations (also runs on every server start)
```

## Option 3: Without Docker

Install PostgreSQL 15 or newer, then create the `kitchen` user and two databases. The app enables the `pg_trgm` extension itself; it ships with PostgreSQL, but some Linux distributions package it separately as "contrib".

**macOS (Homebrew)**

```bash
brew install postgresql@17
brew services start postgresql@17
psql postgres -c "CREATE ROLE kitchen LOGIN PASSWORD 'kitchen';"
createdb -O kitchen kitchen
createdb -O kitchen kitchen_test
```

**Debian / Ubuntu**

```bash
sudo apt install postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE ROLE kitchen LOGIN PASSWORD 'kitchen';"
sudo -u postgres createdb -O kitchen kitchen
sudo -u postgres createdb -O kitchen kitchen_test
```

**Fedora / RHEL**

```bash
sudo dnf install postgresql-server postgresql-contrib
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE ROLE kitchen LOGIN PASSWORD 'kitchen';"
sudo -u postgres createdb -O kitchen kitchen
sudo -u postgres createdb -O kitchen kitchen_test
```

Fedora's default `pg_hba.conf` uses `ident` for connections over 127.0.0.1, which rejects password logins. In `/var/lib/pgsql/data/pg_hba.conf`, change `ident` to `scram-sha-256` on the `host` lines, then run `sudo systemctl restart postgresql`.

Then follow option 2 from `npm install`, but skip `npm run db:up`. For a single-process setup like option 1, use `npm run build && npm start` and open http://localhost:3000.

## Configuration

Settings are read from `.env` in the project root (copy `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://kitchen:kitchen@localhost:5432/kitchen` | Main database |
| `TEST_DATABASE_URL` | none | Database used by `npm test`; **its contents are deleted on every run** |
| `PORT` | `3000` | API / app port |
| `UPLOAD_DIR` | `data/uploads` | Where photos are stored (relative to the project root) |
| `BACKUP_DIR` | `data/backups` | Where automatic pre-restore copies are kept |
| `PRICE_HIKE_THRESHOLD` | `10` | Percent increase that flags a vendor price hike |

## Importing receipts

Turn a receipt photo into JSON with your extraction tool, then click **Quick add → Import receipt**. Paste the JSON or drop the `.json` file, along with the receipt photos if you want them kept. Most layouts work:

- a flat `items` list, sections (`{"sections": {"Produce": [...]}}`) or groups (`{"section": ..., "entries": [...]}`)
- discount lines, coupons and "PRICE YOU PAY" lines
- quantities like `"2.21 lb"` or `"2 @ $2.99 ea"`

`tests/receipt1.json` and `tests/receipt2.json` are working examples.

Nothing is saved until you tick lines on the review screen. If you rename a line, the receipt's wording is remembered and matched automatically next time.

## Backups

Open **Backup** in the sidebar.

- **Download backup** saves one `.tar.gz` file with everything: ingredients and price history, receipt names, receipts, recipes, events and all photos.
- **Restore** uploads a backup and shows what's in it next to what's in the app now. Nothing changes until you confirm. A restore replaces all data.
- Before each restore, the current data is saved automatically. The last 10 copies are listed under **Automatic copies**, where you can download them. In Docker they're kept in the `backups` volume (`BACKUP_DIR` elsewhere).

You can restore a backup made by an older version of the app. A backup from a newer version is refused until you update.

You can still use the database tools directly if you prefer. This copies the data but not the photos:

```bash
docker compose exec -T db pg_dump -U kitchen kitchen > kitchen-backup.sql
```

## Troubleshooting

- **`address already in use` on port 3000 or 5432.** Another process is using the port, for example `npm run dev` or a local PostgreSQL. Find it with `lsof -i :3000` (macOS) or `ss -ltnp 'sport = :3000'` (Linux), and stop it.
- **App container exits with `getaddrinfo EAI_AGAIN db`.** Its network setup was interrupted, usually by a failed start. Recreate it with `docker compose up -d --force-recreate app`.
- **iPhone photos are rejected.** HEIC images can't be shown in browsers. Export them as JPEG, or set the camera to "Most Compatible".
