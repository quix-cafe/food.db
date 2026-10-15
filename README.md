# food.db

food.db is a recipe costing and kitchen purchasing app. It keeps the price history of every ingredient you buy, costs recipes from the latest prices, and scales them to any number of servings. It also plans events with combined shopping lists, and imports receipts that you have already turned into JSON (for example with qwen).

It runs in Docker and opens in your browser. Everything stays on your machine.

## Install

### Linux

1. Install Docker Engine with the Compose plugin, from your distribution or [docs.docker.com/engine/install](https://docs.docker.com/engine/install/). Check it with `docker compose version`.
2. If `docker` needs `sudo`, add yourself to the `docker` group, then log out and back in:

   ```bash
   sudo usermod -aG docker $USER
   ```

### macOS

1. Install [OrbStack](https://orbstack.dev) (or `brew install orbstack`) and open it once so it finishes setting up.
2. Check it with `docker compose version` in Terminal. OrbStack provides the `docker` commands.

### Then, on either

```bash
git clone https://github.com/quix-cafe/food.db.git
cd food.db
docker compose up -d
```

Open **http://localhost:3000**. The first start downloads the app (a ready-made image from `ghcr.io/quix-cafe/food.db`) and the database.

To try it with sample ingredients, recipes and an event (only works on an empty database):

```bash
docker compose exec app node server/src/seed.js
```

## Update

From the `food.db` folder:

```bash
git pull
docker compose pull
docker compose up -d
```

Your data is kept. Any database changes in the new version are applied automatically when the app starts. It's a good idea to download a backup first (see [Backups](#backups)).

### Automatic updates with tugtainer

[tugtainer](https://github.com/Quenary/tugtainer) can apply new versions for you. Every push to `main` publishes a new `ghcr.io/quix-cafe/food.db:latest`, and tugtainer notices it by comparing image digests.

1. In tugtainer, find the **fooddb-app** container and set it to **auto-update** (or check only, if you'd rather click Update yourself).
2. Leave **fooddb-db** on check only. It gets PostgreSQL 17 bug-fix releases; tugtainer stops the app first and restarts it after.

The app has a health check (`/api/health`, which also checks the database), so if a new version doesn't start properly tugtainer rolls back to the previous one. `git pull` is still worth running now and then, for changes to `docker-compose.yml` itself.

## Day to day

The app keeps running in the background and starts again when Docker or OrbStack starts.

```bash
docker compose stop            # stop it (data is kept)
docker compose start           # start it again
docker compose logs -f app     # follow the server log
```

Your data lives in Docker volumes: `pgdata` (the database), `uploads` (recipe and receipt photos) and `backups` (automatic copies made before a restore). They survive restarts, updates and rebuilds. `docker compose down -v` **deletes them**, so download a backup first.

## Importing receipts

Turn a receipt photo into JSON with your extraction tool, then click **Quick add → Import receipt**. Paste the JSON or drop the `.json` file, along with the receipt photos if you want them kept. Most layouts work:

- a flat `items` list, sections (`{"sections": {"Produce": [...]}}`) or groups (`{"section": ..., "entries": [...]}`)
- discount lines, coupons and "PRICE YOU PAY" lines
- quantities like `"2.21 lb"` or `"2 @ $2.99 ea"`

`tests/receipt1.json` and `tests/receipt2.json` are working examples.

Nothing is saved until you tick lines on the review screen. If you rename a line, the receipt's wording is remembered and matched automatically next time. Saved receipts are listed under **Purchases**.

## Backups

Open **Backup** in the sidebar.

- **Download backup** saves one `.tar.gz` file with everything: ingredients and price history, receipt names, purchases, recipes, events and all photos.
- **Restore** uploads a backup and shows what's in it next to what's in the app now. Nothing changes until you confirm. A restore replaces all data.
- Before each restore, the current data is saved automatically. The last 10 copies are listed under **Automatic copies**, where you can download them.

A backup from an older version of the app restores into a newer one. A backup from a newer version is refused until you update.

## Troubleshooting

- **`address already in use` on port 3000 or 5432.** Another program is using the port. Find it with `ss -ltnp 'sport = :3000'` (Linux) or `lsof -i :3000` (macOS), and stop it.
- **The app container exits with `getaddrinfo EAI_AGAIN db`.** Its network setup was interrupted, usually by a failed start. Recreate it with `docker compose up -d --force-recreate app`.
- **iPhone photos are rejected.** HEIC images can't be shown in browsers. Export them as JPEG, or set the camera to "Most Compatible".

## Development

To change the code, see `CLAUDE.md` for the development setup, commands and architecture.
