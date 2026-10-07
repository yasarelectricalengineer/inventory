# Stockroom – Project Notes (what was built, and how)

Keep this file. If something breaks later, paste this file (or the relevant part) together with the problem so it can be fixed quickly.

## What it is
A frontend-only product inventory app (HTML + CSS + vanilla JavaScript). No backend, no database, no API, no login, no libraries. Everything is stored in the browser (IndexedDB, with localStorage as fallback). Works as a static site on GitHub Pages, Cloudflare Pages, Netlify.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page structure, all sections, dialogs, icon sprite, Content-Security-Policy meta tag |
| `css/styles.css` | Layout, light/dark theme, responsive rules (table becomes cards under 760px) |
| `js/app.js` | All logic: storage, state, rendering, search/filter, forms, import/export |
| `README.md` | Run locally, storage, import/export, deploy steps |
| `PROJECT_NOTES.md` | This file |

## Pages
Dashboard, Products, Add Product (also used for edit and duplicate), Product Details (`#product/<id>`), Categories, Companies, Reports / Export & Import, Settings.

## Data model (stored in IndexedDB database `stockroom-db`)
- `products`: `{ id, name, categoryId, suppliers[], stock, minStock, image (JPEG data URL or null), createdAt, updatedAt }`
- `suppliers[]` item: `{ id, companyId, price, code (optional), notes (optional) }`
- `categories`: `{ id, name, createdAt }`
- `companies`: `{ id, name, createdAt }`
- Settings in localStorage key `stockroom:settings`: `currency` (default `AED`), `seeded`, `lastBackup`.
- Old format (one `companyId` + `price` per product) is converted to one supplier automatically on first load (`migrateProducts`), and old backups still import (`parseBackup`).

## Features, in the order they were built

### Version 1: core app
- Dashboard: total products, categories, companies, stock quantity, inventory value, low stock, out of stock.
- Stock status: Out of Stock when stock = 0; Low Stock when stock > 0 and <= minimum; otherwise In Stock.
- Products CRUD with image (picked from device, resized to max 640 px, saved as JPEG, preview, change, remove).
- Categories and Companies: add, rename, delete, search. A category or company in use cannot be deleted. Names must be unique.
- Fire Alarm and Fire Fighting categories are created once on first run.
- Backup: Export JSON, Import JSON (replaces all data after confirmation), Export CSV, Clear All Data (confirmation dialog).
- Responsive layout with sidebar, off-canvas menu on mobile, toast messages, dark mode follows the system.
- Privacy: CSP meta tag blocks network connections; text is HTML-escaped; CSV cells are protected against formula injection; imported images must be `data:image/...`.

### Version 2: multi-supplier price comparison
- A product can have unlimited suppliers (company, price, optional code, optional notes). A company can appear once per product.
- Lowest price is calculated automatically (`priceInfo`), highlighted with a green **LOWEST PRICE** badge, live in the form and on the details page.
- Product Details page: Best Price, Supplier, saving message ("You can save ... compared with the highest price"), and the Supplier Price Comparison table (supplier, code, price, difference = price - lowest, status, notes).
- Product list columns: Lowest Price, Best Supplier (plus supplier count).
- Filters: category, supplier, status, min/max price, sort. Price range and price sorting use the lowest price, or the selected supplier's price when a supplier is chosen.
- Dashboard and reports value inventory as **stock x lowest supplier price**.
- Reports page: "Biggest supplier price differences" list.
- CSV: lowest price, best supplier, highest price, number of suppliers, all suppliers with prices and codes, stock, status, stock value.
- JSON backup version is now 2.

### Version 3: search and duplicate
- Large search box on the Products tab. Searches name, category, every supplier company, supplier code, supplier notes, any price and stock status. Several words can be typed and every word must match.
- Duplicate product: opens Add Product pre-filled as "<name> (Copy)" with suppliers and image; saved only when Save is clicked.
- Duplicate category and company: asks for a new name (suggests "<name> (Copy)").

### Version 4: manual Google Drive backup (no API)
- "Export to Google Drive": downloads the JSON backup, then opens the Drive folder in a new tab. The user uploads the file by hand.
- "Import from Google Drive": opens the Drive folder in a new tab and shows a step dialog; the user downloads the file, returns, clicks "Choose downloaded file", and the normal import runs.
- Folder used: `https://drive.google.com/drive/folders/1pCFabqhdlKb4VHPfEfAaBbRmhT5k1_RW` (constant `DRIVE_URL` near `driveExport` in `js/app.js`; change that one line to use another folder).
- No Google API, OAuth, Cloud project or billing is used anywhere.

### Version 5: bulk category edit
- Products table has a checkbox on each row and a select-all checkbox (selects only the products currently shown after search/filters).
- When products are selected a bar appears: pick a category and click **Set category** (replaces each product's category), or click **Remove category** (clears it). Both ask for confirmation, then save in one transaction (`Store.putMany`) and show a toast. Only products that actually change are counted.
- Selection is limited to visible products: if a filter hides a selected product it is unselected, so bulk actions never touch hidden rows.
- Category is now **optional** on a product (needed so "remove" makes sense). Products without one show "No category"; the Category filter has a "No category" option to find them.
- Code: `updateSelectionUI`, `bulkApplyCategory`, `bulkSetCategory`, `bulkRemoveCategory` in `js/app.js`.

## Where to look in `js/app.js`
- `Store` – IndexedDB/localStorage layer (`getAll`, `put`, `remove`, `replaceAll`)
- `priceInfo`, `bestLabel`, `lowPrice` – price comparison maths
- `filteredProducts`, `effPrice` – search, filters, sorting
- `renderProducts`, `renderProductDetail`, `renderDashboard`, `renderReports` – screens
- `renderSupplierRows`, `updateLiveLowest`, `readAndValidateForm`, `submitProduct`, `loadForm` – product form
- `startEdit`, `startDuplicate`, `duplicateItem` – edit and duplicate
- `updateSelectionUI`, `bulkApplyCategory` – bulk category edit
- `exportJSON`, `exportCSV`, `parseBackup`, `importFile`, `clearAll` – backup
- `driveExport`, `driveImport`, `DRIVE_URL` – Google Drive buttons
- `migrateProducts`, `init` – startup

## Things to know (limits and decisions)
- Data lives only in the browser profile and address (`file://`, `localhost` and the hosted URL each have separate data). Clearing site data or using private mode loses it. Export backups regularly.
- Import replaces all current data; there is no merge.
- Browser storage is limited. Many large images can fill it; images are shrunk to reduce this.
- The Drive folder link is visible in the site's source code if the site is public. Keep the folder private (not "Anyone with the link"), so only the signed-in owner can open it.
- Drive buttons only open a normal web page in a new tab; pop-up blockers can stop it (the app shows a message if so).

## Testing status (honest note)
- The JavaScript passes a syntax check, and a script checked the price maths (lowest 39 / highest 52 / saving 13), ties, stock status rules, CSV formula guard and import/migration/sanitising.
- The app was **not opened in a real browser** while building, so screen layout, clicks, dialogs, image upload and the Drive tab opening still need a manual check.

## Quick manual test checklist
1. Add 2 companies and a category; add a product with 3 suppliers (prices 45, 39, 52): the 39 row shows LOWEST PRICE live.
2. Save; open the product: best price, supplier, differences (+6, 0, +13) and "save 13" are correct.
3. Products tab: type part of a company name in the big search; filter by supplier and price range.
4. Duplicate a product, a category and a company.
5. Edit a price: lowest badge moves automatically.
6. Refresh and close/reopen the browser: data is still there.
7. Export JSON, Clear All Data, Import the same file: everything returns.
8. Export to Google Drive: file downloads and the Drive folder opens; Import from Google Drive: dialog shows and file picker opens.
9. Check on a phone-width window: menu, cards, forms.
10. Tick 3 products, choose a category, click Set category: all 3 change. Tick them again, click Remove category: they show "No category"; filter by "No category" finds them.

## How to report a problem
Say: which page, what you clicked, what you expected, what happened, which browser, and any red error text from the browser console (press F12, then Console).

## Branding & theme update
- Settings > Branding: editable app/company name (default `Ameer Fire & Safety`) and an uploadable logo that replaces the sidebar icon (same 24 x 24 px size). Logo is shrunk to max 96px PNG (keeps transparency) and stored in `stockroom:settings` (`brandName`, `brandLogo`). Included in JSON export/import. Browser tab title and favicon follow the name/logo. "Reset name & logo" restores defaults.
- Theme: black sidebar, fire red (`--fire-red`, primary buttons/active nav) and fire yellow (`--fire-yellow`, brand icon, focus ring, red-to-yellow bars and top stripe). Colors are CSS variables at the top of `css/styles.css`; dark mode is pure black.

