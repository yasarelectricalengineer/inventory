# Stockroom – Frontend-Only Product Inventory Manager

A complete product inventory app that runs **entirely in your browser**.

- No backend, no server, no database, no API, no login
- No third-party libraries, fonts or CDNs (plain HTML, CSS and JavaScript)
- Nothing is ever sent anywhere. The page even ships a Content-Security-Policy that blocks all network connections
- Deploys as a static site on any free host

## Features

- **Dashboard**: total products, categories, companies, stock quantity, inventory value, low-stock and out-of-stock counts
- **Products**: table (cards on mobile) with image, category, lowest price, best supplier, stock, status, compare, edit and delete
- **Multiple suppliers per product**: add any number of companies for one product, each with its own purchase price, optional supplier product code and optional notes
- **Automatic lowest-price highlight**: the cheapest supplier gets a green **LOWEST PRICE** badge, live while you type in the form and everywhere prices are shown
- **Product details page** (click a product name): *Supplier Price Comparison* table (supplier, code, price, difference from the lowest, status, notes), a *Best supplier* summary and the saving versus the highest price
- **Add / edit product**: image picker with preview, change and remove; inline validation; quick "+" buttons to add a company or category without leaving the form
- **Search**: instant search by product name, any supplier name, supplier product code, category or any supplier price
- **Filters**: category, supplier, stock status, min/max price range, and sorting by lowest price, name or stock
- **Reports**: biggest supplier price differences (where you can save the most)
- **Categories and companies**: add, rename, delete, search. A category or company that is still used by a product cannot be deleted
- **Stock status**: Out of Stock when stock is 0; Low Stock when stock is above 0 and at or below the minimum level; otherwise In Stock
- **Backup**: export all data to JSON, import it back, export products to CSV
- **Settings**: currency symbol, storage info, Clear All Data (with confirmation)
- Responsive layout with an off-canvas menu on mobile; follows your system light/dark theme

## How price comparison works

- For every product, the **lowest price** is the smallest purchase price among its suppliers. The **price difference** for a supplier is `supplier price − lowest price`, and the saving is `highest price − lowest price`. Everything is recalculated from the stored data each time it is shown, so it updates immediately when you add or edit a price.
- If several suppliers share the lowest price, all of them are listed as best. If all prices are equal, no supplier is marked lowest.
- **Price range filter and price sorting** use the product's lowest price. If you pick a supplier in the filter, they use *that supplier's* price instead.
- **Inventory value** (dashboard and reports) is stock quantity × the product's **lowest** supplier price.
- A company cannot be deleted while any product lists it as a supplier. A company can appear only once per product.
- Data saved by the first version (one company and one price per product) is converted automatically to a single supplier the first time the app opens, and old JSON backups still import.

## 1. Run locally

No build step and no dependencies.

**Option A: just open it.** Double-click `index.html`. This works in most browsers.

**Option B: use a tiny local web server** (recommended, behaves exactly like hosting):

```bash
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080
```

or

```bash
npx serve .
```

> Data is stored per browser *and per address*. `http://localhost:8080`, `file:///…/index.html` and your hosted URL each have their **own separate** data. Use Export/Import to move data between them.

## 2. How local storage works

- Products, categories and companies are saved in your browser's **IndexedDB** database (`stockroom-db`). Each product's supplier prices are stored inside its record, and product images are stored there too as compressed data (images are shrunk to at most 640 px and saved as JPEG so they stay small).
- If IndexedDB is unavailable (some private-browsing modes), the app automatically falls back to **localStorage**, which has a much smaller limit (about 5 MB). A notice appears when this happens.
- The currency symbol and a few small flags are kept in localStorage.
- Data survives page refreshes, navigation, and closing and reopening the browser.
- The data lives **only on that device and browser profile**. It is lost if you clear site data or cookies, uninstall the browser, use a private/incognito window, or the browser evicts storage under disk pressure. The app asks the browser to protect its storage, but that is not guaranteed.

**Export a backup regularly.**

## 3. Export and import data

Open **Reports / Export & Import** or **Settings**.

- **Export data (JSON)**: downloads `inventory-backup-YYYY-MM-DD.json` with all products (including supplier prices and images), categories and companies.
- **Import data (JSON)**: pick a file you exported earlier. You'll see a confirmation showing what it contains. Importing **replaces** all current data.
- **Export products (CSV)**: downloads a spreadsheet-friendly list (name, category, lowest price, best supplier, highest price, number of suppliers, all suppliers with prices and codes, stock, minimum level, status, stock value). It does not include images and is not meant for re-import; use JSON for backups.
- **Clear all data** (Settings): asks for confirmation, then deletes everything from this browser.

Moving to a new device: export on the old one, open the app on the new one, import.

## 4. Deploy to GitHub Pages

1. Create a GitHub repository and push these files to it (`index.html` at the repository root, with the `css/` and `js/` folders).
2. In the repository go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose your main branch and the `/ (root)` folder, then **Save**.
4. After a minute, the site is live at `https://<your-username>.github.io/<repository-name>/`.

## 5. Deploy to Cloudflare Pages

1. Push the project to a GitHub or GitLab repository (or use Direct Upload).
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages**.
3. **Connect to Git** and select the repository. Set **Framework preset** to *None*, leave the **Build command** empty and set **Build output directory** to `/` (or leave it blank).
4. Click **Save and Deploy**. The site is served at `https://<project-name>.pages.dev`.

For a no-Git route, choose **Direct Upload** and drag the project folder in.

## 6. Deploy to Netlify

**Drag and drop:** open <https://app.netlify.com/drop> and drop the project folder.

**From Git:**

1. Choose **Add new site → Import an existing project** and select your repository.
2. Leave the **Build command** empty and set **Publish directory** to `.` (the repository root).
3. Click **Deploy**.

## Project structure

```
index.html        page structure and dialogs
css/styles.css    layout, theme, responsive rules
js/app.js         storage, state, rendering, import/export
README.md
```

## Privacy and security notes

- No analytics, tracking, remote fonts or external requests of any kind.
- A `Content-Security-Policy` meta tag restricts the page to its own files and blocks network connections (`connect-src 'none'`).
- All text is HTML-escaped before display. Exported CSV text is protected against spreadsheet formula injection, and imported images are only accepted as `data:image/...` values.
- Anyone who can use your browser profile can see the data. The app has no login by design.

## Tech and licence

Plain HTML, CSS and vanilla JavaScript with no dependencies. Use, modify and host it freely.
