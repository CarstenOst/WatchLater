// WatchLater — static client-only PWA. All state lives in IndexedDB
// (db.js); every mutation goes through mutate() → wlDB.update() with a
// synchronous mutator, then the filter-drop rule, re-render, due-check.
(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const HOUR = 3600 * 1000;
  const PRESET_MS = { '8h': 8 * HOUR, '24h': 24 * HOUR, '1w': 7 * 24 * HOUR };

  let state = null;
  let route = { view: 'inbox', cat: null };
  let bootFocusDone = false;
  let savedAddForm = null;       // last-seen add-form values, restored across re-renders
  let pendingFormReset = false;  // set by addLink so the post-save render starts fresh
  let swRegFailed = !('serviceWorker' in navigator);

  // ---------- router ----------

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    const [path, query] = h.split('?');
    return {
      view: path === '/done' ? 'done' : 'inbox',
      cat: new URLSearchParams(query || '').get('cat') || null,
    };
  }

  function buildHash(view, cat) {
    const path = view === 'done' ? '#/done' : '#/';
    return cat ? path + '?cat=' + encodeURIComponent(cat) : path;
  }

  // ---------- view helpers ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  // Imported data is untrusted; only ever inject validated hex colors.
  function safeColor(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
  }

  function humanDelta(now, target) {
    const future = target - now >= 0;
    const secs = Math.trunc(Math.abs(target - now) / 1000);
    const mins = Math.trunc(secs / 60);
    const hours = Math.trunc(mins / 60);
    const days = Math.trunc(hours / 24);
    if (secs < 60) return 'now';
    if (mins < 60) return future ? 'in ' + mins + 'm' : mins + 'm ago';
    if (hours < 48) return future ? 'in ' + hours + 'h' : hours + 'h ago';
    return future ? 'in ' + days + 'd' : days + 'd ago';
  }

  function domainLabel(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const parts = host.split('.');
      return parts.length >= 2 ? parts[parts.length - 2] : host;
    } catch (_) {
      return null;
    }
  }

  function fallbackTitle(url) {
    return url.length <= 20 ? url : (domainLabel(url) || url);
  }

  function displayTitle(link) {
    return link.title && link.title.trim() ? link.title : fallbackTitle(link.url);
  }

  function makeSeedState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      categories: [
        { id: crypto.randomUUID(), name: 'Watch', color: '#ef4444' },
        { id: crypto.randomUUID(), name: 'Read', color: '#3b82f6' },
        { id: crypto.randomUUID(), name: 'General', color: '#6b7280' },
      ],
      links: [],
      settings: {},
    };
  }

  const sortedCategories = () =>
    [...state.categories].sort((a, b) => a.name.localeCompare(b.name));

  const activeCount = (catId) =>
    state.links.filter((l) => l.categoryId === catId && l.doneAt == null).length;

  const findLink = (s, id) => s.links.find((l) => l.id === id);

  // ---------- renders (markup ported from the v1 Askama templates) ----------

  function renderAddForm() {
    const cats = sortedCategories()
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
      .join('');
    return `
<form id="add-form" class="flex flex-col gap-2 bg-slate-900 rounded-xl p-4">
  <div class="flex gap-2">
    <input type="url" name="url" id="url-input" required placeholder="Paste a link…"
           class="bg-slate-800 rounded-md px-3 py-2 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500">
    <button type="button" data-action="paste" title="Paste from clipboard"
            class="bg-slate-800 hover:bg-slate-700 rounded-md px-3 text-sm whitespace-nowrap">📋 Paste</button>
  </div>
  <p id="url-error" class="hidden text-xs text-red-400">Invalid URL — include the scheme, e.g. https://example.com</p>
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
    <select name="category_id" id="category-select" class="bg-slate-800 rounded-md px-3 py-2 text-sm">
      <option value="">No category</option>
      ${cats}
      <option value="__new__">+ New category…</option>
    </select>
    <select name="remind_in" id="remind-select" class="bg-slate-800 rounded-md px-3 py-2 text-sm">
      <option value="8h">Remind in 8 hours</option>
      <option value="24h" selected>Remind in 24 hours</option>
      <option value="1w">Remind in 1 week</option>
      <option value="custom">Custom date…</option>
    </select>
  </div>
  <div id="new-cat-inline" class="hidden flex gap-2 items-center">
    <input name="new_category_name" id="inline-cat-name" required disabled placeholder="New category name"
           class="bg-slate-800 rounded-md px-3 py-2 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500">
    <input name="new_category_color" id="inline-cat-color" type="color" value="#6b7280" disabled
           class="w-8 h-8 rounded bg-slate-900 border-0 cursor-pointer">
  </div>
  <input id="custom-due" type="datetime-local" name="custom_due_at"
         class="hidden bg-slate-800 rounded-md px-3 py-2 text-sm">
  <input type="text" name="note" id="note-input" placeholder="Optional note"
         class="bg-slate-800 rounded-md px-3 py-2 text-sm">
  <button type="submit" class="bg-blue-600 hover:bg-blue-500 rounded-md py-2 text-sm font-medium">
    Save link
  </button>
</form>`;
  }

  function renderCategoryFilter() {
    const opts = sortedCategories()
      .map((c) =>
        `<option value="${c.id}"${route.cat === c.id ? ' selected' : ''}>` +
        `${escapeHtml(c.name)} (${activeCount(c.id)})</option>`)
      .join('');
    return `
<div class="flex gap-2 mb-4 items-end">
  <div class="flex-1">
    <label class="block text-xs text-slate-500 mb-1" for="category-filter">Filter by category</label>
    <select id="category-filter"
            class="w-full bg-slate-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      <option value=""${route.cat ? '' : ' selected'}>All categories</option>
      ${opts}
    </select>
  </div>
  <details class="relative">
    <summary class="list-none cursor-pointer bg-slate-800 hover:bg-slate-700 rounded-md px-3 py-2 text-sm whitespace-nowrap">
      + Category
    </summary>
    <form id="new-cat-form"
          class="absolute right-0 top-full mt-1 z-10 bg-slate-800 p-3 rounded-md shadow-lg flex gap-2 min-w-[18rem]">
      <input name="name" id="new-cat-name" required placeholder="Name"
             class="bg-slate-900 rounded-md px-2 py-1 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500">
      <input name="color" id="new-cat-color" type="color" value="#6b7280"
             class="w-8 h-8 rounded bg-slate-900 border-0 cursor-pointer">
      <button type="submit" class="bg-blue-600 hover:bg-blue-500 rounded-md px-3 text-sm">Add</button>
    </form>
  </details>
</div>`;
  }

  function renderLinkRow(link, now) {
    const cat = link.categoryId
      ? state.categories.find((c) => c.id === link.categoryId)
      : null;
    const color = cat ? safeColor(cat.color) : null;
    const overdue = link.dueAt <= now;
    return `
<li data-id="${link.id}" class="bg-slate-900 rounded-xl p-3">
  <div class="flex items-start justify-between gap-3">
    <div class="flex-1 min-w-0">
      <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener"
         class="font-medium text-slate-100 hover:text-blue-400 break-all">${escapeHtml(displayTitle(link))}</a>
      ${link.note ? `<p class="text-xs text-slate-400 mt-1">${escapeHtml(link.note)}</p>` : ''}
      <div class="text-xs text-slate-500 mt-1 flex flex-wrap gap-2 items-center">
        ${cat ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800">
          ${color ? `<span class="w-2 h-2 rounded-full" style="background-color: ${color}"></span>` : ''}
          ${escapeHtml(cat.name)}
        </span>` : ''}
        <span class="${overdue ? 'text-red-400 font-medium' : ''}">${humanDelta(now, link.dueAt)}</span>
        ${link.snoozedCount > 0 ? `<span>· snoozed ${link.snoozedCount}×</span>` : ''}
      </div>
    </div>
    <div class="flex gap-1 shrink-0">
      <button data-action="done" title="Mark done"
              class="px-2 py-1 text-xs bg-green-700 hover:bg-green-600 rounded">✓</button>
      <details class="relative">
        <summary class="list-none cursor-pointer px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded">
          Snooze
        </summary>
        <div class="absolute right-0 top-full mt-1 z-10 bg-slate-800 p-1 rounded shadow-lg flex flex-col min-w-[8rem]">
          <button data-action="snooze" data-preset="8h"
                  class="text-xs px-2 py-1 hover:bg-slate-700 rounded text-left">+ 8 hours</button>
          <button data-action="snooze" data-preset="24h"
                  class="text-xs px-2 py-1 hover:bg-slate-700 rounded text-left">+ 24 hours</button>
          <button data-action="snooze" data-preset="1w"
                  class="text-xs px-2 py-1 hover:bg-slate-700 rounded text-left">+ 1 week</button>
        </div>
      </details>
      <button data-action="delete" title="Delete"
              class="px-2 py-1 text-xs bg-red-900 hover:bg-red-800 rounded">✕</button>
    </div>
  </div>
</li>`;
  }

  function renderDoneRow(link) {
    return `
<li data-id="${link.id}" class="bg-slate-900 rounded-xl p-3 flex items-center justify-between gap-3">
  <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener"
     class="text-slate-400 line-through hover:text-slate-200 break-all flex-1">${escapeHtml(displayTitle(link))}</a>
  <div class="flex gap-1 shrink-0">
    <button data-action="reopen" title="Move back to inbox"
            class="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded">↺ Reopen</button>
    <button data-action="delete" class="text-xs px-2 py-1 text-slate-500 hover:text-red-400">Delete</button>
  </div>
</li>`;
  }

  function visibleLinks() {
    const inDone = route.view === 'done';
    return state.links.filter((l) =>
      (inDone ? l.doneAt != null : l.doneAt == null) &&
      (!route.cat || l.categoryId === route.cat));
  }

  function renderListsHtml() {
    const now = Date.now();
    if (route.view === 'done') {
      const done = visibleLinks().sort((a, b) => b.doneAt - a.doneAt).slice(0, 200);
      if (!done.length) return '<p class="text-slate-500">Nothing done yet.</p>';
      return `<ul class="space-y-2">${done.map(renderDoneRow).join('')}</ul>`;
    }
    const open = visibleLinks().sort((a, b) => a.dueAt - b.dueAt);
    const dueNow = open.filter((l) => l.dueAt <= now);
    const upcoming = open.filter((l) => l.dueAt > now);
    let html = '';
    if (dueNow.length) {
      html += `
<section class="mb-6">
  <h2 class="text-sm font-semibold text-red-400 uppercase tracking-wide mb-2">Due now</h2>
  <ul class="space-y-2">${dueNow.map((l) => renderLinkRow(l, now)).join('')}</ul>
</section>`;
    }
    if (upcoming.length) {
      html += `
<section class="mb-6">
  <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-2">Upcoming</h2>
  <ul class="space-y-2">${upcoming.map((l) => renderLinkRow(l, now)).join('')}</ul>
</section>`;
    }
    return html || '<p class="text-slate-500 text-center py-12">Nothing saved yet. Paste a link above.</p>';
  }

  function updateNav() {
    const set = (el, active) => {
      el.classList.toggle('text-white', active);
      el.classList.toggle('text-slate-400', !active);
      el.classList.toggle('hover:text-white', !active);
    };
    set(document.getElementById('nav-inbox'), route.view === 'inbox');
    set(document.getElementById('nav-done'), route.view === 'done');
  }

  // The add form lives inside #app, so every render would wipe a half-typed
  // link (e.g. when creating a category mid-add). Capture its values before
  // replacing the markup and restore them after — except right after a
  // successful save, where the form must start fresh.
  function toggleInlineCat(show) {
    document.getElementById('new-cat-inline').classList.toggle('hidden', !show);
    document.getElementById('inline-cat-name').disabled = !show;
    document.getElementById('inline-cat-color').disabled = !show;
  }

  function captureAddForm() {
    if (!document.getElementById('add-form')) return null;
    const val = (id) => document.getElementById(id).value;
    return {
      url: val('url-input'), note: val('note-input'),
      cat: val('category-select'), remind: val('remind-select'),
      custom: val('custom-due'),
      newCatName: val('inline-cat-name'), newCatColor: val('inline-cat-color'),
    };
  }

  function restoreAddForm(v) {
    if (!document.getElementById('add-form')) return;
    const set = (id, value) => { document.getElementById(id).value = value; };
    set('url-input', v.url);
    set('note-input', v.note);
    const sel = document.getElementById('category-select');
    sel.value = v.cat; // a since-deleted category falls back to no selection
    if (sel.selectedIndex === -1) sel.value = '';
    set('remind-select', v.remind);
    set('custom-due', v.custom);
    document.getElementById('custom-due').classList.toggle('hidden', v.remind !== 'custom');
    set('inline-cat-name', v.newCatName);
    set('inline-cat-color', v.newCatColor);
    toggleInlineCat(sel.value === '__new__');
  }

  function render() {
    route = parseHash();
    updateNav();
    const live = captureAddForm();
    if (live) savedAddForm = live;
    if (pendingFormReset) {
      savedAddForm = null;
      pendingFormReset = false;
    }
    const app = document.getElementById('app');
    app.innerHTML = route.view === 'done'
      ? `
<h1 class="text-xl font-semibold mb-4">Done</h1>
${renderCategoryFilter()}
<div id="lists">${renderListsHtml()}</div>`
      : `
<section class="mb-6">${renderAddForm()}</section>
${renderCategoryFilter()}
<div id="lists">${renderListsHtml()}</div>`;
    if (route.view === 'inbox' && savedAddForm) restoreAddForm(savedAddForm);
    if (!bootFocusDone && route.view === 'inbox') {
      bootFocusDone = true;
      const u = document.getElementById('url-input');
      if (u) u.focus();
    }
    updateTitleAndBadge();
  }

  // Minute-tick refresh: only the lists (never the add form), only when
  // visible on the inbox, and never while a snooze popover is open.
  function maybeRenderLists() {
    if (document.visibilityState !== 'visible' || route.view !== 'inbox') return;
    const lists = document.getElementById('lists');
    if (!lists || lists.querySelector('details[open]')) return;
    lists.innerHTML = renderListsHtml();
  }

  // ---------- actions ----------

  async function mutate(fn) {
    state = await wlDB.update((s) => { fn(s); return s; });
    applyFilterDropRule();
    render();
    checkReminders();
  }

  // Port of v1 smart_redirect: keep the category filter across mutations,
  // drop it only when the current view's filtered list just became empty.
  function applyFilterDropRule() {
    if (!route.cat) return;
    const inDone = route.view === 'done';
    const remaining = state.links.filter((l) =>
      l.categoryId === route.cat &&
      (inDone ? l.doneAt != null : l.doneAt == null)).length;
    if (remaining === 0) {
      history.replaceState(null, '', location.pathname + location.search + buildHash(route.view, null));
      route = parseHash();
    }
  }

  function resolveRemindIn(value, customStr) {
    const now = Date.now();
    if (value === 'custom') {
      // datetime-local strings parse as local time; empty/invalid falls
      // back to +24h like v1.
      const t = customStr && customStr.trim() ? new Date(customStr.trim()).getTime() : NaN;
      return Number.isNaN(t) ? now + PRESET_MS['24h'] : t;
    }
    return now + (PRESET_MS[value] || PRESET_MS['24h']);
  }

  async function addLink(form) {
    const url = form.querySelector('#url-input').value.trim();
    if (!url) return;
    try {
      new URL(url);
    } catch (_) {
      form.querySelector('#url-error').classList.remove('hidden');
      return;
    }
    let categoryId = form.querySelector('#category-select').value || null;
    let newCat = null;
    if (categoryId === '__new__') {
      const name = form.querySelector('#inline-cat-name').value.trim();
      if (!name) { // native `required` covers this; guard for novalidate paths
        form.querySelector('#inline-cat-name').focus();
        return;
      }
      newCat = {
        id: crypto.randomUUID(),
        name,
        color: form.querySelector('#inline-cat-color').value || null,
      };
      categoryId = newCat.id;
    }
    const link = {
      id: crypto.randomUUID(),
      url,
      title: null,
      note: form.querySelector('#note-input').value.trim() || null,
      categoryId,
      createdAt: Date.now(),
      dueAt: resolveRemindIn(
        form.querySelector('#remind-select').value,
        form.querySelector('#custom-due').value
      ),
      doneAt: null,
      snoozedCount: 0,
      notifiedDueAt: null,
    };
    pendingFormReset = true;
    await mutate((s) => {
      if (newCat) {
        const dup = s.categories.find((c) => c.name === newCat.name);
        if (dup) link.categoryId = dup.id; // dup name: reuse, like the popover
        else s.categories.push(newCat);
      }
      s.links.push(link);
    });
    maybeRequestPersist(false);
    enrichTitle(link.id, url);
  }

  const markDone = (id) => mutate((s) => {
    const l = findLink(s, id);
    if (l && l.doneAt == null) l.doneAt = Date.now();
  });

  const reopenLink = (id) => mutate((s) => {
    const l = findLink(s, id);
    if (l) l.doneAt = null; // dueAt and notifiedDueAt untouched, like v1
  });

  const snoozeLink = (id, preset) => mutate((s) => {
    const l = findLink(s, id);
    if (l) {
      l.dueAt = resolveRemindIn(preset, null); // from now, not from dueAt
      l.snoozedCount += 1;
    }
  });

  const deleteLink = (id) => mutate((s) => {
    s.links = s.links.filter((l) => l.id !== id);
  });

  async function createCategory(form) {
    const name = form.querySelector('#new-cat-name').value.trim();
    if (!name) return;
    const color = form.querySelector('#new-cat-color').value || null;
    await mutate((s) => {
      if (s.categories.some((c) => c.name === name)) return; // dup: silent no-op
      s.categories.push({ id: crypto.randomUUID(), name, color });
    });
  }

  function pasteFromClipboard() {
    navigator.clipboard.readText().then((t) => {
      const u = document.getElementById('url-input');
      if (u) {
        u.value = t.trim();
        u.focus();
      }
    }).catch(() => alert('Clipboard read blocked. Allow clipboard permission or paste manually.'));
  }

  // ---------- reminders ----------

  function updateTitleAndBadge() {
    const now = Date.now();
    const n = state.links.filter((l) => l.doneAt == null && l.dueAt <= now).length;
    document.title = n ? '(' + n + ') WatchLater' : 'WatchLater';
    if ('setAppBadge' in navigator) {
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
    }
  }

  // Claim-then-notify; claims happen only with permission granted so
  // reminders aren't consumed invisibly (v1: no reminder_log rows while
  // push was unconfigured). See sw.js for the transaction rationale.
  async function checkReminders() {
    updateTitleAndBadge();
    if (swRegFailed) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    let claimed = [];
    state = await wlDB.update((s) => {
      claimed = [];
      for (const l of s.links) {
        if (l.doneAt == null && l.dueAt <= now && l.notifiedDueAt !== l.dueAt) {
          l.notifiedDueAt = l.dueAt;
          claimed.push({ id: l.id, url: l.url, title: l.title });
        }
      }
      return s;
    });
    if (!claimed.length) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (claimed.length > 3) {
        await reg.showNotification('WatchLater', {
          body: claimed.length + ' links are due',
          tag: 'wl-due-summary',
          icon: './icon-192.png',
          badge: './icon-192.png',
          data: { url: './' },
        });
      } else {
        for (const c of claimed) {
          await reg.showNotification('WatchLater reminder', {
            body: c.title && c.title.trim() ? c.title : c.url,
            tag: 'wl-due-' + c.id,
            icon: './icon-192.png',
            badge: './icon-192.png',
            data: { url: c.url },
          });
        }
      }
    } catch (_) { /* best-effort; the Due now section always shows the item */ }
  }

  function initNotifyButton() {
    const btn = document.getElementById('enable-notifications');
    if (!('Notification' in window) || swRegFailed) return; // stays hidden
    btn.classList.remove('hidden');
    const refresh = () => {
      const p = Notification.permission;
      btn.textContent = p === 'granted' ? 'Notifications on'
        : p === 'denied' ? 'Notifications blocked'
        : 'Enable notifications';
      btn.disabled = p === 'denied';
      btn.title = p === 'denied' ? 'Re-enable in browser site settings' : '';
    };
    refresh();
    btn.addEventListener('click', async () => {
      if (Notification.permission !== 'default') return;
      await Notification.requestPermission(); // must stay inside the gesture
      refresh();
      if (Notification.permission === 'granted') {
        maybeRequestPersist(true);
        registerPeriodicSync();
        checkReminders();
      }
    });
  }

  async function maybeRequestPersist(force) {
    if (!navigator.storage || !navigator.storage.persist) return;
    if (!force && state.settings.persistRequested) return;
    state = await wlDB.update((s) => {
      s.settings.persistRequested = true;
      return s;
    });
    navigator.storage.persist().catch(() => {});
  }

  async function registerPeriodicSync() {
    if (swRegFailed) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!('periodicSync' in reg)) return;
      const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (st.state !== 'granted') return; // auto-granted only for installed apps
      await reg.periodicSync.register('wl-check-due', { minInterval: 12 * 60 * 60 * 1000 });
    } catch (_) { /* unsupported */ }
  }

  // ---------- title enrichment (best-effort, one attempt at add-time) ----------

  async function enrichTitle(linkId, url) {
    let title = null;
    try {
      const resp = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(url), {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.error || typeof data.title !== 'string') return;
      title = cleanTitle(url, data.title);
    } catch (_) {
      return;
    }
    if (!title) return;
    state = await wlDB.update((s) => {
      const l = findLink(s, linkId);
      if (l && (!l.title || !l.title.trim())) l.title = title; // never overwrite
      return s;
    });
    maybeRenderLists(); // lists only — a full render would wipe form input
  }

  // Port of v1 enrich.rs clean_title + truncate.
  function cleanTitle(url, raw) {
    let t = raw;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
    if (host === 'youtu.be' || host.endsWith('youtube.com')) {
      if (t.toLowerCase().endsWith(' - youtube')) t = t.slice(0, -' - youtube'.length);
    } else if (host.endsWith('reddit.com')) {
      const i = t.lastIndexOf(' : r/');
      if (i >= 0) {
        t = t.slice(0, i);
      } else {
        const j = t.toLowerCase().lastIndexOf(' - reddit');
        if (j >= 0) t = t.slice(0, j);
      }
    }
    t = t.trim();
    if (t.length > 300) t = t.slice(0, 300).trimEnd() + '…';
    return t;
  }

  // ---------- share target ----------

  function handleShareTarget() {
    const params = new URLSearchParams(location.search);
    if (!params.has('url') && !params.has('text') && !params.has('title')) return;
    const urlParam = (params.get('url') || '').trim();
    let candidate = null;
    try {
      new URL(urlParam);
      candidate = urlParam;
    } catch (_) {}
    if (!candidate) {
      const m = (params.get('text') || '').match(/https?:\/\/\S+/);
      if (m) candidate = m[0];
    }
    if (!candidate) candidate = (params.get('title') || '').trim() || null;
    if (candidate) {
      const u = document.getElementById('url-input');
      if (u) {
        u.value = candidate;
        u.focus();
      }
    }
    history.replaceState(null, '', './' + location.hash);
  }

  // ---------- export / import ----------

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'watchlater-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Whole-document replace. Returns a normalized state or null if the
  // file isn't a usable backup.
  function normalizeImported(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    if (typeof obj.schemaVersion !== 'number' || obj.schemaVersion > SCHEMA_VERSION) return null;
    if (!Array.isArray(obj.categories) || !Array.isArray(obj.links)) return null;
    const categories = [];
    for (const c of obj.categories) {
      if (typeof c !== 'object' || c === null || typeof c.name !== 'string') return null;
      categories.push({
        ...c,
        id: typeof c.id === 'string' ? c.id : crypto.randomUUID(),
        color: typeof c.color === 'string' ? c.color : null,
      });
    }
    const links = [];
    for (const l of obj.links) {
      if (typeof l !== 'object' || l === null) return null;
      if (typeof l.url !== 'string' || typeof l.dueAt !== 'number') return null;
      links.push({
        ...l,
        id: typeof l.id === 'string' ? l.id : crypto.randomUUID(),
        title: typeof l.title === 'string' ? l.title : null,
        note: typeof l.note === 'string' ? l.note : null,
        categoryId: typeof l.categoryId === 'string' ? l.categoryId : null,
        createdAt: typeof l.createdAt === 'number' ? l.createdAt : Date.now(),
        doneAt: typeof l.doneAt === 'number' ? l.doneAt : null,
        snoozedCount: typeof l.snoozedCount === 'number' ? l.snoozedCount : 0,
        notifiedDueAt: typeof l.notifiedDueAt === 'number' ? l.notifiedDueAt : null,
      });
    }
    const settings =
      typeof obj.settings === 'object' && obj.settings !== null && !Array.isArray(obj.settings)
        ? obj.settings
        : {};
    return { ...obj, schemaVersion: SCHEMA_VERSION, categories, links, settings };
  }

  async function importData(file) {
    let obj;
    try {
      obj = JSON.parse(await file.text());
    } catch (_) {
      alert('Import failed: not valid JSON.');
      return;
    }
    const next = normalizeImported(obj);
    if (!next) {
      alert('Import failed: not a WatchLater backup (or from a newer version).');
      return;
    }
    const ok = confirm(
      'Replace current data (' + state.links.length + ' links) with backup (' +
      next.links.length + ' links)? Current data will be overwritten.'
    );
    if (!ok) return;
    state = await wlDB.set(next);
    applyFilterDropRule();
    render();
    checkReminders();
  }

  // ---------- update toast + version display ----------

  function showUpdateToast() {
    if (document.getElementById('update-toast')) return;
    const div = document.createElement('div');
    div.id = 'update-toast';
    div.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-30 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm flex items-center gap-3 shadow-lg';
    const span = document.createElement('span');
    span.textContent = 'Updated — reload for the new version';
    const b = document.createElement('button');
    b.className = 'text-blue-400 hover:text-blue-300 font-medium';
    b.textContent = 'Reload';
    b.addEventListener('click', () => location.reload());
    div.append(span, b);
    document.body.appendChild(div);
  }

  function initServiceWorkerUx() {
    if (swRegFailed) return;
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdateToast();
      hadController = true;
      askVersion();
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'version') {
        document.getElementById('app-version').textContent = e.data.version;
      }
    });
    const askVersion = () => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'version' });
      }
    };
    askVersion();
  }

  // ---------- event wiring ----------

  function wireEvents() {
    const app = document.getElementById('app');

    app.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'paste') {
        pasteFromClipboard();
        return;
      }
      const li = btn.closest('li[data-id]');
      if (!li) return;
      const id = li.dataset.id;
      if (action === 'done') markDone(id);
      else if (action === 'reopen') reopenLink(id);
      else if (action === 'snooze') snoozeLink(id, btn.dataset.preset);
      else if (action === 'delete') deleteLink(id);
    });

    app.addEventListener('submit', (e) => {
      if (e.target.id === 'add-form') {
        e.preventDefault();
        addLink(e.target);
      } else if (e.target.id === 'new-cat-form') {
        e.preventDefault();
        createCategory(e.target);
      }
    });

    app.addEventListener('change', (e) => {
      if (e.target.id === 'remind-select') {
        document.getElementById('custom-due').classList.toggle('hidden', e.target.value !== 'custom');
      } else if (e.target.id === 'category-select') {
        const isNew = e.target.value === '__new__';
        toggleInlineCat(isNew);
        if (isNew) document.getElementById('inline-cat-name').focus();
      } else if (e.target.id === 'category-filter') {
        location.hash = buildHash(route.view, e.target.value || null);
      }
    });

    app.addEventListener('input', (e) => {
      if (e.target.id === 'url-input') {
        document.getElementById('url-error').classList.add('hidden');
      }
    });

    document.getElementById('export-btn').addEventListener('click', exportData);
    document.getElementById('import-btn').addEventListener('click', () => {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importData(f);
    });
  }

  // ---------- boot ----------

  (async function boot() {
    if (!swRegFailed) {
      // updateViaCache:'none' is load-bearing: GitHub Pages serves
      // max-age=600, and update checks must always hit the network.
      navigator.serviceWorker
        .register('./sw.js', { scope: './', updateViaCache: 'none' })
        .catch(() => { swRegFailed = true; });
    }

    state = await wlDB.update((s) => s ?? makeSeedState());
    // schemaVersion migrations slot in here when SCHEMA_VERSION grows.

    wireEvents();
    window.addEventListener('hashchange', render);
    render();
    handleShareTarget();
    initNotifyButton();
    initServiceWorkerUx();
    registerPeriodicSync();
    checkReminders();

    setInterval(() => {
      checkReminders();
      maybeRenderLists();
    }, 60 * 1000);

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      if (!swRegFailed) {
        navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      }
      // Pick up writes made while hidden (SW periodicsync, another tab).
      try { state = (await wlDB.get()) || state; } catch (_) {}
      checkReminders();
      maybeRenderLists();
    });
  })();
})();
