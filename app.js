/* =========================================================
   Vinted clone — app logic
   - listings metadata in localStorage
   - photos in IndexedDB (as resized JPEG blobs)
   - views / favourites generated deterministically from each
     listing's seed + age, so they grow over time and never jump
   ========================================================= */
(() => {
  "use strict";

  const LS_KEY = "vinted.listings.v1";
  const USERNAME = "dbendit";
  const DAY = 86400000;

  // ---------- tiny helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const money = (n) => "£" + Number(n).toFixed(2);
  const plural = (n, s) => n + " " + s + (n === 1 ? "" : "s");

  // ---------- deterministic stats ----------
  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function statsFor(listing, now = Date.now()) {
    const r = mulberry32(hash32(listing.seed));
    const vMax = 20 + r() * 150;          // long-run ceiling of views
    const tau = 8 + r() * 30;             // days to reach ~63% of ceiling
    const burst = 1 + Math.floor(r() * 6);// quick views in the first hours
    const favRate = 0.04 + r() * 0.24;    // favourites as a share of views
    const end = listing.sold && listing.soldAt ? Math.min(listing.soldAt, now) : now;
    const days = Math.max(0, (end - listing.createdAt) / DAY);
    const base = vMax * (1 - Math.exp(-days / tau));
    const early = burst * (1 - Math.exp(-(days * 24) / 8));
    let bumpV = 0, bumpF = 0;
    const whole = Math.floor(days);
    for (let k = 0; k <= whole; k++) {
      const hv = hash32(listing.seed + ":v:" + k);
      const hf = hash32(listing.seed + ":f:" + k);
      if (hv % 3 === 0) bumpV += 1;
      if (hf % 9 === 0) bumpF += 1;
    }
    const views = Math.floor(base + early + bumpV);
    const favourites = Math.min(views, Math.floor(views * favRate + bumpF));
    return { views, favourites };
  }

  // ---------- storage ----------
  function loadListings() {
    try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
  }
  let saveListings = function () {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.listings)); } catch (e) { toast("Couldn't save: storage full"); }
  };

  const photoDB = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const req = indexedDB.open("vinted-clone", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("photos");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then((db) => new Promise((res, rej) => {
        const t = db.transaction("photos", mode);
        const store = t.objectStore("photos");
        const req = fn(store);
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      }));
    }
    return {
      put: (key, blob) => tx("readwrite", (s) => s.put(blob, key)),
      get: (key) => open().then((db) => new Promise((res, rej) => { const r = db.transaction("photos").objectStore("photos").get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); })),
      del: (key) => tx("readwrite", (s) => s.delete(key)),
    };
  })();

  const photoURLs = new Map();
  async function photoURL(id) {
    if (photoURLs.has(id)) return photoURLs.get(id);
    const blob = await photoDB.get(id).catch(() => null);
    const url = blob ? URL.createObjectURL(blob) : null;
    photoURLs.set(id, url);
    return url;
  }
  function dropPhotoURL(id) {
    const u = photoURLs.get(id);
    if (u) URL.revokeObjectURL(u);
    photoURLs.delete(id);
  }

  // Resize to a sane size before storing (iOS converts HEIC to JPEG for file inputs).
  function resizeImage(file, max = 1200) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;
    });
  }

  // ---------- state ----------
  const state = {
    listings: loadListings(),
    filter: null,          // null | "active" | "sold"
    tab: "profile",
    listingsOpen: false,
    editing: null,         // listing id when editing
    pendingPhoto: null,    // Blob chosen in the form
    sheetFor: null,
  };

  // ---------- rendering ----------
  const grid = $("#grid");
  const countEl = $("#items-count");

  function visibleListings() {
    const all = state.listings.slice().sort((a, b) => b.createdAt - a.createdAt);
    if (state.filter === "active") return all.filter((l) => !l.sold);
    if (state.filter === "sold") return all.filter((l) => l.sold);
    return all.filter((l) => !l.sold).concat(all.filter((l) => l.sold));
  }

  function renderListings() {
    const items = visibleListings();
    countEl.textContent = plural(items.length, "item");
    $$(".chip").forEach((c) => c.classList.toggle("active", c.dataset.filter === state.filter));

    grid.innerHTML = "";
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = state.listings.length ? "No items here" : "Tap Sell to add your first listing";
      grid.appendChild(e);
      return;
    }
    const now = Date.now();
    for (const l of items) {
      const s = statsFor(l, now);
      const el = document.createElement("a");
      el.className = "item" + (l.sold ? " sold" : "");
      el.dataset.id = l.id;
      el.innerHTML =
        '<div class="item-img"><img alt="" decoding="async"></div>' +
        '<div class="item-meta">' +
          '<div class="item-price"></div>' +
          '<div class="item-stat views"></div>' +
          '<div class="item-stat favs"></div>' +
        "</div>" +
        '<button type="button" class="bump">Bump</button>';
      $(".item-price", el).textContent = money(l.price);
      $(".views", el).textContent = plural(s.views, "view");
      $(".favs", el).textContent = plural(s.favourites, "favourite");
      grid.appendChild(el);
      photoURL(l.id).then((u) => { if (u) $("img", el).src = u; });
    }
  }

  function refreshStats() {
    const now = Date.now();
    for (const el of $$(".item", grid)) {
      const l = state.listings.find((x) => x.id === el.dataset.id);
      if (!l) continue;
      const s = statsFor(l, now);
      $(".views", el).textContent = plural(s.views, "view");
      $(".favs", el).textContent = plural(s.favourites, "favourite");
    }
  }

  // ---------- navigation ----------
  const screens = {
    profile: $("#screen-profile"), home: $("#screen-home"), browse: $("#screen-browse"), inbox: $("#screen-inbox"),
  };
  const listingsScreen = $("#screen-listings");
  const detailScreen = $("#screen-detail");
  const formScreen = $("#screen-form");

  function showTab(tab) {
    if (tab === "sell") { openForm(null); return; }
    state.tab = tab;
    Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== tab; });
    $$(".tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    if (state.detailOpen) popDetail(true);
    if (state.listingsOpen) popListings(true);
  }

  function pushScreen(screen, under) {
    screen.hidden = false;
    screen.style.transform = "";
    void screen.offsetWidth;
    screen.classList.add("in");
    under.classList.add("pushed-under");
  }
  function popScreen(screen, under, instant) {
    if (instant) screen.classList.add("no-anim");
    screen.classList.remove("in");
    screen.style.transform = "";
    under.classList.remove("pushed-under");
    under.style.transform = "";
    const done = () => { screen.hidden = true; screen.classList.remove("no-anim"); };
    if (instant) done(); else setTimeout(done, 380);
  }

  function pushListings() {
    if (state.listingsOpen) return;
    state.listingsOpen = true;
    renderListings();
    $("#listings-scroll").scrollTop = 0;
    pushScreen(listingsScreen, screens[state.tab]);
  }
  function popListings(instant) {
    if (!state.listingsOpen) return;
    state.listingsOpen = false;
    popScreen(listingsScreen, screens[state.tab], instant);
  }

  // ---------- listing detail ----------
  const buyerFee = (p) => p * 1.05 + 0.70; // UK buyer protection: 5% + £0.70
  function renderDetail() {
    const l = state.listings.find((x) => x.id === state.detailId);
    if (!l) return;
    $("#d-title").textContent = l.title;
    $("#d-price").textContent = money(l.price);
    $("#d-fee").textContent = money(buyerFee(l.price));
    $("#d-sold").hidden = !l.sold;
    // Description always opens with the item name, then whatever was typed.
    const extra = (l.description || "").trim();
    $("#d-desc-wrap").hidden = false;
    $("#d-desc").textContent = l.title + (extra ? "\n" + extra : "");
    const img = $("#d-photo");
    img.removeAttribute("src");
    photoURL(l.id).then((u) => { if (state.detailId === l.id && u) img.src = u; });
  }
  function openDetail(listing) {
    state.detailId = listing.id;
    renderDetail();
    $(".detail-scroll").scrollTop = 0;
    if (state.detailOpen) return;
    state.detailOpen = true;
    pushScreen(detailScreen, listingsScreen);
  }
  function popDetail(instant) {
    if (!state.detailOpen) return;
    state.detailOpen = false;
    popScreen(detailScreen, listingsScreen, instant);
  }

  // iOS-style edge swipe to go back
  function attachSwipe(screen, getUnder, pop, isOpen) {
    let startX = 0, startY = 0, dx = 0, tracking = false, t0 = 0;
    screen.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (t.clientX > 28 || !isOpen()) return;
      tracking = true; startX = t.clientX; startY = t.clientY; dx = 0; t0 = Date.now();
      screen.classList.add("no-anim"); getUnder().classList.add("no-anim");
    }, { passive: true });
    screen.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      dx = Math.max(0, t.clientX - startX);
      if (Math.abs(t.clientY - startY) > 40 && dx < 10) { tracking = false; return; }
      screen.style.transform = "translateX(" + dx + "px)";
      getUnder().style.transform = "translateX(" + (-30 + 30 * dx / window.innerWidth) + "%)";
    }, { passive: true });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      const fast = dx / Math.max(1, Date.now() - t0) > 0.35;
      screen.classList.remove("no-anim"); getUnder().classList.remove("no-anim");
      if (dx > window.innerWidth * 0.35 || (fast && dx > 30)) pop(false);
      else { screen.style.transform = ""; getUnder().style.transform = ""; }
    };
    screen.addEventListener("touchend", end);
    screen.addEventListener("touchcancel", end);
  }
  attachSwipe(listingsScreen, () => screens[state.tab], popListings, () => state.listingsOpen && !state.detailOpen);
  attachSwipe(detailScreen, () => listingsScreen, popDetail, () => state.detailOpen);

  // ---------- form ----------
  const form = $("#listing-form");
  const fTitle = $("#f-title"), fPrice = $("#f-price"), fSold = $("#f-sold"), fDesc = $("#f-desc");
  const photoInput = $("#photo-input"), photoPick = $("#photo-pick"), photoPreview = $("#photo-preview"), photoLabel = $("#photo-pick-label");
  const formError = $("#form-error");
  const qtyField = $("#qty-field"), qtyEl = $("#f-qty"), multiPrices = $("#multi-prices");
  let qty = 1;

  function renderCopyPrices() {
    qtyEl.textContent = qty;
    $$(".step", qtyField).forEach((b) => { b.disabled = (b.dataset.step === "-1" && qty <= 1) || (b.dataset.step === "1" && qty >= 20); });
    const existing = $$("input", multiPrices).map((i) => i.value);
    multiPrices.innerHTML = "";
    if (qty < 2) { fPrice.closest(".field").hidden = false; return; }
    fPrice.closest(".field").hidden = true;
    for (let i = 0; i < qty; i++) {
      const row = document.createElement("label");
      row.className = "field copy-price";
      row.innerHTML = '<span class="field-label">Price ' + (i + 1) + '</span><span class="price-wrap"><span class="currency">£</span><input type="text" inputmode="decimal" placeholder="0.00"></span>';
      $("input", row).value = existing[i] != null ? existing[i] : fPrice.value;
      $("input", row).id = "f-price-" + (i + 1);
      multiPrices.appendChild(row);
    }
  }
  qtyField.addEventListener("click", (e) => {
    const b = e.target.closest(".step");
    if (!b) return;
    qty = Math.min(20, Math.max(1, qty + Number(b.dataset.step)));
    renderCopyPrices();
  });

  function setPreview(url) {
    if (url) { photoPreview.src = url; photoPreview.hidden = false; photoLabel.hidden = true; photoPick.classList.add("has-photo"); }
    else { photoPreview.removeAttribute("src"); photoPreview.hidden = true; photoLabel.hidden = false; photoPick.classList.remove("has-photo"); }
  }

  function openForm(listing) {
    state.editing = listing ? listing.id : null;
    state.pendingPhoto = null;
    formError.hidden = true;
    $("#form-title").textContent = listing ? "Edit listing" : "New listing";
    $("#form-submit").textContent = listing ? "Save" : "Upload";
    fTitle.value = listing ? listing.title : "";
    fDesc.value = listing ? (listing.description || "") : "";
    fPrice.value = listing ? Number(listing.price).toFixed(2) : "";
    fSold.checked = listing ? !!listing.sold : false;
    photoInput.value = "";
    qty = 1; qtyField.hidden = !!listing; renderCopyPrices();
    setPreview(null);
    if (listing) photoURL(listing.id).then((u) => { if (state.editing === listing.id && !state.pendingPhoto) setPreview(u); });
    formScreen.hidden = false;
    void formScreen.offsetWidth;
    formScreen.classList.add("in");
  }
  function closeForm() {
    formScreen.classList.remove("in");
    setTimeout(() => { formScreen.hidden = true; }, 420);
    document.activeElement && document.activeElement.blur();
  }

  photoPick.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    try {
      const blob = await resizeImage(file);
      state.pendingPhoto = blob;
      setPreview(URL.createObjectURL(blob));
    } catch { formError.textContent = "That photo couldn't be read."; formError.hidden = false; }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const parse = (v) => parseFloat(String(v).replace(/[^0-9.]/g, ""));
    const prices = (!state.editing && qty > 1) ? $$("input", multiPrices).map((i) => parse(i.value)) : [parse(fPrice.value)];
    const bad = prices.findIndex((p) => !(p > 0));
    if (bad !== -1) {
      formError.textContent = prices.length > 1 ? "Enter a price for copy " + (bad + 1) + "." : "Enter a price.";
      formError.hidden = false;
      (prices.length > 1 ? $$("input", multiPrices)[bad] : fPrice).focus();
      return;
    }
    const price = prices[0];
    formError.hidden = true;
    const title = fTitle.value.trim() || "Listing";
    const description = fDesc.value.trim();
    const sold = fSold.checked;
    const now = Date.now();
    let listing;
    if (state.editing) {
      listing = state.listings.find((l) => l.id === state.editing);
      if (!listing) return;
      listing.title = title; listing.price = price; listing.description = description;
      if (sold && !listing.sold) { listing.sold = true; listing.soldAt = now; }
      if (!sold && listing.sold) { listing.sold = false; listing.soldAt = null; }
    } else {
      const created = [];
      for (const p of prices) {
        const seed = uid() + created.length;
        const r = mulberry32(hash32(seed + ":age"));
        // A listing added as already sold is backdated so it carries realistic views.
        const createdAt = sold ? now - Math.round((7 + r() * 38) * DAY) : now - created.length;
        created.push({ id: seed, seed, title, description, price: p, createdAt, sold, soldAt: sold ? now : null });
      }
      state.listings.push(...created);
      listing = created[0];
      if (state.pendingPhoto) {
        for (const l of created) {
          await photoDB.put(l.id, state.pendingPhoto).catch(() => toast("Photo couldn't be saved"));
          dropPhotoURL(l.id);
        }
      }
    }
    if (state.editing && state.pendingPhoto) {
      await photoDB.put(listing.id, state.pendingPhoto).catch(() => toast("Photo couldn't be saved"));
      dropPhotoURL(listing.id);
    }
    saveListings();
    closeForm();
    if (!state.listingsOpen) { showTab("profile"); pushListings(); } else renderListings();
    if (state.detailOpen) renderDetail();
  });

  // ---------- action sheet (generic) ----------
  const sheet = $("#sheet");
  const sheetRows = $("#sheet-rows");
  let sheetItems = [];
  function showSheet(title, items) {
    sheetItems = items;
    $("#sheet-title").textContent = title || "";
    $("#sheet-title").hidden = !title;
    sheetRows.innerHTML = "";
    items.concat([{ label: "Cancel", cls: "cancel" }]).forEach((it, i) => {
      const b = document.createElement("button");
      b.className = "sheet-row" + (it.cls ? " " + it.cls : "");
      b.textContent = it.label;
      b.dataset.i = i;
      sheetRows.appendChild(b);
    });
    sheet.hidden = false;
    void sheet.offsetWidth;
    sheet.classList.add("in");
  }
  function closeSheet() {
    sheet.classList.remove("in");
    setTimeout(() => { sheet.hidden = true; }, 300);
  }
  sheet.addEventListener("click", (e) => {
    const btn = e.target.closest(".sheet-row");
    if (!btn) { if (e.target === sheet) closeSheet(); return; }
    const it = sheetItems[Number(btn.dataset.i)];
    if (!it) { closeSheet(); return; }
    if (it.confirm && !btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.textContent = it.confirm;
      return;
    }
    closeSheet();
    if (it.onTap) it.onTap();
  });

  function openListingSheet(listing) {
    showSheet(listing.title + " · " + money(listing.price), [
      { label: listing.sold ? "Mark as active" : "Mark as sold", onTap: () => {
        listing.sold = !listing.sold;
        listing.soldAt = listing.sold ? Date.now() : null;
        saveListings(); renderListings(); if (state.detailOpen) renderDetail();
      } },
      { label: "Edit listing", onTap: () => openForm(listing) },
      { label: "Delete listing", cls: "danger", confirm: "Tap again to delete", onTap: () => {
        state.listings = state.listings.filter((l) => l.id !== listing.id);
        photoDB.del(listing.id).catch(() => {});
        dropPhotoURL(listing.id);
        saveListings(); renderListings();
        if (state.detailOpen) popDetail(false);
      } },
    ]);
  }

  // ---------- balance ----------
  const BAL_KEY = "vinted.balance.v1";
  function loadBalance() { const v = parseFloat(localStorage.getItem(BAL_KEY)); return isFinite(v) ? v : 0; }
  function renderBalance() { $$("[data-bind=balance]").forEach((el) => { el.textContent = money(loadBalance()); }); }
  const balanceSheet = $("#balance-sheet");
  const balanceInput = $("#balance-input");
  function openBalanceSheet() {
    const v = loadBalance();
    balanceInput.value = v ? v.toFixed(2) : "";
    balanceSheet.hidden = false;
    void balanceSheet.offsetWidth;
    balanceSheet.classList.add("in");
    setTimeout(() => { balanceInput.focus(); balanceInput.select(); }, 320);
  }
  function closeBalanceSheet() {
    balanceInput.blur();
    balanceSheet.classList.remove("in");
    setTimeout(() => { balanceSheet.hidden = true; }, 300);
  }
  function saveBalance() {
    const raw = balanceInput.value.trim().replace(/[£,\s]/g, "");
    const v = raw === "" ? 0 : parseFloat(raw);
    if (!isFinite(v) || v < 0) { toast("Enter a valid amount"); return; }
    try { localStorage.setItem(BAL_KEY, String(Math.round(v * 100) / 100)); } catch (e) { toast("Couldn't save balance"); }
    renderBalance();
    closeBalanceSheet();
  }
  $("#balance-form").addEventListener("submit", (e) => { e.preventDefault(); saveBalance(); });
  balanceSheet.addEventListener("click", (e) => { if (e.target === balanceSheet) closeBalanceSheet(); });

  function openUserMenu() {
    const items = [{ label: "Add a listing", onTap: () => openForm(null) }];
    if (!state.listingsOpen) items.push({ label: "View my listings", onTap: pushListings });
    showSheet(USERNAME, items);
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const act = e.target.closest("[data-action]");
    if (act) {
      e.preventDefault();
      const a = act.dataset.action;
      if (a === "open-listings") pushListings();
      else if (a === "user-menu") openUserMenu();
      else if (a === "edit-balance") openBalanceSheet();
      else if (a === "balance-save") saveBalance();
      else if (a === "balance-cancel") closeBalanceSheet();
      else if (a === "back") popListings(false);
      else if (a === "detail-back") popDetail(false);
      else if (a === "detail-menu") { const l = state.listings.find((x) => x.id === state.detailId); if (l) openListingSheet(l); }
      else if (a === "share") toast("Share isn't available in this clone");
      else if (a === "form-cancel") closeForm();
      return;
    }
    const tab = e.target.closest(".tabbar .tab");
    if (tab) { showTab(tab.dataset.tab); return; }

    const seg = e.target.closest(".segtab");
    if (seg) {
      $$(".segtab").forEach((s) => s.classList.toggle("active", s === seg));
      $$(".seg-pane").forEach((p) => { p.hidden = p.dataset.pane !== seg.dataset.seg; });
      return;
    }
    const chip = e.target.closest(".chip");
    if (chip) { state.filter = state.filter === chip.dataset.filter ? null : chip.dataset.filter; renderListings(); return; }

    const bump = e.target.closest(".bump");
    if (bump) { toast("Bump isn't available in this clone"); return; }

    const item = e.target.closest(".item");
    if (item) { const l = state.listings.find((x) => x.id === item.dataset.id); if (l) openDetail(l); }
  });

  // ---------- init ----------
  $$("[data-bind=username]").forEach((el) => { el.textContent = USERNAME; });
  renderBalance();
  const params = new URLSearchParams(location.search);
  if (params.has("sim")) {
    // Simulate iPhone safe areas when previewing in a desktop browser.
    document.documentElement.style.setProperty("--safe-top", (params.get("top") || "0") + "px");
    document.documentElement.style.setProperty("--safe-bottom", (params.get("bottom") || "34") + "px");
  }
  const demoMode = params.has("demo") || location.hash === "#demo" || !!window.VINTED_PREVIEW;
  if (demoMode) {
    // Demo data for previews (not persisted). Photos come from reference/demo.
    const d = Date.now();
    const mk = (id, title, price, days, sold, src) => ({ id, seed: id, title, description: "Cared for when worn 💕", price, createdAt: d - days * DAY, sold, soldAt: sold ? d - 1 * DAY : null, demoSrc: src });
    state.listings = [
      mk("orange-hoodie", "Corteiz Alcatraz Hoodie ‘Rust’", 27.5, 1, false, "reference/demo/orange-hoodie.jpg"),
      mk("grey-hoodie", "Broken Planet ‘Trust Your Universe’ Hoodie", 35, 1.2, false, "reference/demo/grey-hoodie.jpg"),
      mk("chucky-tee", "Chucky Graphic Tee", 25, 2, false, "reference/demo/chucky-tee.jpg"),
      mk("mirage-hoodie", "Broken Planet ‘Stuck in Mirage’ Hoodie", 40, 2.5, false, "reference/demo/mirage-hoodie.jpg"),
      mk("pink-hoodie", "Corteiz Alcatraz Hoodie ‘Pink’", 22.5, 30, true, "reference/demo/pink-hoodie.jpg"),
      mk("shorts", "Palm Print Swim Shorts", 37.5, 25, true, "reference/demo/shorts.jpg"),
    ];
    saveListings = () => {};
    state.listings.forEach((l) => photoURLs.set(l.id, l.demoSrc));
  }
  showTab(params.get("tab") || "profile");
  renderListings();
  if (params.get("filter")) state.filter = params.get("filter");
  if (location.hash === "#listings") { listingsScreen.classList.add("no-anim"); pushListings(); setTimeout(() => listingsScreen.classList.remove("no-anim"), 50); }
  setInterval(() => { if (state.listingsOpen) refreshStats(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.listingsOpen) refreshStats(); });

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
