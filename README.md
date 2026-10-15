# food.db

food.db is a recipe costing and kitchen purchasing app. It keeps the price history of every ingredient you buy, costs recipes from the latest prices, and scales them to any number of servings. It also plans events with combined shopping lists, and imports receipts that you have already turned into JSON (for example with qwen).

It runs on your computer and opens in your browser. Everything stays on your machine.

## Download and run (no Docker)

Download the archive for your computer from the [releases page](https://github.com/quix-cafe/food.db/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple silicon (M1 and later) | `food.db-<version>-darwin-arm64.tar.xz` |
| Mac with Intel | `food.db-<version>-darwin-x64.tar.xz` |
| Linux, x86-64 | `food.db-<version>-linux-x64.tar.xz` |
| Linux, ARM (e.g. Raspberry Pi 4/5, 64-bit) | `food.db-<version>-linux-arm64.tar.xz` |

Unpack it and run the one `food.db` file inside:

```bash
tar -xf food.db-*.tar.xz
./food.db
```

It opens **http://localhost:3000** in your browser; press Ctrl+C in the terminal to stop it. On a Mac, the first run of a downloaded file is blocked as "from an unidentified developer". Clear that once with `xattr -d com.apple.quarantine food.db`, or allow it under System Settings → Privacy & Security.

The database is built in, so there's nothing else to install. Your data is kept in `~/Library/Application Support/food.db` (Mac) or `~/.local/share/food.db` (Linux). To update, replace the `food.db` file with the new one; your data stays put and any database changes are applied when it starts. Run `./food.db --help` for the options (port, data folder, not opening the browser).

The standalone version and the Docker version keep separate data. To move from one to the other, download a backup in one and restore it in the other (see [Backups](#backups)).

## Install with Docker

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
docker compose up -d --build
```

Open **http://localhost:3000**. The first start takes a few minutes to build.

To try it with sample ingredients, recipes and an event (only works on an empty database):

```bash
docker compose exec app node server/src/seed.js
```

## Update

From the `food.db` folder:

```bash
git pull
docker compose up -d --build
docker image prune -f
docker builder prune -af
```

Your data is kept. Any database changes in the new version are applied automatically when the app starts. It's a good idea to download a backup first (see [Backups](#backups)).

Each rebuild leaves the previous app image and a build cache behind, which add up to hundreds of megabytes over a few updates. The last two commands clear them. They don't touch your data. Avoid `docker system prune --volumes` and `docker compose down -v`: those delete the volumes that hold your data.

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

To build the standalone downloads, install [Bun](https://bun.sh) and run `npm run build:binary`. It builds all four targets from any machine into `dist/`; `npm run build:binary -- linux-x64` builds just one.

To publish a release, set `"version"` in `package.json`, commit, then tag and push it (`git tag v1.0.1 && git push origin v1.0.1`). The Release workflow (`.github/workflows/release.yml`) runs the tests, builds all four archives and attaches them to a new GitHub Release.
