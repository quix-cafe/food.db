# food.db

A recipe costing and kitchen purchasing app. food.db keeps the price history of every ingredient you buy and costs your recipes from the latest prices. It plans events with combined shopping lists and imports receipts you've already turned into JSON.

It runs on your computer and opens in your browser. Your data never leaves your machine.

## Install

Download the file for your computer from the [latest release](https://github.com/quix-cafe/food.db/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple silicon (M1 and later) | `food.db-<version>-darwin-arm64.tar.xz` |
| Mac with Intel | `food.db-<version>-darwin-x64.tar.xz` |
| Linux, x86-64 | `food.db-<version>-linux-x64.tar.xz` |
| Linux, ARM 64-bit (e.g. Raspberry Pi 4/5) | `food.db-<version>-linux-arm64.tar.xz` |

Unpack it and run the `food.db` file inside:

```bash
tar -xf food.db-*.tar.xz
./food.db
```

The app opens at **http://localhost:3000**. To stop it, press Ctrl+C in the terminal.

The database is built in, so there's nothing else to install. Run `./food.db --help` to change the port or the data folder, or to stop it opening the browser.

**On a Mac**, the first run is blocked because the file comes from an unidentified developer. Allow it once with `xattr -d com.apple.quarantine food.db`, or under System Settings → Privacy & Security.

## Your data

Your data is kept here:

- **Mac:** `~/Library/Application Support/food.db`
- **Linux:** `~/.local/share/food.db`

It holds the database, your photos and automatic backups.

## Update

1. Download a backup first (see [Backups](#backups)).
2. Replace the `food.db` file with the new one.

Your data stays where it is. Any database changes in the new version are applied when it starts.

## Importing receipts

1. Turn a receipt photo into JSON with your extraction tool (for example qwen).
2. Go to **Purchases → Import receipt**.
3. Paste the JSON or drop the `.json` file. Add the receipt photos too if you want to keep them.

Most layouts work:

- a flat list of items, or items grouped into sections
- discount lines, coupons and "PRICE YOU PAY" lines
- quantities like `2.21 lb` or `2 @ $2.99 ea`

Nothing is saved until you tick lines on the review screen. If you rename a line, food.db remembers the receipt's wording and matches it automatically next time.

## Backups

Open **Backup** in the sidebar.

- **Download backup** saves everything in one `.tar.gz` file, photos included.
- **Restore** shows what's in a backup next to what's in the app now. A restore replaces all your data, and nothing changes until you confirm.
- **Automatic copies:** the app saves your current data before each restore, and lists the last 10 copies for download.

A backup from an older version restores into a newer one. A backup from a newer version is refused until you update.

## Trying things out

Turn on **test mode** under **Backup → Test data**. Everything you add while it's on is marked as test data. **Clear test data** removes it all later and leaves your real data alone.

## Troubleshooting

- **`address already in use` on port 3000.** Another program is using the port. Start food.db on a different one with `./food.db --port 3001`.
- **iPhone photos are rejected.** Browsers can't show HEIC images. Export them as JPEG, or set the camera to "Most Compatible".
