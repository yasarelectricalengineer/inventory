/* Stockroom – frontend-only product inventory manager.
 * No backend, no network calls. Data lives in this browser's IndexedDB
 * (with a localStorage fallback if IndexedDB is unavailable).
 */
(() => {
  'use strict';

  /* ---------- Helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const icon = (name) => `<svg class="ico"><use href="#i-${name}"/></svg>`;
  const norm = (s) => String(s).trim().toLowerCase();
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  /* ---------- Settings (small, kept in localStorage) ---------- */
  const SETTINGS_KEY = 'stockroom:settings';
  const settings = (() => {
    const defaults = { currency: 'AED', seeded: false, lastBackup: null };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch (e) {
      return { ...defaults };
    }
  })();
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ---------- Storage layer: IndexedDB with localStorage fallback ---------- */
  const STORES = ['products', 'categories', 'companies'];
  const Store = {
    mode: 'indexeddb',
    db: null,

    async init() {
      try {
        if (!window.indexedDB) throw new Error('no indexedDB');
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('stockroom-db', 1);
          req.onupgradeneeded = () => {
            STORES.forEach((s) => {
              if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
            });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('blocked'));
        });
      } catch (e) {
        this.mode = 'localStorage';
        this.db = null;
      }
    },

    _lsKey: (s) => 'stockroom:' + s,
    _lsRead(s) {
      try { return JSON.parse(localStorage.getItem(this._lsKey(s)) || '[]'); } catch (e) { return []; }
    },
    _lsWrite(s, arr) { localStorage.setItem(this._lsKey(s), JSON.stringify(arr)); },

    _tx(stores, mode, work) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(stores, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        result = work(tx);
      });
    },

    async getAll(store) {
      if (this.mode === 'localStorage') return this._lsRead(store);
      return new Promise((resolve, reject) => {
        const req = this.db.transaction(store).objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async put(store, obj) {
      if (this.mode === 'localStorage') {
        const arr = this._lsRead(store);
        const i = arr.findIndex((x) => x.id === obj.id);
        if (i >= 0) arr[i] = obj; else arr.push(obj);
        this._lsWrite(store, arr);
        return;
      }
      await this._tx(store, 'readwrite', (tx) => { tx.objectStore(store).put(obj); });
    },

    async putMany(store, arr) {
      if (this.mode === 'localStorage') {
        const map = new Map(arr.map((x) => [x.id, x]));
        this._lsWrite(store, this._lsRead(store).map((x) => map.get(x.id) || x));
        return;
      }
      await this._tx(store, 'readwrite', (tx) => { const os = tx.objectStore(store); arr.forEach((x) => os.put(x)); });
    },

    async remove(store, id) {
      if (this.mode === 'localStorage') {
        this._lsWrite(store, this._lsRead(store).filter((x) => x.id !== id));
        return;
      }
      await this._tx(store, 'readwrite', (tx) => { tx.objectStore(store).delete(id); });
    },

    /** Replace everything in one transaction (used by import and clear). */
    async replaceAll(data) {
      if (this.mode === 'localStorage') {
        const backup = STORES.map((s) => [s, localStorage.getItem(this._lsKey(s))]);
        try {
          STORES.forEach((s) => this._lsWrite(s, data[s] || []));
        } catch (e) {
          backup.forEach(([s, v]) => (v === null ? localStorage.removeItem(this._lsKey(s)) : localStorage.setItem(this._lsKey(s), v)));
          throw e;
        }
        return;
      }
      await this._tx(STORES, 'readwrite', (tx) => {
        STORES.forEach((s) => {
          const os = tx.objectStore(s);
          os.clear();
          (data[s] || []).forEach((row) => os.put(row));
        });
      });
    },
  };

  /* ---------- App state ---------- */
  const state = {
    products: [],
    categories: [],
    companies: [],
    editingId: null,
    dupSource: null,
    selected: new Set(),
    visibleIds: [],
    formImage: null,
    formSuppliers: [],
    viewId: null,
  };
  const filters = { q: '', cat: '', com: '', status: '', min: '', max: '', sort: 'name-asc' };

  const PAGES = {
    dashboard: 'Dashboard',
    products: 'Products',
    'add-product': 'Add Product',
    product: 'Product Details',
    categories: 'Categories',
    companies: 'Companies',
    reports: 'Reports / Export & Import',
    settings: 'Settings',
  };

  /* ---------- Derived data ---------- */
  const catById = (id) => state.categories.find((c) => c.id === id);
  const comById = (id) => state.companies.find((c) => c.id === id);
  const catName = (id) => (catById(id) ? catById(id).name : '—');
  const comName = (id) => (comById(id) ? comById(id).name : '—');

  function stockStatus(p) {
    if (p.stock <= 0) return 'out';
    if (p.stock <= p.minStock) return 'low';
    return 'in';
  }
  const STATUS_LABEL = { in: 'In Stock', low: 'Low Stock', out: 'Out of Stock' };
  const badge = (p) => { const s = stockStatus(p); return `<span class="badge ${s}">${STATUS_LABEL[s]}</span>`; };

  const r2 = (n) => Math.round(n * 100) / 100;

  /** Price comparison for one product: lowest, highest, saving and which suppliers are cheapest. */
  function priceInfo(p) {
    const list = (p.suppliers || []).filter((x) => isFinite(x.price));
    if (!list.length) return null;
    const prices = list.map((x) => x.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    return { list, low, high, saving: r2(high - low), best: list.filter((x) => x.price === low), count: list.length, multi: list.length > 1 };
  }
  const lowPrice = (p) => { const i = priceInfo(p); return i ? i.low : 0; };
  function bestLabel(p) {
    const i = priceInfo(p);
    if (!i) return '—';
    const names = i.best.map((x) => comName(x.companyId));
    return names.length > 1 ? `${names[0]} +${names.length - 1} tied` : names[0];
  }
  const moneyDiff = (d) => (d > 0 ? '+' + money(d) : money(0));
  const lowestBadge = '<span class="badge lowest">LOWEST PRICE</span>';

  function money(n) {
    const v = Number(n) || 0;
    const sym = settings.currency || '';
    const body = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym ? (sym.length > 1 ? `${sym} ${body}` : `${sym}${body}`) : body;
  }
  const int = (n) => (Number(n) || 0).toLocaleString();

  /* ---------- Toasts & dialogs ---------- */
  function toast(message, type = '', ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function askName({ title, label = 'Name', value = '', validate }) {
    return new Promise((resolve) => {
      const dlg = $('#nameDialog');
      const form = $('#nameForm');
      const input = $('#nameInput');
      const err = $('#nameError');
      $('#nameDialogTitle').textContent = title;
      $('#nameLabel').textContent = label;
      input.value = value;
      err.textContent = '';
      let result = null;

      const onSubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        const problem = validate ? validate(v) : '';
        if (problem) { err.textContent = problem; input.focus(); return; }
        result = v;
        dlg.close();
      };
      const onCancel = () => dlg.close();
      const onClose = () => {
        form.removeEventListener('submit', onSubmit);
        $('#nameCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        resolve(result);
      };
      form.addEventListener('submit', onSubmit);
      $('#nameCancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  function confirmBox({ title, message, okText = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('#confirmDialog');
      const ok = $('#confirmOk');
      $('#confirmTitle').textContent = title;
      $('#confirmMessage').textContent = message;
      ok.textContent = okText;
      ok.className = 'btn ' + (danger ? 'danger' : 'primary');
      let result = false;
      const onSubmit = (e) => { e.preventDefault(); result = true; dlg.close(); };
      const onCancel = () => dlg.close();
      const onClose = () => {
        $('#confirmForm').removeEventListener('submit', onSubmit);
        $('#confirmCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        resolve(result);
      };
      $('#confirmForm').addEventListener('submit', onSubmit);
      $('#confirmCancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      $('#confirmCancel').focus();
    });
  }

  function storageError(e) {
    console.error(e);
    const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)));
    toast(quota
      ? 'Browser storage is full. Remove some images or export a backup and free up space.'
      : 'Could not save to browser storage. Is private browsing on?', 'error', 6000);
  }

  /* ---------- Routing ---------- */
  function parseHash() {
    const h = (location.hash || '#dashboard').slice(1);
    if (h.startsWith('product/') && h.length > 8) {
      let id = h.slice(8);
      try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
      return { page: 'product', id };
    }
    return { page: PAGES[h] && h !== 'product' ? h : 'dashboard', id: null };
  }
  const currentPage = () => parseHash().page;

  function route() {
    const { page, id } = parseHash();
    state.viewId = id;
    if (page !== 'add-product') {
      state.editingId = null;
      state.dupSource = null;
    }
    $$('.page').forEach((sec) => { sec.hidden = sec.id !== 'page-' + page; });
    const navPage = page === 'product' ? 'products' : page;
    $$('.nav a').forEach((a) => {
      const on = a.dataset.page === navPage;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (page === 'add-product') {
      if (state.editingId) loadForm(state.editingId);
      else if (state.dupSource) loadForm(state.dupSource, true);
      else resetForm();
    }
    $('#pageTitle').textContent = page === 'add-product' ? (state.editingId ? 'Edit Product' : (state.dupSource ? 'Duplicate Product' : 'Add Product')) : PAGES[page];
    document.title = `${PAGES[page]} – Stockroom`;
    closeMenu();
    window.scrollTo(0, 0);
    renderPage(page);
  }

  function renderPage(page) {
    switch (page) {
      case 'dashboard': renderDashboard(); break;
      case 'products': renderFilters(); renderProducts(); break;
      case 'product': renderProductDetail(); break;
      case 'categories': renderSimpleList('categories'); break;
      case 'companies': renderSimpleList('companies'); break;
      case 'reports': renderReports(); break;
      case 'settings': renderSettings(); break;
      default: break;
    }
  }
  const refresh = () => renderPage(currentPage());

  function openMenu() {
    $('#app').classList.add('menu-open');
    $('#scrim').hidden = false;
    $('#menuBtn').setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    $('#app').classList.remove('menu-open');
    $('#scrim').hidden = true;
    $('#menuBtn').setAttribute('aria-expanded', 'false');
  }

  /* ---------- Dashboard ---------- */
  function totals() {
    const t = { products: state.products.length, categories: state.categories.length, companies: state.companies.length, stock: 0, value: 0, low: 0, out: 0 };
    state.products.forEach((p) => {
      t.stock += p.stock;
      t.value += p.stock * lowPrice(p);
      const s = stockStatus(p);
      if (s === 'low') t.low += 1;
      if (s === 'out') t.out += 1;
    });
    return t;
  }

  function renderDashboard() {
    const t = totals();
    const cards = [
      ['Total Products', int(t.products), ''],
      ['Total Categories', int(t.categories), ''],
      ['Total Companies', int(t.companies), ''],
      ['Total Stock Quantity', int(t.stock), ''],
      ['Total Inventory Value', money(t.value), 'wide'],
      ['Low Stock Products', int(t.low), t.low ? 'warn' : ''],
      ['Out of Stock Products', int(t.out), t.out ? 'bad' : ''],
    ];
    $('#statCards').innerHTML = cards.map(([label, value, cls]) =>
      `<div class="card ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join('');

    // Backup reminder
    const banner = $('#backupBanner');
    if (state.products.length && !settings.lastBackup) {
      banner.hidden = false;
      banner.innerHTML = `<span>${icon('alert')} You haven't exported a backup yet. Your data exists only in this browser.</span><button class="btn" type="button" data-action="export-json">Export backup</button>`;
    } else {
      banner.hidden = true;
    }

    // Needs attention
    const attention = state.products
      .filter((p) => stockStatus(p) !== 'in')
      .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name))
      .slice(0, 8);
    $('#attentionList').innerHTML = attention.length
      ? `<ul class="list">${attention.map((p) => `<li><div><div class="pname">${esc(p.name)}</div><div class="sub">${esc(bestLabel(p))} · ${int(p.stock)} left (min ${int(p.minStock)})</div></div>${badge(p)}</li>`).join('')}</ul>`
      : `<p class="muted">${state.products.length ? 'Everything is stocked above its minimum level.' : 'No products yet.'}</p>`;

    // Value by category
    const rows = categorySummary().filter((r) => r.value > 0);
    const max = Math.max(1, ...rows.map((r) => r.value));
    $('#valueByCategory').innerHTML = rows.length
      ? rows.map((r) => `<div class="bar-row"><div class="top"><span>${esc(r.name)}</span><strong>${esc(money(r.value))}</strong></div><div class="bar"><i data-w="${(r.value / max * 100).toFixed(1)}"></i></div></div>`).join('')
      : '<p class="muted">Add products with stock to see the breakdown.</p>';
    $$('#valueByCategory .bar > i').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  }

  function categorySummary() {
    const map = new Map();
    state.categories.forEach((c) => map.set(c.id, { name: c.name, products: 0, stock: 0, value: 0 }));
    state.products.forEach((p) => {
      if (!map.has(p.categoryId)) map.set(p.categoryId, { name: 'Uncategorized', products: 0, stock: 0, value: 0 });
      const r = map.get(p.categoryId);
      r.products += 1; r.stock += p.stock; r.value += p.stock * lowPrice(p);
    });
    return Array.from(map.values()).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  }

  /* ---------- Products list ---------- */
  function fillSelect(sel, items, firstLabel, current) {
    sel.innerHTML = `<option value="">${esc(firstLabel)}</option>` +
      items.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
    sel.value = items.some((i) => i.id === current) ? current : '';
  }

  function renderFilters() {
    const keepCat = filters.cat;
    fillSelect($('#fCategory'), state.categories, 'All categories', filters.cat);
    $('#fCategory').insertAdjacentHTML('beforeend', '<option value="__none">No category</option>');
    if (keepCat === '__none') $('#fCategory').value = '__none';
    fillSelect($('#fCompany'), state.companies, 'All suppliers', filters.com);
    filters.cat = $('#fCategory').value;
    filters.com = $('#fCompany').value;
    $('#fSearch').value = filters.q;
    $('#fStatus').value = filters.status;
    $('#fMin').value = filters.min;
    $('#fMax').value = filters.max;
    $('#fSort').value = filters.sort;
    $('#globalSearch').value = filters.q;
  }

  /** The price a product is judged by in filters/sorting: the chosen supplier's price, else its lowest price. */
  function effPrice(p) {
    const i = priceInfo(p);
    if (!i) return null;
    if (filters.com) {
      const mine = i.list.filter((x) => x.companyId === filters.com);
      return mine.length ? Math.min(...mine.map((x) => x.price)) : null;
    }
    return i.low;
  }

  function filteredProducts() {
    const q = norm(filters.q);
    const tokens = q ? q.split(/\s+/) : [];
    const min = filters.min === '' ? null : parseFloat(filters.min);
    const max = filters.max === '' ? null : parseFloat(filters.max);
    const list = state.products.filter((p) => {
      if (q) {
        // Every word typed must match somewhere in the product, its category or any supplier.
        const parts = [p.name, catName(p.categoryId), STATUS_LABEL[stockStatus(p)]];
        (p.suppliers || []).forEach((x) => { parts.push(comName(x.companyId), x.code || '', x.notes || '', String(x.price), x.price.toFixed(2)); });
        const hay = parts.join('\n').toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      if (filters.cat === '__none') { if (catById(p.categoryId)) return false; }
      else if (filters.cat && p.categoryId !== filters.cat) return false;
      if (filters.com && !(p.suppliers || []).some((x) => x.companyId === filters.com)) return false;
      if (filters.status && stockStatus(p) !== filters.status) return false;
      const ep = effPrice(p);
      if (min !== null && !isNaN(min) && (ep === null || ep < min)) return false;
      if (max !== null && !isNaN(max) && (ep === null || ep > max)) return false;
      return true;
    });
    const price = (p) => { const v = effPrice(p); return v === null ? Infinity : v; };
    const by = {
      'name-asc': (a, b) => a.name.localeCompare(b.name),
      'name-desc': (a, b) => b.name.localeCompare(a.name),
      'price-asc': (a, b) => price(a) - price(b) || a.name.localeCompare(b.name),
      'price-desc': (a, b) => (price(b) === Infinity ? -1 : price(a) === Infinity ? 1 : price(b) - price(a)) || a.name.localeCompare(b.name),
      'stock-asc': (a, b) => a.stock - b.stock || a.name.localeCompare(b.name),
      'stock-desc': (a, b) => b.stock - a.stock || a.name.localeCompare(b.name),
      newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    };
    return list.sort(by[filters.sort] || by['name-asc']);
  }

  const thumb = (p) => (p.image
    ? `<img class="thumb" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
    : `<span class="thumb empty" aria-hidden="true">${icon('image')}</span>`);

  function renderProducts() {
    const list = filteredProducts();
    const total = state.products.length;
    state.visibleIds = list.map((p) => p.id);
    // Only products currently shown can stay selected, so bulk actions never touch hidden rows.
    const shown = new Set(state.visibleIds);
    state.selected.forEach((id) => { if (!shown.has(id)) state.selected.delete(id); });
    $('#productCount').textContent = `Showing ${list.length} of ${total} product${total === 1 ? '' : 's'}`;
    $('#productRows').innerHTML = list.map((p) => {
      const info = priceInfo(p);
      const others = info && info.count > 1 ? `<div class="sub">${info.count} suppliers</div>` : (info ? '<div class="sub">1 supplier</div>' : '<div class="sub">No supplier</div>');
      return `
      <tr class="${state.selected.has(p.id) ? 'selected' : ''}">
        <td class="td-chk"><input type="checkbox" data-sel="${esc(p.id)}" aria-label="Select ${esc(p.name)}"${state.selected.has(p.id) ? ' checked' : ''}></td>
        <td class="td-img" data-label="Image">${thumb(p)}</td>
        <td data-label="Product"><a class="pname plink" href="#product/${encodeURIComponent(p.id)}">${esc(p.name)}</a></td>
        <td data-label="Category">${esc(catName(p.categoryId))}</td>
        <td class="num" data-label="Lowest Price">${info ? `<strong>${esc(money(info.low))}</strong>${info.multi && info.saving > 0 ? `<div class="sub">up to ${esc(money(info.high))}</div>` : ''}` : '—'}</td>
        <td data-label="Best Supplier">${esc(bestLabel(p))}${others}</td>
        <td class="num" data-label="Stock">${int(p.stock)}</td>
        <td data-label="Status">${badge(p)}</td>
        <td class="td-actions">
          <a class="icon-btn" href="#product/${encodeURIComponent(p.id)}" aria-label="View ${esc(p.name)} and compare prices" title="Compare prices">${icon('chart')}</a>
          <button class="icon-btn" type="button" data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}" title="Edit">${icon('edit')}</button>
          <button class="icon-btn" type="button" data-dup="${esc(p.id)}" aria-label="Duplicate ${esc(p.name)}" title="Duplicate">${icon('copy')}</button>
          <button class="icon-btn danger" type="button" data-del="${esc(p.id)}" aria-label="Delete ${esc(p.name)}" title="Delete">${icon('trash')}</button>
        </td>
      </tr>`;
    }).join('');

    updateSelectionUI();
    const empty = $('#productsEmpty');
    $('#productTable').hidden = list.length === 0;
    empty.hidden = list.length !== 0;
    if (!list.length) {
      const none = total === 0;
      $('#productsEmptyText').textContent = none ? 'No products yet. Add your first product to get started.' : 'No products match your search or filters.';
      $('#productsEmptyCta').hidden = !none;
    }
  }

  /* ---------- Bulk category edit ---------- */
  function updateSelectionUI() {
    const n = state.selected.size;
    const all = $('#selAll');
    all.checked = n > 0 && n === state.visibleIds.length;
    all.indeterminate = n > 0 && n < state.visibleIds.length;
    const bar = $('#bulkBar');
    bar.hidden = n === 0;
    if (n) {
      $('#bulkCount').textContent = `${n} product${n === 1 ? '' : 's'} selected`;
      fillSelect($('#bulkCategory'), state.categories, 'Choose category…', $('#bulkCategory').value);
    }
    $$('#productRows tr').forEach((tr) => {
      const cb = $('[data-sel]', tr);
      if (cb) tr.classList.toggle('selected', cb.checked);
    });
  }

  async function bulkApplyCategory(categoryId) {
    const changed = state.products
      .filter((p) => state.selected.has(p.id) && (p.categoryId || '') !== categoryId)
      .map((p) => ({ ...p, categoryId, updatedAt: Date.now() }));
    if (!changed.length) {
      toast(categoryId ? 'Those products already have that category.' : 'Those products already have no category.');
      return;
    }
    try { await Store.putMany('products', changed); } catch (e) { storageError(e); return; }
    const map = new Map(changed.map((p) => [p.id, p]));
    state.products = state.products.map((p) => map.get(p.id) || p);
    state.selected.clear();
    toast(categoryId
      ? `Category "${catName(categoryId)}" set on ${changed.length} product${changed.length === 1 ? '' : 's'}`
      : `Category removed from ${changed.length} product${changed.length === 1 ? '' : 's'}`, 'ok');
    refresh();
  }

  async function bulkSetCategory() {
    const id = $('#bulkCategory').value;
    if (!id) { toast('Choose a category first.', 'error'); $('#bulkCategory').focus(); return; }
    const n = state.selected.size;
    const ok = await confirmBox({ title: 'Set category?', message: `Set the category "${catName(id)}" on ${n} selected product${n === 1 ? '' : 's'}? Their current category will be replaced.`, okText: 'Set category' });
    if (ok) bulkApplyCategory(id);
  }

  async function bulkRemoveCategory() {
    const n = state.selected.size;
    const ok = await confirmBox({ title: 'Remove category?', message: `Remove the category from ${n} selected product${n === 1 ? '' : 's'}? They will show as "No category". The products themselves are not deleted.`, okText: 'Remove category', danger: true });
    if (ok) bulkApplyCategory('');
  }

  async function deleteProduct(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    const ok = await confirmBox({ title: 'Delete product?', message: `"${p.name}" and all its supplier prices will be permanently removed.`, okText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await Store.remove('products', id);
    } catch (e) { storageError(e); return; }
    state.products = state.products.filter((x) => x.id !== id);
    toast('Product deleted');
    if (currentPage() === 'product') location.hash = '#products'; else refresh();
  }

  function startDuplicate(id) {
    state.editingId = null;
    state.dupSource = id;
    if (currentPage() === 'add-product') route(); else location.hash = '#add-product';
  }

  function startEdit(id) {
    state.dupSource = null;
    state.editingId = id;
    if (currentPage() === 'add-product') route(); else location.hash = '#add-product';
  }

  /* ---------- Product details & supplier price comparison ---------- */
  function renderProductDetail() {
    const box = $('#productDetail');
    const p = state.products.find((x) => x.id === state.viewId);
    if (!p) {
      box.innerHTML = '<div class="panel empty"><p>That product no longer exists.</p><a class="btn primary" href="#products">Back to products</a></div>';
      return;
    }
    const info = priceInfo(p);
    const differs = info && info.multi && info.saving > 0;

    let summary;
    if (!info) {
      summary = '<p class="muted">This product has no supplier prices yet. Edit it to add suppliers.</p>';
    } else {
      const highest = info.list.filter((x) => x.price === info.high).map((x) => comName(x.companyId)).join(', ');
      let msg;
      if (!info.multi) msg = 'Add more suppliers to compare prices.';
      else if (!differs) msg = 'All suppliers charge the same price.';
      else msg = `You can save ${money(info.saving)} compared with the highest price (${money(info.high)}, ${highest}).`;
      summary = `
        <div class="best-grid">
          <div><div class="label">Best Price</div><div class="best-value">${esc(money(info.low))}</div></div>
          <div><div class="label">Supplier</div><div class="best-supplier">${info.best.map((x) => esc(comName(x.companyId))).join(', ')}</div></div>
        </div>
        <p class="savings ${differs ? 'good' : ''}">${esc(msg)}</p>`;
    }

    let table;
    if (!info) {
      table = '';
    } else {
      table = `
      <table class="table compare">
        <thead><tr><th>Supplier</th><th>Product code</th><th class="num">Price</th><th class="num">Difference</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>${info.list.map((x) => {
          const isLow = differs && x.price === info.low;
          let status = '';
          if (isLow) status = lowestBadge;
          else if (!info.multi) status = '<span class="muted">Only supplier</span>';
          else if (!differs) status = '<span class="muted">Same price</span>';
          return `<tr class="${isLow ? 'row-lowest' : ''}">
            <td data-label="Supplier"><span class="pname">${esc(x.companyId ? comName(x.companyId) : 'Unknown company')}</span></td>
            <td data-label="Product code">${esc(x.code || '—')}</td>
            <td class="num" data-label="Price"><strong>${esc(money(x.price))}</strong></td>
            <td class="num" data-label="Difference">${esc(moneyDiff(r2(x.price - info.low)))}</td>
            <td data-label="Status">${status}</td>
            <td data-label="Notes">${esc(x.notes || '—')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    }

    box.innerHTML = `
      <div class="panel detail-head">
        ${p.image ? `<img class="detail-img" src="${esc(p.image)}" alt="${esc(p.name)}">` : `<span class="detail-img empty" aria-hidden="true">${icon('image')}</span>`}
        <div class="detail-info">
          <h2>${esc(p.name)}</h2>
          <div class="meta">
            <span>Category: <strong>${esc(catName(p.categoryId))}</strong></span>
            <span>Stock: <strong>${int(p.stock)}</strong> (minimum ${int(p.minStock)})</span>
            ${badge(p)}
          </div>
          <div class="btn-row">
            <button class="btn primary" type="button" data-detail="edit">${icon('edit')}Edit product</button>
            <button class="btn" type="button" data-detail="duplicate">${icon('copy')}Duplicate</button>
            <button class="btn danger-outline" type="button" data-detail="delete">${icon('trash')}Delete</button>
            <a class="btn ghost" href="#products">Back to products</a>
          </div>
        </div>
      </div>
      <div class="panel best-box ${differs ? 'has-best' : ''}">
        <div class="panel-head"><h2>Best supplier</h2></div>
        ${summary}
      </div>
      ${info ? `<div class="panel table-panel"><div class="panel-head pad"><h2>Supplier Price Comparison</h2></div>${table}</div>` : ''}`;
  }

  /* ---------- Product form ---------- */
  const F = {
    name: () => $('#pName'), category: () => $('#pCategory'),
    stock: () => $('#pStock'), min: () => $('#pMin'),
  };

  /* Supplier rows inside the form. Values live in state.formSuppliers and are
   * updated on input, so the rows only re-render when added or removed. */
  let supKey = 0;
  const newSupplier = (x = {}) => ({
    key: ++supKey,
    id: x.id || uid(),
    companyId: x.companyId || '',
    price: x.price === undefined || x.price === null ? '' : String(x.price),
    code: x.code || '',
    notes: x.notes || '',
  });

  function companyOptions(selected) {
    return `<option value="">${state.companies.length ? 'Select company…' : 'No companies yet – use +'}</option>` +
      state.companies.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }

  function renderSupplierRows() {
    $('#supplierRows').innerHTML = state.formSuppliers.map((x, i) => `
      <div class="supplier-row" data-i="${i}">
        <div class="sr-head">
          <strong>Supplier ${i + 1}</strong>
          <span class="badge lowest" hidden>LOWEST PRICE</span>
          <button class="icon-btn danger sr-remove" type="button" data-remove="${i}" aria-label="Remove supplier ${i + 1}" title="Remove supplier"${state.formSuppliers.length < 2 ? ' hidden' : ''}>${icon('trash')}</button>
        </div>
        <div class="sr-grid">
          <div class="field"><span>Company <b class="req">*</b></span>
            <div class="with-btn">
              <select data-f="companyId" aria-label="Company for supplier ${i + 1}">${companyOptions(x.companyId)}</select>
              <button class="btn" type="button" data-quick="${i}" title="Add a new company" aria-label="Add a new company">${icon('plus')}</button>
            </div>
          </div>
          <label class="field"><span>Purchase price <b class="req">*</b></span>
            <input type="number" data-f="price" min="0" step="0.01" inputmode="decimal" value="${esc(x.price)}"></label>
          <label class="field"><span>Supplier product code <em>(optional)</em></span>
            <input type="text" data-f="code" maxlength="60" value="${esc(x.code)}" autocomplete="off"></label>
          <label class="field"><span>Notes <em>(optional)</em></span>
            <input type="text" data-f="notes" maxlength="300" value="${esc(x.notes)}" autocomplete="off"></label>
        </div>
        <small class="err" data-err></small>
      </div>`).join('');
    updateLiveLowest();
  }

  /** Highlight the cheapest supplier row as prices are typed. */
  function updateLiveLowest() {
    const rows = $$('#supplierRows .supplier-row');
    const items = state.formSuppliers.map((x) => {
      const v = parseFloat(x.price);
      return { ok: x.price !== '' && isFinite(v) && v >= 0, v: isFinite(v) ? r2(v) : 0, c: x.companyId };
    });
    const vals = items.filter((x) => x.ok).map((x) => x.v);
    const low = Math.min(...vals);
    const high = Math.max(...vals);
    const differs = vals.length > 1 && high > low;
    rows.forEach((row, i) => {
      const isLow = differs && items[i].ok && items[i].v === low;
      row.classList.toggle('lowest', isLow);
      $('.badge', row).hidden = !isLow;
    });
    const sum = $('#supplierSummary');
    if (differs) {
      const names = items.filter((x) => x.ok && x.v === low).map((x) => comName(x.c)).join(', ');
      sum.hidden = false;
      sum.textContent = `Best price ${money(low)}${names !== '—' ? ` (${names})` : ''} · highest ${money(high)} · you save ${money(r2(high - low))}`;
    } else {
      sum.hidden = true;
    }
  }

  function renderImagePreview() {
    const box = $('#imgPreview');
    if (state.formImage) {
      box.innerHTML = `<img src="${esc(state.formImage)}" alt="Product image preview">`;
      $('#removeImage').hidden = false;
      $('#pickImageLabel').textContent = 'Change image';
    } else {
      box.innerHTML = icon('image').replace('class="ico"', 'class="ico big"');
      $('#removeImage').hidden = true;
      $('#pickImageLabel').textContent = 'Choose image';
    }
  }

  function clearErrors() {
    $$('#productForm .err').forEach((e) => { e.textContent = ''; });
    $$('#productForm .invalid').forEach((e) => e.classList.remove('invalid'));
    $$('#productForm .invalid-row').forEach((e) => e.classList.remove('invalid-row'));
  }

  function fillFormSelects(categoryId) {
    fillSelect(F.category(), state.categories, 'No category', categoryId);
  }

  function resetForm() {
    $('#productForm').reset();
    clearErrors();
    state.formImage = null;
    state.formSuppliers = [newSupplier()];
    $('#pImage').value = '';
    $('#formTitle').textContent = 'Add product';
    $('#saveProduct').textContent = 'Save product';
    $('#saveAnother').hidden = false;
    fillFormSelects('');
    renderSupplierRows();
    renderImagePreview();
  }

  function loadForm(id, asCopy = false) {
    const p = state.products.find((x) => x.id === id);
    if (!p) { state.editingId = null; state.dupSource = null; resetForm(); return; }
    clearErrors();
    $('#formTitle').textContent = asCopy ? 'Duplicate product (not saved yet)' : 'Edit product';
    $('#saveProduct').textContent = asCopy ? 'Save as new product' : 'Save changes';
    $('#saveAnother').hidden = true;
    F.name().value = asCopy ? `${p.name} (Copy)` : p.name;
    F.stock().value = p.stock;
    F.min().value = p.minStock;
    fillFormSelects(p.categoryId);
    state.formSuppliers = (p.suppliers && p.suppliers.length ? p.suppliers : [{}]).map((x) => newSupplier(asCopy ? { ...x, id: undefined } : x));
    renderSupplierRows();
    state.formImage = p.image || null;
    $('#pImage').value = '';
    renderImagePreview();
    if (asCopy) { F.name().focus(); F.name().select(); }
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) { reject(new Error('Please choose an image file.')); return; }
      if (file.size > 20 * 1024 * 1024) { reject(new Error('That image is over 20 MB. Please choose a smaller one.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a valid image.'));
        img.onload = () => {
          const MAX = 640;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setErr(field, id, msg) {
    $('#' + id).textContent = msg;
    const el = F[field]();
    if (el) el.classList.add('invalid');
  }

  function readAndValidateForm() {
    clearErrors();
    let ok = true;
    const name = F.name().value.trim();
    const categoryId = F.category().value;
    const stockRaw = F.stock().value.trim();
    const minRaw = F.min().value.trim();
    const stock = Number(stockRaw);
    const minStock = Number(minRaw);

    if (!name) { setErr('name', 'pNameErr', 'Enter a product name.'); ok = false; }
    if (stockRaw === '' || !Number.isInteger(stock) || stock < 0) { setErr('stock', 'pStockErr', 'Enter a whole number, 0 or more.'); ok = false; }
    if (minRaw === '' || !Number.isInteger(minStock) || minStock < 0) { setErr('min', 'pMinErr', 'Enter a whole number, 0 or more.'); ok = false; }

    const suppliers = [];
    const seen = new Set();
    const rows = $$('#supplierRows .supplier-row');
    state.formSuppliers.forEach((x, i) => {
      const price = parseFloat(x.price);
      let msg = '';
      if (!x.companyId) msg = 'Choose a company.';
      else if (seen.has(x.companyId)) msg = 'This company is already listed for this product.';
      else if (x.price === '' || isNaN(price) || price < 0) msg = 'Enter a price of 0 or more.';
      if (msg) {
        $('[data-err]', rows[i]).textContent = msg;
        rows[i].classList.add('invalid-row');
        ok = false;
      } else {
        seen.add(x.companyId);
        suppliers.push({ id: x.id, companyId: x.companyId, price: r2(price), code: x.code.trim(), notes: x.notes.trim() });
      }
    });
    if (!state.formSuppliers.length) { $('#suppliersErr').textContent = 'Add at least one supplier.'; ok = false; }

    if (!ok) {
      const first = $('#productForm .invalid') || $('#productForm .invalid-row [data-f]');
      if (first) first.focus();
      return null;
    }
    return { name, categoryId, suppliers, stock, minStock };
  }

  async function submitProduct(addAnother) {
    const data = readAndValidateForm();
    if (!data) return;
    const now = Date.now();
    state.dupSource = null;
    const existing = state.editingId ? state.products.find((p) => p.id === state.editingId) : null;
    const product = existing
      ? { ...existing, ...data, image: state.formImage || null, updatedAt: now }
      : { id: uid(), ...data, image: state.formImage || null, createdAt: now, updatedAt: now };
    try {
      await Store.put('products', product);
    } catch (e) { storageError(e); return; }
    if (existing) {
      state.products = state.products.map((p) => (p.id === product.id ? product : p));
      toast('Product updated', 'ok');
    } else {
      state.products.push(product);
      toast('Product added', 'ok');
    }
    if (addAnother && !existing) {
      resetForm();
      F.name().focus();
    } else {
      state.editingId = null;
      location.hash = existing ? '#product/' + encodeURIComponent(product.id) : '#products';
    }
  }

  /* ---------- Categories & Companies ---------- */
  const KINDS = {
    categories: { label: 'category', Label: 'Category', field: 'categoryId', search: '#catSearch', rows: '#catRows', empty: '#catEmpty', table: '#catTable' },
    companies: { label: 'company', Label: 'Company', field: 'companyId', search: '#comSearch', rows: '#comRows', empty: '#comEmpty', table: '#comTable' },
  };

  const countUsing = (kind, id) => state.products.filter((p) => (kind === 'companies'
    ? (p.suppliers || []).some((x) => x.companyId === id)
    : p.categoryId === id)).length;

  function nameValidator(kind, exceptId) {
    return (v) => {
      if (!v) return `Enter a ${KINDS[kind].label} name.`;
      if (state[kind].some((x) => x.id !== exceptId && norm(x.name) === norm(v))) return `A ${KINDS[kind].label} with that name already exists.`;
      return '';
    };
  }

  function renderSimpleList(kind) {
    const k = KINDS[kind];
    const q = norm($(k.search).value);
    const list = state[kind]
      .filter((x) => !q || norm(x.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    $(k.rows).innerHTML = list.map((x) => `
      <tr>
        <td data-label="${k.Label}"><span class="pname">${esc(x.name)}</span></td>
        <td class="num" data-label="Products">${int(countUsing(kind, x.id))}</td>
        <td class="td-actions">
          <button class="icon-btn" type="button" data-kind="${kind}" data-edit="${esc(x.id)}" aria-label="Rename ${esc(x.name)}" title="Rename">${icon('edit')}</button>
          <button class="icon-btn" type="button" data-kind="${kind}" data-dup="${esc(x.id)}" aria-label="Duplicate ${esc(x.name)}" title="Duplicate">${icon('copy')}</button>
          <button class="icon-btn danger" type="button" data-kind="${kind}" data-del="${esc(x.id)}" aria-label="Delete ${esc(x.name)}" title="Delete">${icon('trash')}</button>
        </td>
      </tr>`).join('');
    $(k.table).hidden = list.length === 0;
    const empty = $(k.empty);
    empty.hidden = list.length !== 0;
    $('p', empty).textContent = state[kind].length ? `No ${k.label === 'category' ? 'categories' : 'companies'} match your search.` : `No ${k.label === 'category' ? 'categories' : 'companies'} yet. Use the button above to add one.`;
  }

  async function addItem(kind) {
    const name = await askName({ title: `Add ${KINDS[kind].label}`, label: `${KINDS[kind].Label} name`, validate: nameValidator(kind) });
    if (!name) return null;
    const item = { id: uid(), name, createdAt: Date.now() };
    try { await Store.put(kind, item); } catch (e) { storageError(e); return null; }
    state[kind].push(item);
    toast(`${KINDS[kind].Label} added`, 'ok');
    return item;
  }

  async function duplicateItem(kind, id) {
    const item = state[kind].find((x) => x.id === id);
    if (!item) return;
    const taken = (n) => state[kind].some((x) => norm(x.name) === norm(n));
    let suggestion = `${item.name} (Copy)`;
    for (let n = 2; taken(suggestion); n += 1) suggestion = `${item.name} (Copy ${n})`;
    const name = await askName({ title: `Duplicate ${KINDS[kind].label}`, label: `New ${KINDS[kind].label} name`, value: suggestion, validate: nameValidator(kind) });
    if (!name) return;
    const copy = { id: uid(), name, createdAt: Date.now() };
    try { await Store.put(kind, copy); } catch (e) { storageError(e); return; }
    state[kind].push(copy);
    toast(`${KINDS[kind].Label} duplicated`, 'ok');
    refresh();
  }

  async function renameItem(kind, id) {
    const item = state[kind].find((x) => x.id === id);
    if (!item) return;
    const name = await askName({ title: `Rename ${KINDS[kind].label}`, label: `${KINDS[kind].Label} name`, value: item.name, validate: nameValidator(kind, id) });
    if (!name || name === item.name) return;
    const updated = { ...item, name };
    try { await Store.put(kind, updated); } catch (e) { storageError(e); return; }
    state[kind] = state[kind].map((x) => (x.id === id ? updated : x));
    toast(`${KINDS[kind].Label} updated`, 'ok');
    refresh();
  }

  async function deleteItem(kind, id) {
    const item = state[kind].find((x) => x.id === id);
    if (!item) return;
    const used = countUsing(kind, id);
    if (used) {
      toast(`Can't delete "${item.name}": ${used} product${used === 1 ? ' uses' : 's use'} it. Change or delete ${used === 1 ? 'that product' : 'those products'} first.`, 'error', 6000);
      return;
    }
    const ok = await confirmBox({ title: `Delete ${KINDS[kind].label}?`, message: `"${item.name}" will be permanently removed.`, okText: 'Delete', danger: true });
    if (!ok) return;
    try { await Store.remove(kind, id); } catch (e) { storageError(e); return; }
    state[kind] = state[kind].filter((x) => x.id !== id);
    toast(`${KINDS[kind].Label} deleted`);
    refresh();
  }

  /* ---------- Reports & settings ---------- */
  function renderReports() {
    const low = state.products.filter((p) => stockStatus(p) !== 'in').sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
    $('#reportLow').innerHTML = low.length
      ? `<ul class="list">${low.map((p) => `<li><div><div class="pname">${esc(p.name)}</div><div class="sub">${esc(bestLabel(p))} · ${esc(catName(p.categoryId))} · ${int(p.stock)} / min ${int(p.minStock)}</div></div>${badge(p)}</li>`).join('')}</ul>`
      : '<p class="muted">No low or out-of-stock products.</p>';

    const rows = categorySummary();
    $('#reportCategory').innerHTML = rows.length
      ? `<table class="table simple"><thead><tr><th>Category</th><th class="num">Products</th><th class="num">Stock</th><th class="num">Value</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="Category">${esc(r.name)}</td><td class="num" data-label="Products">${int(r.products)}</td><td class="num" data-label="Stock">${int(r.stock)}</td><td class="num" data-label="Value">${esc(money(r.value))}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No categories yet.</p>';

    const spread = state.products
      .map((p) => ({ p, i: priceInfo(p) }))
      .filter((x) => x.i && x.i.multi && x.i.saving > 0)
      .sort((a, b) => b.i.saving - a.i.saving || a.p.name.localeCompare(b.p.name))
      .slice(0, 10);
    $('#reportSavings').innerHTML = spread.length
      ? `<ul class="list">${spread.map(({ p, i }) => `<li><div><a class="pname plink" href="#product/${encodeURIComponent(p.id)}">${esc(p.name)}</a><div class="sub">Best: ${esc(bestLabel(p))} at ${esc(money(i.low))} · highest ${esc(money(i.high))}</div></div><strong>Save ${esc(money(i.saving))}</strong></li>`).join('')}</ul>`
      : '<p class="muted">Add products with two or more supplier prices to see where the biggest savings are.</p>';
  }

  async function renderSettings() {
    $('#currencyInput').value = settings.currency;
    const info = [['Storage engine', Store.mode === 'indexeddb' ? 'IndexedDB (this browser)' : 'localStorage fallback (IndexedDB unavailable)']];
    info.push(['Records', `${state.products.length} products, ${state.categories.length} categories, ${state.companies.length} companies`]);
    info.push(['Last backup export', settings.lastBackup ? new Date(settings.lastBackup).toLocaleString() : 'Never']);
    $('#storageInfo').innerHTML = info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const [est, persisted] = await Promise.all([
          navigator.storage.estimate(),
          navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
        ]);
        const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
        info.push(['Browser storage used', `${mb(est.usage || 0)} of about ${mb(est.quota || 0)} available`]);
        info.push(['Protected from auto-clear', persisted ? 'Yes' : 'Not guaranteed – keep backups']);
        if (currentPage() === 'settings') {
          $('#storageInfo').innerHTML = info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
        }
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- Export / import ---------- */
  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportJSON() {
    const payload = {
      app: 'stockroom-inventory',
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: { currency: settings.currency },
      categories: state.categories,
      companies: state.companies,
      products: state.products,
    };
    download(`inventory-backup-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    settings.lastBackup = Date.now();
    saveSettings();
    toast('Backup downloaded', 'ok');
    refresh();
  }

  /* Manual Google Drive backup: no API, no sign-in. We only open the normal Drive website in a new tab. */
  // Your backup folder on Google Drive. Change this one line to use a different folder.
  const DRIVE_URL = 'https://drive.google.com/drive/folders/1pCFabqhdlKb4VHPfEfAaBbRmhT5k1_RW';
  function openDrive() {
    const w = window.open(DRIVE_URL, '_blank');
    if (w) { try { w.opener = null; } catch (e) { /* ignore */ } }
    return !!w;
  }

  function driveExport() {
    exportJSON();                       // downloads the backup file
    const opened = openDrive();         // opens Google Drive in a new tab
    toast(opened
      ? 'Backup downloaded. In your Drive folder, click New → File upload and choose it.'
      : 'Backup downloaded. Pop-up was blocked, so open drive.google.com yourself and upload the file.', opened ? 'ok' : '', 8000);
  }

  function driveImport() {
    const opened = openDrive();
    if (!opened) toast('Pop-up was blocked. Open drive.google.com yourself to download your backup.', '', 6000);
    const dlg = $('#driveDialog');
    if (!dlg.open) dlg.showModal();
  }

  function csvCell(v, isText) {
    let s = String(v ?? '');
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    const header = ['Product Name', 'Category', 'Lowest Purchase Price', 'Best Supplier', 'Highest Purchase Price', 'Number of Suppliers', 'All Suppliers', 'Stock Quantity', 'Minimum Stock Level', 'Stock Status', 'Stock Value (at lowest price)'];
    const rows = state.products.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const i = priceInfo(p);
      const all = (p.suppliers || []).map((x) => `${comName(x.companyId)}: ${x.price.toFixed(2)}${x.code ? ` (code ${x.code})` : ''}`).join(' | ');
      return [
        csvCell(p.name, true), csvCell(catName(p.categoryId), true),
        i ? i.low.toFixed(2) : '', csvCell(i ? bestLabel(p) : '', true), i ? i.high.toFixed(2) : '', i ? i.count : 0,
        csvCell(all, true), p.stock, p.minStock, STATUS_LABEL[stockStatus(p)], (lowPrice(p) * p.stock).toFixed(2),
      ].join(',');
    });
    download(`products-${stamp()}.csv`, '﻿' + [header.join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
    toast(state.products.length ? 'CSV downloaded' : 'CSV downloaded (no products yet)', 'ok');
  }

  function cleanName(v) { return typeof v === 'string' ? v.trim().slice(0, 120) : ''; }
  function cleanId(v) { return typeof v === 'string' && v ? v.slice(0, 64) : uid(); }

  /** Validate and normalise an imported backup. Throws Error with a readable message. */
  function parseBackup(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !Array.isArray(raw.products) || !Array.isArray(raw.categories) || !Array.isArray(raw.companies)) {
      throw new Error('This does not look like an inventory backup (missing products, categories or companies).');
    }
    const categories = []; const companies = [];
    const catIds = new Set(); const comIds = new Set();
    raw.categories.forEach((c) => {
      const name = cleanName(c && c.name);
      if (!name) return;
      const id = cleanId(c.id); categories.push({ id, name, createdAt: num(c.createdAt) || Date.now() }); catIds.add(id);
    });
    raw.companies.forEach((c) => {
      const name = cleanName(c && c.name);
      if (!name) return;
      const id = cleanId(c.id); companies.push({ id, name, createdAt: num(c.createdAt) || Date.now() }); comIds.add(id);
    });
    // make ids unique within each store
    const dedupe = (arr) => { const s = new Set(); arr.forEach((x) => { while (s.has(x.id)) x.id = uid(); s.add(x.id); }); };
    dedupe(categories); dedupe(companies);

    const toSuppliers = (p) => {
      // New format has p.suppliers; older backups have a single companyId + price.
      const list = Array.isArray(p.suppliers) ? p.suppliers : [{ companyId: p.companyId, price: p.price }];
      const out = [];
      const sIds = new Set();
      list.forEach((x) => {
        if (!x || typeof x !== 'object' || x.price === '' || x.price === null || x.price === undefined) return;
        const price = Number(x.price);
        if (!isFinite(price) || price < 0) return;
        let id = cleanId(x.id);
        while (sIds.has(id)) id = uid();
        sIds.add(id);
        out.push({
          id,
          companyId: comIds.has(x.companyId) ? x.companyId : '',
          price: r2(price),
          code: typeof x.code === 'string' ? x.code.trim().slice(0, 60) : '',
          notes: typeof x.notes === 'string' ? x.notes.trim().slice(0, 300) : '',
        });
      });
      return out;
    };

    const products = [];
    const pIds = new Set();
    let skipped = 0;
    raw.products.forEach((p) => {
      const name = cleanName(p && p.name);
      if (!name) { skipped += 1; return; }
      const stock = Number(p.stock); const minStock = Number(p.minStock);
      let id = cleanId(p.id);
      while (pIds.has(id)) id = uid();
      pIds.add(id);
      products.push({
        id,
        name,
        categoryId: catIds.has(p.categoryId) ? p.categoryId : '',
        suppliers: toSuppliers(p),
        stock: Number.isInteger(stock) && stock >= 0 ? stock : Math.max(0, Math.floor(isFinite(stock) ? stock : 0)),
        minStock: Number.isInteger(minStock) && minStock >= 0 ? minStock : Math.max(0, Math.floor(isFinite(minStock) ? minStock : 0)),
        image: typeof p.image === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) ? p.image : null,
        createdAt: num(p.createdAt) || Date.now(),
        updatedAt: num(p.updatedAt) || Date.now(),
      });
    });
    return { categories, companies, products, skipped, currency: raw.settings && typeof raw.settings.currency === 'string' ? raw.settings.currency.slice(0, 6) : null };
  }

  async function importFile(file) {
    if (!file) return;
    let parsed;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('That file is too large to import.');
      parsed = parseBackup(await file.text());
    } catch (e) { toast(e.message, 'error', 6000); return; }
    const msg = `This will replace ALL current data with the backup: ${parsed.products.length} products, ${parsed.categories.length} categories, ${parsed.companies.length} companies.` +
      (parsed.skipped ? ` (${parsed.skipped} entries without a name will be skipped.)` : '') + ' This cannot be undone.';
    const ok = await confirmBox({ title: 'Import backup?', message: msg, okText: 'Replace data', danger: true });
    if (!ok) return;
    try {
      await Store.replaceAll({ products: parsed.products, categories: parsed.categories, companies: parsed.companies });
    } catch (e) { storageError(e); return; }
    state.products = parsed.products;
    state.categories = parsed.categories;
    state.companies = parsed.companies;
    if (parsed.currency !== null) settings.currency = parsed.currency;
    settings.seeded = true;
    saveSettings();
    Object.assign(filters, { q: '', cat: '', com: '', status: '', min: '', max: '' });
    toast('Backup restored', 'ok');
    route();
  }

  async function clearAll() {
    const ok = await confirmBox({
      title: 'Clear all data?',
      message: 'This permanently deletes every product, category, company and image stored in this browser. Export a backup first if you might need it.',
      okText: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try { await Store.replaceAll({ products: [], categories: [], companies: [] }); } catch (e) { storageError(e); return; }
    state.products = []; state.categories = []; state.companies = [];
    settings.seeded = true; settings.lastBackup = null;
    saveSettings();
    Object.assign(filters, { q: '', cat: '', com: '', status: '', min: '', max: '' });
    toast('All data cleared');
    route();
  }

  /* ---------- Event wiring ---------- */
  function bind() {
    window.addEventListener('hashchange', route);
    $('#menuBtn').addEventListener('click', () => ($('#app').classList.contains('menu-open') ? closeMenu() : openMenu()));
    $('#scrim').addEventListener('click', closeMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

    // Clicking "Add Product" in the nav while editing starts a fresh form
    $('.nav a[data-page="add-product"]').addEventListener('click', () => {
      const wasSpecial = state.editingId || state.dupSource;
      state.editingId = null; state.dupSource = null;
      if (wasSpecial && currentPage() === 'add-product') route();
    });
    $$('a[href="#add-product"]').forEach((a) => {
      if (!a.closest('.nav')) a.addEventListener('click', () => { state.editingId = null; state.dupSource = null; if (currentPage() === 'add-product') route(); });
    });

    // Global actions (export/import buttons in several places)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'export-json') exportJSON();
      else if (a === 'export-csv') exportCSV();
      else if (a === 'import-json') { $('#importFile').value = ''; $('#importFile').click(); }
      else if (a === 'drive-export') driveExport();
      else if (a === 'drive-import') driveImport();
    });
    $('#importFile').addEventListener('change', (e) => importFile(e.target.files[0]));
    $('#driveChoose').addEventListener('click', () => { $('#driveDialog').close(); $('#importFile').value = ''; $('#importFile').click(); });
    $('#driveClose').addEventListener('click', () => $('#driveDialog').close());
    $('#driveReopen').addEventListener('click', openDrive);
    $('#exportCsvProducts').addEventListener('click', exportCSV);

    // Search & filters
    const syncSearch = (value) => {
      filters.q = value;
      $('#fSearch').value = value;
      $('#globalSearch').value = value;
    };
    $('#fSearch').addEventListener('input', (e) => { syncSearch(e.target.value); renderProducts(); });
    $('#globalSearch').addEventListener('input', (e) => {
      syncSearch(e.target.value);
      if (currentPage() !== 'products') location.hash = '#products'; else renderProducts();
    });
    $('#fCategory').addEventListener('change', (e) => { filters.cat = e.target.value; renderProducts(); });
    $('#fCompany').addEventListener('change', (e) => { filters.com = e.target.value; renderProducts(); });
    $('#fStatus').addEventListener('change', (e) => { filters.status = e.target.value; renderProducts(); });
    $('#fMin').addEventListener('input', (e) => { filters.min = e.target.value; renderProducts(); });
    $('#fMax').addEventListener('input', (e) => { filters.max = e.target.value; renderProducts(); });
    $('#fSort').addEventListener('change', (e) => { filters.sort = e.target.value; renderProducts(); });
    $('#fClear').addEventListener('click', () => {
      Object.assign(filters, { q: '', cat: '', com: '', status: '', min: '', max: '', sort: 'name-asc' });
      renderFilters(); renderProducts();
    });
    $('#seeAllLow').addEventListener('click', () => { filters.status = ''; });

    // Product table actions
    $('#productRows').addEventListener('click', (e) => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      const dup = e.target.closest('[data-dup]');
      if (edit) startEdit(edit.dataset.edit);
      else if (dup) startDuplicate(dup.dataset.dup);
      else if (del) deleteProduct(del.dataset.del);
    });

    // Bulk selection
    $('#productRows').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-sel]');
      if (!cb) return;
      if (cb.checked) state.selected.add(cb.dataset.sel); else state.selected.delete(cb.dataset.sel);
      updateSelectionUI();
    });
    $('#selAll').addEventListener('change', (e) => {
      if (e.target.checked) state.visibleIds.forEach((id) => state.selected.add(id)); else state.selected.clear();
      $$('#productRows [data-sel]').forEach((cb) => { cb.checked = e.target.checked; });
      updateSelectionUI();
    });
    $('#bulkSet').addEventListener('click', bulkSetCategory);
    $('#bulkRemove').addEventListener('click', bulkRemoveCategory);
    $('#bulkClear').addEventListener('click', () => {
      state.selected.clear();
      $$('#productRows [data-sel]').forEach((cb) => { cb.checked = false; });
      updateSelectionUI();
    });

    // Product form
    $('#productForm').addEventListener('submit', (e) => { e.preventDefault(); submitProduct(false); });
    $('#saveAnother').addEventListener('click', () => submitProduct(true));
    $('#pickImage').addEventListener('click', () => $('#pImage').click());
    $('#pImage').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      $('#pImageErr').textContent = '';
      if (!file) return;
      try {
        state.formImage = await fileToDataURL(file);
        renderImagePreview();
      } catch (err) {
        $('#pImageErr').textContent = err.message;
      }
      e.target.value = '';
    });
    $('#removeImage').addEventListener('click', () => { state.formImage = null; $('#pImage').value = ''; renderImagePreview(); });
    $('#quickCategory').addEventListener('click', async () => {
      const item = await addItem('categories');
      if (item) fillFormSelects(item.id);
    });
    ['pName', 'pCategory', 'pStock', 'pMin'].forEach((id) => {
      $('#' + id).addEventListener('input', (e) => e.target.classList.remove('invalid'));
    });

    // Supplier rows
    const supplierRows = $('#supplierRows');
    const onSupplierInput = (e) => {
      const field = e.target.dataset && e.target.dataset.f;
      const row = e.target.closest('.supplier-row');
      if (!field || !row) return;
      const item = state.formSuppliers[Number(row.dataset.i)];
      if (!item) return;
      item[field] = e.target.value;
      row.classList.remove('invalid-row');
      $('[data-err]', row).textContent = '';
      if (field === 'price' || field === 'companyId') updateLiveLowest();
    };
    supplierRows.addEventListener('input', onSupplierInput);
    supplierRows.addEventListener('change', onSupplierInput);
    supplierRows.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-remove]');
      const quick = e.target.closest('[data-quick]');
      if (rm) {
        if (state.formSuppliers.length > 1) {
          state.formSuppliers.splice(Number(rm.dataset.remove), 1);
          renderSupplierRows();
        }
      } else if (quick) {
        const i = Number(quick.dataset.quick);
        const item = await addItem('companies');
        if (item && state.formSuppliers[i]) {
          state.formSuppliers[i].companyId = item.id;
          renderSupplierRows();
        }
      }
    });
    $('#addSupplier').addEventListener('click', () => {
      state.formSuppliers.push(newSupplier());
      renderSupplierRows();
      const rows = $$('#supplierRows .supplier-row');
      const sel = $('select', rows[rows.length - 1]);
      if (sel) sel.focus();
    });
    $('#suppliersErr').textContent = '';

    // Product details actions
    $('#productDetail').addEventListener('click', (e) => {
      const b = e.target.closest('[data-detail]');
      if (!b || !state.viewId) return;
      if (b.dataset.detail === 'edit') startEdit(state.viewId);
      else if (b.dataset.detail === 'duplicate') startDuplicate(state.viewId);
      else if (b.dataset.detail === 'delete') deleteProduct(state.viewId);
    });

    // Categories / companies
    $('#addCategory').addEventListener('click', async () => { if (await addItem('categories')) refresh(); });
    $('#addCompany').addEventListener('click', async () => { if (await addItem('companies')) refresh(); });
    $('#catSearch').addEventListener('input', () => renderSimpleList('categories'));
    $('#comSearch').addEventListener('input', () => renderSimpleList('companies'));
    ['#catRows', '#comRows'].forEach((sel) => {
      $(sel).addEventListener('click', (e) => {
        const btn = e.target.closest('[data-kind]');
        if (!btn) return;
        if (btn.dataset.edit) renameItem(btn.dataset.kind, btn.dataset.edit);
        else if (btn.dataset.dup) duplicateItem(btn.dataset.kind, btn.dataset.dup);
        else if (btn.dataset.del) deleteItem(btn.dataset.kind, btn.dataset.del);
      });
    });

    // Settings
    $('#currencyInput').addEventListener('input', (e) => {
      settings.currency = e.target.value.trim().slice(0, 6);
      saveSettings();
    });
    $('#clearAll').addEventListener('click', clearAll);
  }

  /* ---------- Startup ---------- */
  async function seedIfFirstRun() {
    if (settings.seeded) return;
    if (!state.products.length && !state.categories.length && !state.companies.length) {
      const seed = ['Fire Alarm', 'Fire Fighting'].map((name) => ({ id: uid(), name, createdAt: Date.now() }));
      try {
        for (const c of seed) await Store.put('categories', c);
        state.categories = seed;
      } catch (e) { /* non-fatal */ }
    }
    settings.seeded = true;
    saveSettings();
  }

  /** Older versions stored one companyId + price per product; convert to a supplier list. */
  async function migrateProducts() {
    const changed = [];
    state.products = state.products.map((p) => {
      if (Array.isArray(p.suppliers)) return p;
      const { companyId, price, ...rest } = p;
      const has = price !== undefined && price !== null && price !== '' && isFinite(Number(price));
      const np = { ...rest, suppliers: has ? [{ id: uid(), companyId: companyId || '', price: r2(Number(price)), code: '', notes: '' }] : [] };
      changed.push(np);
      return np;
    });
    for (const p of changed) {
      try { await Store.put('products', p); } catch (e) { storageError(e); break; }
    }
  }

  async function init() {
    bind();
    await Store.init();
    try {
      [state.products, state.categories, state.companies] = await Promise.all(STORES.map((s) => Store.getAll(s)));
    } catch (e) {
      storageError(e);
    }
    await migrateProducts();
    // Normalise numeric fields defensively
    state.products = state.products.map((p) => ({
      ...p,
      stock: num(Number(p.stock)),
      minStock: num(Number(p.minStock)),
      suppliers: p.suppliers.map((x) => ({ ...x, price: num(Number(x.price)) })),
    }));
    await seedIfFirstRun();
    if (Store.mode === 'localStorage') {
      toast('IndexedDB is unavailable, so data is saved in localStorage (smaller limit). Back up often.', '', 7000);
    }
    // Ask the browser not to evict our data under storage pressure (best effort, no prompt in most browsers)
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
    route();
  }

  init();
})();
