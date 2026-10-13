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
  const formScreen = $("#screen-form");

  function showTab(tab) {
    if (tab === "sell") { openForm(null); return; }
    state.tab = tab;
    Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== tab; });
    $$(".tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    if (state.listingsOpen) popListings(true);
  }

  function pushListings() {
    if (state.listingsOpen) return;
    state.listingsOpen = true;
    renderListings();
    $("#listings-scroll").scrollTop = 0;
    listingsScreen.hidden = false;
    listingsScreen.style.transform = "";
    void listingsScreen.offsetWidth;
    listingsScreen.classList.add("in");
    screens[state.tab].classList.add("pushed-under");
  }
  function popListings(instant) {
    if (!state.listingsOpen) return;
    state.listingsOpen = false;
    const under = screens[state.tab];
    if (instant) listingsScreen.classList.add("no-anim");
    listingsScreen.classList.remove("in");
    listingsScreen.style.transform = "";
    under.classList.remove("pushed-under");
    under.style.transform = "";
    const done = () => { listingsScreen.hidden = true; listingsScreen.classList.remove("no-anim"); };
    if (instant) done(); else setTimeout(done, 380);
  }

  // iOS-style edge swipe to go back
  (() => {
    let startX = 0, startY = 0, dx = 0, tracking = false, t0 = 0;
    listingsScreen.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (t.clientX > 28 || !state.listingsOpen) return;
      tracking = true; startX = t.clientX; startY = t.clientY; dx = 0; t0 = Date.now();
      listingsScreen.classList.add("no-anim"); screens[state.tab].classList.add("no-anim");
    }, { passive: true });
    listingsScreen.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      dx = Math.max(0, t.clientX - startX);
      if (Math.abs(t.clientY - startY) > 40 && dx < 10) { tracking = false; return; }
      listingsScreen.style.transform = "translateX(" + dx + "px)";
      screens[state.tab].style.transform = "translateX(" + (-30 + 30 * dx / window.innerWidth) + "%)";
    }, { passive: true });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      const fast = dx / Math.max(1, Date.now() - t0) > 0.35;
      listingsScreen.classList.remove("no-anim"); screens[state.tab].classList.remove("no-anim");
      if (dx > window.innerWidth * 0.35 || (fast && dx > 30)) popListings(false);
      else { listingsScreen.style.transform = ""; screens[state.tab].style.transform = ""; }
    };
    listingsScreen.addEventListener("touchend", end);
    listingsScreen.addEventListener("touchcancel", end);
  })();

  // ---------- form ----------
  const form = $("#listing-form");
  const fTitle = $("#f-title"), fPrice = $("#f-price"), fSold = $("#f-sold");
  const photoInput = $("#photo-input"), photoPick = $("#photo-pick"), photoPreview = $("#photo-preview"), photoLabel = $("#photo-pick-label");
  const formError = $("#form-error");

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
    fPrice.value = listing ? Number(listing.price).toFixed(2) : "";
    fSold.checked = listing ? !!listing.sold : false;
    photoInput.value = "";
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
    const price = parseFloat(String(fPrice.value).replace(/[^0-9.]/g, ""));
    if (!(price > 0)) { formError.textContent = "Enter a price."; formError.hidden = false; fPrice.focus(); return; }
    formError.hidden = true;
    const title = fTitle.value.trim() || "Listing";
    const sold = fSold.checked;
    const now = Date.now();
    let listing;
    if (state.editing) {
      listing = state.listings.find((l) => l.id === state.editing);
      if (!listing) return;
      listing.title = title; listing.price = price;
      if (sold && !listing.sold) { listing.sold = true; listing.soldAt = now; }
      if (!sold && listing.sold) { listing.sold = false; listing.soldAt = null; }
    } else {
      const seed = uid();
      const r = mulberry32(hash32(seed + ":age"));
      // A listing added as already sold is backdated so it carries realistic views.
      const createdAt = sold ? now - Math.round((7 + r() * 38) * DAY) : now;
      listing = { id: seed, seed, title, price, createdAt, sold, soldAt: sold ? now : null };
      state.listings.push(listing);
    }
    if (state.pendingPhoto) {
      await photoDB.put(listing.id, state.pendingPhoto).catch(() => toast("Photo couldn't be saved"));
      dropPhotoURL(listing.id);
    }
    saveListings();
    closeForm();
    if (!state.listingsOpen) { showTab("profile"); pushListings(); } else renderListings();
  });

  // ---------- action sheet ----------
  const sheet = $("#sheet");
  function openSheet(listing) {
    state.sheetFor = listing.id;
    $("#sheet-title").textContent = listing.title + " · " + money(listing.price);
    $("#sheet-toggle").textContent = listing.sold ? "Mark as active" : "Mark as sold";
    sheet.hidden = false;
    void sheet.offsetWidth;
    sheet.classList.add("in");
  }
  function closeSheet() {
    sheet.classList.remove("in");
    setTimeout(() => { sheet.hidden = true; }, 300);
  }
  sheet.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sheet]");
    const listing = state.listings.find((l) => l.id === state.sheetFor);
    if (!btn || e.target === sheet) { closeSheet(); return; }
    const action = btn.dataset.sheet;
    closeSheet();
    if (!listing) return;
    if (action === "toggle-sold") {
      listing.sold = !listing.sold;
      listing.soldAt = listing.sold ? Date.now() : null;
      saveListings(); renderListings();
    } else if (action === "edit") {
      openForm(listing);
    } else if (action === "delete") {
      if (!confirm("Delete this listing?")) return;
      state.listings = state.listings.filter((l) => l.id !== listing.id);
      photoDB.del(listing.id).catch(() => {});
      dropPhotoURL(listing.id);
      saveListings(); renderListings();
    }
  });

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
      else if (a === "back") popListings(false);
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
    if (item) { const l = state.listings.find((x) => x.id === item.dataset.id); if (l) openSheet(l); }
  });

  // ---------- init ----------
  $$("[data-bind=username]").forEach((el) => { el.textContent = USERNAME; });
  const params = new URLSearchParams(location.search);
  if (params.has("sim")) {
    // Simulate iPhone safe areas when previewing in a desktop browser.
    document.documentElement.style.setProperty("--safe-top", (params.get("top") || "0") + "px");
    document.documentElement.style.setProperty("--safe-bottom", (params.get("bottom") || "34") + "px");
  }
  if (params.has("demo")) {
    // Demo data for previews (not persisted). Photos come from reference/demo.
    const d = Date.now();
    const mk = (id, price, days, sold, src) => ({ id, seed: id, title: id, price, createdAt: d - days * DAY, sold, soldAt: sold ? d - 1 * DAY : null, demoSrc: src });
    state.listings = [
      mk("orange-hoodie", 27.5, 1, false, "reference/demo/orange-hoodie.jpg"),
      mk("grey-hoodie", 35, 1.2, false, "reference/demo/grey-hoodie.jpg"),
      mk("chucky-tee", 25, 2, false, "reference/demo/chucky-tee.jpg"),
      mk("mirage-hoodie", 40, 2.5, false, "reference/demo/mirage-hoodie.jpg"),
      mk("pink-hoodie", 22.5, 30, true, "reference/demo/pink-hoodie.jpg"),
      mk("shorts", 37.5, 25, true, "reference/demo/shorts.jpg"),
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
