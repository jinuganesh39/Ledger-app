/* ==========================================================================
   LEDGER — finance, invoicing & cash-flow tracker backed by Google Sheets
   ==========================================================================
   SETUP REQUIRED — see README.md.
   You must supply your own Google Cloud OAuth Client ID below before this
   app can sign anyone in. Nothing here will work with the placeholder.
   ========================================================================== */

const CONFIG = {
  CLIENT_ID: "733849404197-qhmm284bqi2l4f700h6evctj67maj6lv.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets openid email profile",
  SHEET_FILE_NAME: "Ledger Data (do not rename)",
};

const SHEETS = {
  Settings:     { headers: ["key","value"] },
  Products:     { headers: ["id","name","description","rate","hsn","gstRate"] },
  Transactions: { headers: ["id","type","category","amount","date","notes","party","source","invoiceId"] },
  Invoices:     { headers: ["id","docType","invoiceNo","date","clientName","clientAddress","clientGSTIN","clientState","itemsJSON","subtotal","discount","cgst","sgst","igst","total","totalWords"] },
};

const SETTINGS_KEYS = ["businessName","address","contact","state","gstin","bankAccountName","bankAccountNumber","bankName","ifsc","branch","terms"];

let state = {
  accessToken: null,
  tokenClient: null,
  user: null,
  spreadsheetId: null,
  sheetIds: {},          // { Settings: 0, Products: 123, ... } numeric gid per tab
  settings: {},
  products: [],
  transactions: [],
  invoices: [],
  currentView: "dashboard",
  invoiceDraft: null,
};

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

/* ---------------------------------------------------------------------- */
/* Toast                                                                   */
/* ---------------------------------------------------------------------- */
function toast(msg, tone="ink") {
  const colors = { ink:"bg-ink-900", rust:"bg-rust-600", moss:"bg-moss-600" };
  const el = document.createElement("div");
  el.className = `toast ${colors[tone]||colors.ink} text-white text-sm px-4 py-2.5 rounded-lg shadow-lg`;
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ---------------------------------------------------------------------- */
/* Google Auth (GIS token client, implicit flow — no server needed)       */
/* ---------------------------------------------------------------------- */
function initAuth() {
  if (CONFIG.CLIENT_ID.startsWith("YOUR_CLIENT_ID")) {
    $("#config-warning").classList.remove("hidden");
    $("#config-warning").innerHTML =
      "<strong>Setup needed:</strong> this copy of Ledger has no Google OAuth Client ID configured yet. " +
      "Open <code class='font-mono'>app.js</code> and set <code class='font-mono'>CONFIG.CLIENT_ID</code> " +
      "to a Client ID from your Google Cloud Console (see README.md for the exact steps).";
    $("#btn-signin").disabled = true;
    $("#btn-signin").classList.add("opacity-50","cursor-not-allowed");
    return;
  }
  let silentAttempt = true;
state.tokenClient = google.accounts.oauth2.initTokenClient({
  client_id: CONFIG.CLIENT_ID,
  scope: CONFIG.SCOPES,
  callback: async (resp) => {
    const wasSilent = silentAttempt;
    silentAttempt = false;
    if (resp.error) {
      if (!wasSilent) toast("Sign-in failed: " + resp.error, "rust");
      return;
    }
    state.accessToken = resp.access_token;
    await afterSignIn();
  },
});
state.tokenClient.requestAccessToken({ prompt: "" });
  $("#btn-signin").addEventListener("click", () => state.tokenClient.requestAccessToken({ prompt: "consent" }));
  $("#btn-signout").addEventListener("click", signOut);
}

function signOut() {
  if (state.accessToken) google.accounts.oauth2.revoke(state.accessToken, () => {});
  state = { ...state, accessToken:null, spreadsheetId:null, settings:{}, products:[], transactions:[], invoices:[] };
  $("#app").classList.add("hidden");
  $("#onboarding-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}

async function afterSignIn() {
  try {
    const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: authHeaders() }).then(r=>r.json());
    state.user = profile;
    $("#user-chip").innerHTML = `<img src="${profile.picture}" class="w-7 h-7 rounded-full" referrerpolicy="no-referrer"><span>${profile.name||profile.email}</span>`;

    setSyncStatus("syncing", "Locating your data…");
    const existing = await findExistingSpreadsheet();
    if (existing) {
      state.spreadsheetId = existing;
      await loadAllData();
      $("#login-screen").classList.add("hidden");
      showApp();
    } else {
      $("#login-screen").classList.add("hidden");
      $("#onboarding-screen").classList.remove("hidden");
    }
  } catch (err) {
    console.error(err);
    toast("Could not complete sign-in. See console for details.", "rust");
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${state.accessToken}` };
}

/* ---------------------------------------------------------------------- */
/* Drive: find (or later, create) the app's spreadsheet                   */
/* Uses drive.file scope — only ever sees files this app itself created.  */
/* ---------------------------------------------------------------------- */
async function findExistingSpreadsheet() {
  const q = encodeURIComponent(`name='${CONFIG.SHEET_FILE_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, { headers: authHeaders() });
  const data = await res.json();
  if (data.files && data.files.length) return data.files[0].id;
  return null;
}

async function createSpreadsheet() {
  const body = {
    properties: { title: CONFIG.SHEET_FILE_NAME },
    sheets: Object.keys(SHEETS).map(title => ({ properties: { title } })),
  };
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  state.spreadsheetId = data.spreadsheetId;
  data.sheets.forEach(s => state.sheetIds[s.properties.title] = s.properties.sheetId);

  // write header rows
  const requests = Object.entries(SHEETS).map(([title, cfg]) => ({
    range: `${title}!A1`,
    values: [cfg.headers],
  }));
  await sheetsValuesBatchUpdate(requests);
  return data.spreadsheetId;
}

/* ---------------------------------------------------------------------- */
/* Sheets REST helpers                                                    */
/* ---------------------------------------------------------------------- */
async function sheetsValuesBatchGet(ranges) {
  const q = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values:batchGet?${q}`;
  const res = await fetch(url, { headers: authHeaders() });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.valueRanges.map(vr => vr.values || []);
}

async function sheetsValuesBatchUpdate(items) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: items }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function sheetsAppend(sheetName, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values/${sheetName}!A:A:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

function setSyncStatus(kind, text) {
  const dot = $("#sync-indicator span:first-child");
  $("#sync-text").textContent = text;
  if (dot) dot.className = "w-1.5 h-1.5 rounded-full " + (kind==="syncing" ? "bg-brass-500 animate-pulse" : kind==="error" ? "bg-rust-600" : "bg-moss-500");
}

async function withSync(label, fn) {
  setSyncStatus("syncing", label);
  try {
    const r = await fn();
    setSyncStatus("ok", "Synced to Drive");
    return r;
  } catch (err) {
    console.error(err);
    setSyncStatus("error", "Sync failed — retry");
    toast("Couldn't save to Google Sheets. Check your connection and try again.", "rust");
    throw err;
  }
}

/* ---------------------------------------------------------------------- */
/* Load all data from the spreadsheet into memory                         */
/* ---------------------------------------------------------------------- */
async function loadAllData() {
  const [settingsRows, productRows, txRows, invRows] = await sheetsValuesBatchGet([
    "Settings!A2:B", "Products!A2:F", "Transactions!A2:I", "Invoices!A2:P"
  ]);

  state.settings = {};
  settingsRows.forEach(([k,v]) => { if (k) state.settings[k] = v || ""; });

  state.products = productRows
    .map((r,i) => ({ row:i+2, id:r[0], name:r[1], description:r[2]||"", rate:parseFloat(r[3])||0, hsn:r[4]||"", gstRate:parseFloat(r[5])||0 }))
    .filter(p => p.id);

  state.transactions = txRows
    .map((r,i) => ({ row:i+2, id:r[0], type:r[1], category:r[2], amount:parseFloat(r[3])||0, date:r[4], notes:r[5]||"", party:r[6]||"", source:r[7]||"manual", invoiceId:r[8]||"" }))
    .filter(t => t.id);

  state.invoices = invRows
    .map((r,i) => ({ row:i+2, id:r[0], docType:r[1], invoiceNo:r[2], date:r[3], clientName:r[4], clientAddress:r[5], clientGSTIN:r[6], clientState:r[7], items:JSON.parse(r[8]||"[]"), subtotal:parseFloat(r[9])||0, discount:parseFloat(r[10])||0, cgst:parseFloat(r[11])||0, sgst:parseFloat(r[12])||0, igst:parseFloat(r[13])||0, total:parseFloat(r[14])||0, totalWords:r[15]||"" }))
    .filter(i => i.id);

  // recover sheetIds (gids) for delete operations, if we didn't just create the file
  if (!Object.keys(state.sheetIds).length) {
    const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}?fields=sheets.properties`, { headers: authHeaders() }).then(r=>r.json());
    meta.sheets.forEach(s => state.sheetIds[s.properties.title] = s.properties.sheetId);
  }
}

/* ---------------------------------------------------------------------- */
/* Onboarding                                                              */
/* ---------------------------------------------------------------------- */
$("#form-onboarding").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const values = {};
  SETTINGS_KEYS.forEach(k => values[k] = (fd.get(k)||"").toString().trim());

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = "Creating your spreadsheet…";
  try {
    await createSpreadsheet();
    await sheetsValuesBatchUpdate([{ range: "Settings!A2", values: SETTINGS_KEYS.map(k => [k, values[k]]) }]);
    state.settings = values;
    await loadAllData();
    toast("Business profile saved.", "moss");
    $("#onboarding-screen").classList.add("hidden");
    showApp();
  } catch (err) {
    console.error(err);
    toast("Setup failed: " + err.message, "rust");
    btn.disabled = false; btn.textContent = "Save & create my Ledger spreadsheet";
  }
});

/* ---------------------------------------------------------------------- */
/* App shell / navigation                                                 */
/* ---------------------------------------------------------------------- */
function showApp() {
  $("#app").classList.remove("hidden");
  navigate("dashboard");
}

$$(".nav-item").forEach(btn => btn.addEventListener("click", () => navigate(btn.dataset.view)));

function navigate(view, opts={}) {
  state.currentView = view;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  const titles = { dashboard:"Dashboard", invoice:"New Invoice", cashflow:"Cash In / Out", history:"History & Export", products:"Catalog", settings:"Business Profile" };
  $("#view-title").textContent = titles[view] || "";
  const root = $("#view-root");
  root.className = "px-8 py-7 max-w-6xl fade-in";
  const renderers = { dashboard: renderDashboard, invoice: renderInvoice, cashflow: renderCashflow, history: renderHistory, products: renderProducts, settings: renderSettings };
  root.innerHTML = "";
  (renderers[view] || renderDashboard)(root);
}

/* ---------------------------------------------------------------------- */
/* Money / formatting helpers                                             */
/* ---------------------------------------------------------------------- */
const fmt = (n) => "₹" + (Number(n)||0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => "₹" + Math.round(Number(n)||0).toLocaleString("en-IN");

function numberToWordsIndian(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return "Zero Rupees Only";
  const ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  function twoDigits(n) { if (n < 20) return ones[n]; return tens[Math.floor(n/10)] + (n%10 ? " " + ones[n%10] : ""); }
  function threeDigits(n) { let s = ""; if (n >= 100) { s += ones[Math.floor(n/100)] + " Hundred"; n %= 100; if (n) s += " "; } if (n) s += twoDigits(n); return s; }
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  const rest = num;
  let parts = [];
  if (crore) parts.push(threeDigits(crore) + " Crore");
  if (lakh) parts.push(threeDigits(lakh) + " Lakh");
  if (thousand) parts.push(threeDigits(thousand) + " Thousand");
  if (rest) parts.push(threeDigits(rest));
  return parts.join(" ") + " Rupees Only";
}

function dateRangeFilter(rangeKey, custom) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (rangeKey === "today") return [startOfDay(now), new Date(now.getTime()+86400000)];
  if (rangeKey === "month") return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth()+1, 1)];
  if (rangeKey === "custom" && custom) return [new Date(custom.from), new Date(new Date(custom.to).getTime()+86400000)];
  return [new Date(0), new Date(8640000000000000)];
}

/* ========================================================================
   VIEW: DASHBOARD
   ======================================================================== */
function renderDashboard(root) {
  const inflow = state.transactions.filter(t=>t.type==="inflow").reduce((s,t)=>s+t.amount,0);
  const outflow = state.transactions.filter(t=>t.type==="outflow").reduce((s,t)=>s+t.amount,0);
  const net = inflow - outflow;
  const recent = [...state.transactions].sort((a,b)=> new Date(b.date)-new Date(a.date)).slice(0,8);

  root.innerHTML = `
    <div class="grid sm:grid-cols-3 gap-4 mb-8">
      <div class="bg-white border border-ink-100 rounded-2xl p-5">
        <span class="field-label">Total cash in</span>
        <div class="font-serif text-3xl font-semibold text-moss-700 mt-1.5">${fmt(inflow)}</div>
      </div>
      <div class="bg-white border border-ink-100 rounded-2xl p-5">
        <span class="field-label">Total cash out</span>
        <div class="font-serif text-3xl font-semibold text-rust-700 mt-1.5">${fmt(outflow)}</div>
      </div>
      <div class="bg-ink-900 rounded-2xl p-5">
        <span class="field-label text-ink-300">Net balance</span>
        <div class="font-serif text-3xl font-semibold text-brass-300 mt-1.5">${fmt(net)}</div>
      </div>
    </div>

    <div class="flex items-center gap-3 mb-5">
      <button data-nav="invoice" class="rounded-lg bg-ink-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-ink-800 transition">+ New Invoice</button>
      <button data-nav="cashflow" class="rounded-lg border border-ink-200 bg-white text-sm font-medium px-4 py-2.5 hover:bg-ink-50 transition">+ Log Cash Entry</button>
    </div>

    <div class="bg-white border border-ink-100 rounded-2xl overflow-hidden">
      <div class="px-5 py-4 border-b border-ink-100 flex items-center justify-between">
        <h3 class="font-semibold text-sm">Recent activity</h3>
        <button data-nav="history" class="text-xs text-ink-500 hover:text-ink-900">View all →</button>
      </div>
      ${recent.length ? `<table class="w-full text-sm">
        <tbody>
        ${recent.map(t => `
          <tr class="border-b border-ink-50 last:border-0">
            <td class="px-5 py-3 text-ink-500 w-28">${t.date}</td>
            <td class="px-5 py-3">${t.party || t.category || "—"}<span class="block text-xs text-ink-400">${t.notes||""}</span></td>
            <td class="px-5 py-3 text-right font-medium ${t.type==='inflow'?'text-moss-700':'text-rust-700'}">${t.type==='inflow'?'+':'−'}${fmt(t.amount)}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<div class="px-5 py-10 text-center text-sm text-ink-400">Nothing logged yet. Create an invoice or add a cash entry to get started.</div>`}
    </div>
  `;
  $$("[data-nav]", root).forEach(b => b.addEventListener("click", () => navigate(b.dataset.nav)));
}

/* ========================================================================
   VIEW: PRODUCTS / CATALOG
   ======================================================================== */
function renderProducts(root) {
  root.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <p class="text-sm text-ink-500 max-w-md">Items you save here appear as quick-fill options when building an invoice.</p>
      <button id="btn-add-product" class="rounded-lg bg-ink-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-ink-800 transition">+ Add item</button>
    </div>
    <div id="product-form-slot"></div>
    <div class="bg-white border border-ink-100 rounded-2xl overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-left field-label border-b border-ink-100">
          <th class="px-5 py-3">Name</th><th class="px-5 py-3">HSN/SAC</th><th class="px-5 py-3 text-right">Rate</th><th class="px-5 py-3 text-right">GST %</th><th class="px-5 py-3"></th>
        </tr></thead>
        <tbody id="product-rows"></tbody>
      </table>
      ${!state.products.length ? `<div class="px-5 py-10 text-center text-sm text-ink-400">No products or services yet.</div>` : ""}
    </div>
  `;
  const rows = $("#product-rows", root);
  state.products.forEach(p => {
    const tr = document.createElement("tr");
    tr.className = "border-b border-ink-50 last:border-0";
    tr.innerHTML = `
      <td class="px-5 py-3"><div class="font-medium">${escapeHtml(p.name)}</div><div class="text-xs text-ink-400">${escapeHtml(p.description)}</div></td>
      <td class="px-5 py-3 text-ink-500">${escapeHtml(p.hsn)}</td>
      <td class="px-5 py-3 text-right">${fmt(p.rate)}</td>
      <td class="px-5 py-3 text-right">${p.gstRate}%</td>
      <td class="px-5 py-3 text-right space-x-2 whitespace-nowrap">
        <button class="text-xs text-ink-500 hover:text-ink-900" data-edit="${p.id}">Edit</button>
        <button class="text-xs text-rust-600 hover:text-rust-700" data-del="${p.id}">Delete</button>
      </td>`;
    rows.appendChild(tr);
  });
  $("#btn-add-product", root).addEventListener("click", () => showProductForm(root));
  $$("[data-edit]", root).forEach(b => b.addEventListener("click", () => showProductForm(root, state.products.find(p=>p.id===b.dataset.edit))));
  $$("[data-del]", root).forEach(b => b.addEventListener("click", () => deleteProduct(b.dataset.del, root)));
}

function showProductForm(root, product=null) {
  const slot = $("#product-form-slot", root);
  slot.innerHTML = `
    <form id="form-product" class="bg-white border border-ink-100 rounded-2xl p-5 mb-5 grid sm:grid-cols-6 gap-3 items-end">
      <div class="sm:col-span-2"><label class="field-label">Name</label><input required name="name" value="${product?escapeHtml(product.name):''}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div class="sm:col-span-2"><label class="field-label">Description</label><input name="description" value="${product?escapeHtml(product.description):''}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div><label class="field-label">HSN/SAC</label><input name="hsn" value="${product?escapeHtml(product.hsn):''}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div><label class="field-label">Rate ₹</label><input required type="number" step="0.01" name="rate" value="${product?product.rate:''}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div><label class="field-label">GST %</label><input required type="number" step="0.01" name="gstRate" value="${product?product.gstRate:0}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div class="sm:col-span-6 flex gap-2 pt-1">
        <button type="submit" class="rounded-lg bg-ink-900 text-white text-sm font-medium px-4 py-2 hover:bg-ink-800">Save item</button>
        <button type="button" id="btn-cancel-product" class="rounded-lg border border-ink-200 text-sm font-medium px-4 py-2">Cancel</button>
      </div>
    </form>`;
  $("#btn-cancel-product", slot).addEventListener("click", () => slot.innerHTML = "");
  $("#form-product", slot).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { name:fd.get("name"), description:fd.get("description")||"", hsn:fd.get("hsn")||"", rate:parseFloat(fd.get("rate"))||0, gstRate:parseFloat(fd.get("gstRate"))||0 };
    try {
      if (product) {
        Object.assign(product, payload);
        await withSync("Saving item…", () => sheetsValuesBatchUpdate([{ range:`Products!A${product.row}:F${product.row}`, values:[[product.id,payload.name,payload.description,payload.rate,payload.hsn,payload.gstRate]] }]));
      } else {
        const id = uid();
        await withSync("Saving item…", () => sheetsAppend("Products", [id,payload.name,payload.description,payload.rate,payload.hsn,payload.gstRate]));
        state.products.push({ row: state.products.length+2, id, ...payload });
      }
      toast("Item saved.", "moss");
      navigate("products");
    } catch {}
  });
}

async function deleteProduct(id, root) {
  const p = state.products.find(x=>x.id===id);
  if (!p || !confirm(`Delete "${p.name}"?`)) return;
  try {
    await withSync("Deleting…", () => sheetsValuesBatchUpdate([{ range:`Products!A${p.row}`, values:[[""]] }]));
    state.products = state.products.filter(x=>x.id!==id);
    toast("Item deleted.", "moss");
    navigate("products");
  } catch {}
}

function escapeHtml(s="") { return s.toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* ========================================================================
   VIEW: SETTINGS / BUSINESS PROFILE
   ======================================================================== */
function renderSettings(root) {
  const s = state.settings;
  root.innerHTML = `
    <form id="form-settings" class="bg-white border border-ink-100 rounded-2xl p-7 space-y-6 max-w-2xl">
      <div>
        <h3 class="text-sm font-semibold text-ink-800 mb-3">Business identity</h3>
        <div class="grid sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2"><label class="field-label">Business / personal name</label><input required name="businessName" value="${escapeHtml(s.businessName)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
          <div class="sm:col-span-2"><label class="field-label">Address</label><textarea required name="address" rows="2" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm">${escapeHtml(s.address)}</textarea></div>
          <div><label class="field-label">Contact</label><input required name="contact" value="${escapeHtml(s.contact)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
          <div><label class="field-label">Home state</label><input required name="state" value="${escapeHtml(s.state)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
          <div class="sm:col-span-2"><label class="field-label">GSTIN</label><input name="gstin" value="${escapeHtml(s.gstin)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm uppercase"></div>
        </div>
      </div>
      <div class="border-t border-ink-100 pt-6">
        <h3 class="text-sm font-semibold text-ink-800 mb-3">Bank account</h3>
        <div class="grid sm:grid-cols-2 gap-4">
          <div><label class="field-label">Account name</label><input required name="bankAccountName" value="${escapeHtml(s.bankAccountName)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
          <div><label class="field-label">Account number</label><input required name="bankAccountNumber" value="${escapeHtml(s.bankAccountNumber)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
          <div><label class="field-label">Bank name</label><input required name="bankName" value="${escapeHtml(s.bankName)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
          <div><label class="field-label">IFSC</label><input required name="ifsc" value="${escapeHtml(s.ifsc)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm uppercase"></div>
          <div><label class="field-label">Branch</label><input required name="branch" value="${escapeHtml(s.branch)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm"></div>
        </div>
      </div>
      <div class="border-t border-ink-100 pt-6">
        <label class="field-label">Default invoice terms</label>
        <textarea name="terms" rows="2" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2.5 text-sm">${escapeHtml(s.terms)}</textarea>
      </div>
      <button type="submit" class="rounded-lg bg-ink-900 text-white px-5 py-2.5 text-sm font-medium hover:bg-ink-800">Save changes</button>
    </form>
  `;
  $("#form-settings", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const values = {};
    SETTINGS_KEYS.forEach(k => values[k] = (fd.get(k)||"").toString().trim());
    try {
      await withSync("Saving profile…", () => sheetsValuesBatchUpdate([{ range:"Settings!A2", values: SETTINGS_KEYS.map(k=>[k, values[k]]) }]));
      state.settings = values;
      toast("Business profile updated.", "moss");
    } catch {}
  });
}

/* ========================================================================
   VIEW: CASH IN / OUT
   ======================================================================== */
function renderCashflow(root) {
  root.innerHTML = `
    <form id="form-cash" class="bg-white border border-ink-100 rounded-2xl p-6 grid sm:grid-cols-6 gap-4 items-end mb-8">
      <div class="sm:col-span-2">
        <label class="field-label">Type</label>
        <div class="mt-1.5 flex rounded-lg border border-ink-200 overflow-hidden text-sm">
          <label class="flex-1 text-center py-2 cursor-pointer has-[:checked]:bg-moss-100 has-[:checked]:text-moss-700 has-[:checked]:font-medium"><input type="radio" name="type" value="inflow" class="hidden" checked>Cash In</label>
          <label class="flex-1 text-center py-2 cursor-pointer border-l border-ink-200 has-[:checked]:bg-rust-100 has-[:checked]:text-rust-700 has-[:checked]:font-medium"><input type="radio" name="type" value="outflow" class="hidden">Cash Out</label>
        </div>
      </div>
      <div><label class="field-label">Amount ₹</label><input required type="number" step="0.01" name="amount" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div><label class="field-label">Date</label><input required type="date" name="date" value="${new Date().toISOString().slice(0,10)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div>
        <label class="field-label">Method</label>
        <select name="category" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm bg-white">
          <option>UPI</option><option>Bank Transfer</option><option>Cash</option><option>Cheque</option><option>Card</option><option>Other</option>
        </select>
      </div>
      <div><label class="field-label">Party name</label><input name="party" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div class="sm:col-span-5"><label class="field-label">Reference / notes</label><input name="notes" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <button type="submit" class="rounded-lg bg-ink-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-ink-800 h-fit">Log entry</button>
    </form>
    <div id="cash-recent"></div>
  `;
  renderRecentCash(root);
  $("#form-cash", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const t = { id: uid(), type: fd.get("type"), category: fd.get("category"), amount: parseFloat(fd.get("amount"))||0, date: fd.get("date"), notes: fd.get("notes")||"", party: fd.get("party")||"", source:"manual", invoiceId:"" };
    try {
      await withSync("Logging entry…", () => sheetsAppend("Transactions", [t.id,t.type,t.category,t.amount,t.date,t.notes,t.party,t.source,t.invoiceId]));
      state.transactions.push({ row: state.transactions.length+2, ...t });
      toast("Entry logged.", "moss");
      e.target.reset();
      $("input[name=date]", e.target).value = new Date().toISOString().slice(0,10);
      renderRecentCash(root);
    } catch {}
  });
}

function renderRecentCash(root) {
  const recent = [...state.transactions].sort((a,b)=> new Date(b.date)-new Date(a.date)).slice(0,10);
  $("#cash-recent", root).innerHTML = `
    <div class="bg-white border border-ink-100 rounded-2xl overflow-hidden">
      <div class="px-5 py-4 border-b border-ink-100"><h3 class="font-semibold text-sm">Latest entries</h3></div>
      ${recent.length ? `<table class="w-full text-sm"><tbody>
        ${recent.map(t => `<tr class="border-b border-ink-50 last:border-0">
          <td class="px-5 py-3 text-ink-500 w-28">${t.date}</td>
          <td class="px-5 py-3">${escapeHtml(t.party||'—')} <span class="text-xs text-ink-400">${escapeHtml(t.category)}</span></td>
          <td class="px-5 py-3 text-ink-400 text-xs">${escapeHtml(t.notes)}</td>
          <td class="px-5 py-3 text-right font-medium ${t.type==='inflow'?'text-moss-700':'text-rust-700'}">${t.type==='inflow'?'+':'−'}${fmt(t.amount)}</td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="px-5 py-10 text-center text-sm text-ink-400">No entries yet.</div>`}
    </div>`;
}

/* ========================================================================
   VIEW: HISTORY & EXPORT
   ======================================================================== */
function renderHistory(root) {
  root.innerHTML = `
    <div class="bg-white border border-ink-100 rounded-2xl p-5 mb-5 flex flex-wrap gap-3 items-end">
      <div><label class="field-label">Type</label>
        <select id="f-type" class="mt-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm bg-white">
          <option value="all">All</option><option value="inflow">Inflow only</option><option value="outflow">Outflow only</option>
        </select>
      </div>
      <div><label class="field-label">Range</label>
        <select id="f-range" class="mt-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm bg-white">
          <option value="all">All time</option><option value="today">Today</option><option value="month">This month</option><option value="custom">Custom</option>
        </select>
      </div>
      <div id="f-custom" class="hidden flex gap-2">
        <div><label class="field-label">From</label><input type="date" id="f-from" class="mt-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
        <div><label class="field-label">To</label><input type="date" id="f-to" class="mt-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      </div>
      <div><label class="field-label">Search</label><input id="f-search" placeholder="Party or notes…" class="mt-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
      <div class="ml-auto flex gap-2">
        <button id="exp-csv" class="rounded-lg border border-ink-200 px-3 py-2 text-sm hover:bg-ink-50">CSV</button>
        <button id="exp-json" class="rounded-lg border border-ink-200 px-3 py-2 text-sm hover:bg-ink-50">JSON</button>
      </div>
    </div>
    <div class="bg-white border border-ink-100 rounded-2xl overflow-hidden">
      <table class="w-full text-sm">
        <thead><tr class="text-left field-label border-b border-ink-100">
          <th class="px-5 py-3">Date</th><th class="px-5 py-3">Type</th><th class="px-5 py-3">Party</th><th class="px-5 py-3">Method</th><th class="px-5 py-3">Notes</th><th class="px-5 py-3 text-right">Amount</th>
        </tr></thead>
        <tbody id="hist-rows"></tbody>
      </table>
      <div id="hist-empty" class="hidden px-5 py-10 text-center text-sm text-ink-400">No transactions match these filters.</div>
    </div>
  `;
  const refresh = () => {
    const type = $("#f-type", root).value;
    const range = $("#f-range", root).value;
    $("#f-custom", root).classList.toggle("hidden", range !== "custom");
    const [from,to] = dateRangeFilter(range, { from:$("#f-from",root).value, to:$("#f-to",root).value });
    const search = $("#f-search", root).value.toLowerCase();
    const filtered = state.transactions.filter(t => {
      if (type !== "all" && t.type !== type) return false;
      const d = new Date(t.date);
      if (!(d >= from && d < to)) return false;
      if (search && !(`${t.party} ${t.notes} ${t.category}`.toLowerCase().includes(search))) return false;
      return true;
    }).sort((a,b)=> new Date(b.date)-new Date(a.date));

    $("#hist-rows", root).innerHTML = filtered.map(t => `
      <tr class="border-b border-ink-50 last:border-0">
        <td class="px-5 py-3 text-ink-500">${t.date}</td>
        <td class="px-5 py-3"><span class="text-xs px-2 py-0.5 rounded-full ${t.type==='inflow'?'bg-moss-100 text-moss-700':'bg-rust-100 text-rust-700'}">${t.type}</span></td>
        <td class="px-5 py-3">${escapeHtml(t.party||'—')}</td>
        <td class="px-5 py-3 text-ink-500">${escapeHtml(t.category||'—')}</td>
        <td class="px-5 py-3 text-ink-400 text-xs">${escapeHtml(t.notes||'')}</td>
        <td class="px-5 py-3 text-right font-medium ${t.type==='inflow'?'text-moss-700':'text-rust-700'}">${t.type==='inflow'?'+':'−'}${fmt(t.amount)}</td>
      </tr>`).join("");
    $("#hist-empty", root).classList.toggle("hidden", filtered.length>0);
    root._filtered = filtered;
  };
  ["f-type","f-range","f-from","f-to"].forEach(id => $("#"+id, root).addEventListener("change", refresh));
  $("#f-search", root).addEventListener("input", refresh);
  $("#exp-csv", root).addEventListener("click", () => exportCSV(root._filtered||[]));
  $("#exp-json", root).addEventListener("click", () => exportJSON(root._filtered||[]));
  refresh();
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function exportCSV(rows) {
  const headers = ["date","type","category","party","amount","notes"];
  const lines = [headers.join(",")].concat(rows.map(t => headers.map(h => `"${(t[h]??'').toString().replace(/"/g,'""')}"`).join(",")));
  downloadBlob(lines.join("\n"), "transactions.csv", "text/csv");
}
function exportJSON(rows) { downloadBlob(JSON.stringify(rows, null, 2), "transactions.json", "application/json"); }

/* ========================================================================
   VIEW: INVOICE GENERATOR
   ======================================================================== */
function blankLineItem() { return { productId:"", name:"", hsn:"", qty:1, rate:0, discount:0, gstRate:0 }; }

function nextInvoiceNo(docType) {
  const prefix = docType === "bos" ? "MBSP" : "MBI";
  const countOfType = state.invoices.filter(i => i.docType === docType).length;
  return `${prefix}${String(countOfType+1).padStart(3,"0")}`;
}
function previewInvoiceNo() { return nextInvoiceNo(state.invoiceDraft.docType); }
function renderInvoice(root) {
  if (!state.invoiceDraft) {
    state.invoiceDraft = {
      docType: "tax", clientName:"", clientAddress:"", clientGSTIN:"", clientState: state.settings.state || "",
      date: new Date().toISOString().slice(0,10), items:[blankLineItem()],
    };
  }
  const d = state.invoiceDraft;

  root.innerHTML = `
    <div class="grid lg:grid-cols-5 gap-6">
      <div class="lg:col-span-2 space-y-5 no-print">
        <div class="bg-white border border-ink-100 rounded-2xl p-5 space-y-4">
          <div>
            <label class="field-label">Document type</label>
            <div class="mt-1.5 flex rounded-lg border border-ink-200 overflow-hidden text-sm">
              <label class="flex-1 text-center py-2 cursor-pointer has-[:checked]:bg-ink-900 has-[:checked]:text-white has-[:checked]:font-medium"><input type="radio" name="docType" value="tax" class="hidden" ${d.docType==='tax'?'checked':''}>Tax Invoice</label>
              <label class="flex-1 text-center py-2 cursor-pointer border-l border-ink-200 has-[:checked]:bg-ink-900 has-[:checked]:text-white has-[:checked]:font-medium"><input type="radio" name="docType" value="bos" class="hidden" ${d.docType==='bos'?'checked':''}>Bill of Supply</label>
            </div>
          </div>
          <div><label class="field-label">Invoice date</label><input type="date" id="inv-date" value="${d.date}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
        </div>

        <div class="bg-white border border-ink-100 rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-semibold">Client details</h3>
          <div><label class="field-label">Customer name</label><input id="c-name" value="${escapeHtml(d.clientName)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
          <div><label class="field-label">Billing address</label><textarea id="c-address" rows="2" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm">${escapeHtml(d.clientAddress)}</textarea></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="field-label">GSTIN (optional)</label><input id="c-gstin" value="${escapeHtml(d.clientGSTIN)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm uppercase"></div>
            <div><label class="field-label">State / POS</label><input id="c-state" value="${escapeHtml(d.clientState)}" class="mt-1.5 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"></div>
          </div>
        </div>

        <div class="bg-white border border-ink-100 rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold">Line items</h3>
            <button id="add-line" class="text-xs font-medium text-ink-600 hover:text-ink-900">+ Add line</button>
          </div>
          <div id="line-items" class="space-y-3"></div>
        </div>

        <button id="save-invoice" class="w-full rounded-lg bg-ink-900 text-white py-3 font-medium hover:bg-ink-800 transition">Save &amp; log as inflow</button>
        <button id="print-invoice" class="w-full rounded-lg border border-ink-200 py-3 font-medium hover:bg-ink-50 transition">Print / Save as PDF</button>
      </div>

      <div class="lg:col-span-3">
        <div id="print-root">
          <div id="invoice-doc" class="bg-white border border-ink-100 rounded-2xl shadow-sm p-9"></div>
        </div>
      </div>
    </div>
  `;

  const linesEl = $("#line-items", root);
  function renderLines() {
    linesEl.innerHTML = d.items.map((it, i) => `
      <div class="border border-ink-100 rounded-lg p-3 space-y-2" data-line="${i}">
        <div class="flex gap-2">
          <select class="ln-product flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-xs bg-white">
            <option value="">Custom item…</option>
            ${state.products.map(p => `<option value="${p.id}" ${it.productId===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join("")}
          </select>
          <button class="ln-remove text-xs text-rust-600 px-2">Remove</button>
        </div>
        <input class="ln-name w-full rounded-lg border border-ink-200 px-2 py-1.5 text-sm" placeholder="Item name" value="${escapeHtml(it.name)}">
        <div class="grid grid-cols-5 gap-1.5">
          <input class="ln-hsn rounded-lg border border-ink-200 px-2 py-1.5 text-xs" placeholder="HSN/SAC" value="${escapeHtml(it.hsn)}">
          <input type="number" step="0.01" class="ln-qty rounded-lg border border-ink-200 px-2 py-1.5 text-xs" placeholder="Qty" value="${it.qty}">
          <input type="number" step="0.01" class="ln-rate rounded-lg border border-ink-200 px-2 py-1.5 text-xs" placeholder="Rate" value="${it.rate}">
          <input type="number" step="0.01" class="ln-disc rounded-lg border border-ink-200 px-2 py-1.5 text-xs" placeholder="Disc ₹" value="${it.discount}">
          <input type="number" step="0.01" class="ln-gst rounded-lg border border-ink-200 px-2 py-1.5 text-xs" placeholder="GST %" value="${it.gstRate}">
        </div>
      </div>`).join("");

    $$(".ln-product", linesEl).forEach((sel,i) => sel.addEventListener("change", () => {
      const p = state.products.find(x=>x.id===sel.value);
      if (p) Object.assign(d.items[i], { productId:p.id, name:p.name, hsn:p.hsn, rate:p.rate, gstRate:p.gstRate });
      else d.items[i].productId = "";
      renderLines(); renderDoc();
    }));
    $$(".ln-remove", linesEl).forEach((b,i) => b.addEventListener("click", () => { d.items.splice(i,1); if(!d.items.length) d.items.push(blankLineItem()); renderLines(); renderDoc(); }));
    [["ln-name","name",false],["ln-hsn","hsn",false],["ln-qty","qty",true],["ln-rate","rate",true],["ln-disc","discount",true],["ln-gst","gstRate",true]].forEach(([cls,key,num]) => {
      $$("."+cls, linesEl).forEach((inp,i) => inp.addEventListener("input", () => { d.items[i][key] = num ? (parseFloat(inp.value)||0) : inp.value; renderDoc(); }));
    });
  }

  $("#add-line", root).addEventListener("click", () => { d.items.push(blankLineItem()); renderLines(); renderDoc(); });
  $$("input[name=docType]", root).forEach(r => r.addEventListener("change", () => { d.docType = r.value; renderDoc(); }));
  $("#inv-date", root).addEventListener("input", (e) => { d.date = e.target.value; renderDoc(); });
  $("#c-name", root).addEventListener("input", (e) => { d.clientName = e.target.value; renderDoc(); });
  $("#c-address", root).addEventListener("input", (e) => { d.clientAddress = e.target.value; renderDoc(); });
  $("#c-gstin", root).addEventListener("input", (e) => { d.clientGSTIN = e.target.value; renderDoc(); });
  $("#c-state", root).addEventListener("input", (e) => { d.clientState = e.target.value; renderDoc(); });
  $("#print-invoice", root).addEventListener("click", () => window.print());
  $("#save-invoice", root).addEventListener("click", () => saveInvoice(root));

  function calc() {
    let subtotal = 0, totalDiscount = 0, cgst = 0, sgst = 0, igst = 0;
    const sameState = (d.clientState||"").trim().toLowerCase() === (state.settings.state||"").trim().toLowerCase();
    const rows = d.items.map(it => {
      const gross = (it.qty||0) * (it.rate||0);
      const net = Math.max(gross - (it.discount||0), 0);
      subtotal += net;
      totalDiscount += (it.discount||0);
      let gstAmt = 0;
      if (d.docType === "tax") {
        gstAmt = net * (it.gstRate||0) / 100;
        if (sameState) { cgst += gstAmt/2; sgst += gstAmt/2; } else { igst += gstAmt; }
      }
      return { ...it, net, gstAmt };
    });
    const total = subtotal + (d.docType==="tax" ? cgst+sgst+igst : 0);
    return { rows, subtotal, totalDiscount, cgst, sgst, igst, total, sameState };
  }

  function renderDoc() {
    const c = calc();
    const s = state.settings;
    $("#invoice-doc", root).innerHTML = `
      <div class="flex items-start justify-between border-b-2 border-ink-900 pb-5 mb-6">
        <div>
          <h2 class="text-2xl font-semibold">${escapeHtml(s.businessName||"Your Business")}</h2>
          <p class="text-sm text-ink-500 mt-1 max-w-xs whitespace-pre-line">${escapeHtml(s.address||"")}</p>
          <p class="text-sm text-ink-500">${escapeHtml(s.contact||"")}</p>
          ${s.gstin ? `<p class="text-sm text-ink-500 mono">GSTIN: ${escapeHtml(s.gstin)}</p>` : ""}
        </div>
        <div class="text-right">
          <div class="inline-block text-xs font-semibold tracking-widest uppercase bg-ink-900 text-brass-200 px-3 py-1 rounded">${d.docType==='tax'?'Tax Invoice':'Bill of Supply'}</div>
          <p class="text-sm text-ink-500 mt-2 mono">No: ${previewInvoiceNo()}</p>
          <p class="text-sm text-ink-500 mt-2">Date: ${d.date}</p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-6 mb-7">
        <div>
          <span class="field-label">Billed to</span>
          <p class="font-medium mt-1">${escapeHtml(d.clientName||"—")}</p>
          <p class="text-sm text-ink-500 whitespace-pre-line">${escapeHtml(d.clientAddress||"")}</p>
          ${d.clientGSTIN ? `<p class="text-sm text-ink-500 mono">GSTIN: ${escapeHtml(d.clientGSTIN)}</p>` : ""}
          <p class="text-sm text-ink-500">State: ${escapeHtml(d.clientState||"—")}</p>
        </div>
      </div>

      <table class="w-full text-sm mb-6">
        <thead><tr class="text-left border-b border-ink-300 text-xs uppercase tracking-wide text-ink-500">
          <th class="py-2">Item</th><th class="py-2">HSN/SAC</th><th class="py-2 text-right">Qty</th><th class="py-2 text-right">Rate</th><th class="py-2 text-right">Disc</th>
          ${d.docType==='tax'?'<th class="py-2 text-right">GST%</th>':''}
          <th class="py-2 text-right">Amount</th>
        </tr></thead>
        <tbody>
          ${c.rows.map(r => `<tr class="border-b border-ink-100">
            <td class="py-2 pr-2">${escapeHtml(r.name||"Untitled item")}</td>
            <td class="py-2 text-ink-500">${escapeHtml(r.hsn)}</td>
            <td class="py-2 text-right">${r.qty}</td>
            <td class="py-2 text-right">${fmtInt(r.rate)}</td>
            <td class="py-2 text-right">${fmtInt(r.discount)}</td>
            ${d.docType==='tax'?`<td class="py-2 text-right">${r.gstRate}%</td>`:''}
            <td class="py-2 text-right font-medium">${fmt(r.net + r.gstAmt)}</td>
          </tr>`).join("")}
        </tbody>
      </table>

      <div class="flex justify-end mb-8">
        <div class="w-64 text-sm space-y-1.5">
          <div class="flex justify-between text-ink-600"><span>Subtotal</span><span>${fmt(c.subtotal)}</span></div>
          ${c.totalDiscount ? `<div class="flex justify-between text-ink-600"><span>Discount</span><span>−${fmt(c.totalDiscount)}</span></div>` : ""}
          ${d.docType==='tax' && c.sameState ? `<div class="flex justify-between text-ink-600"><span>CGST</span><span>${fmt(c.cgst)}</span></div><div class="flex justify-between text-ink-600"><span>SGST</span><span>${fmt(c.sgst)}</span></div>` : ""}
          ${d.docType==='tax' && !c.sameState ? `<div class="flex justify-between text-ink-600"><span>IGST</span><span>${fmt(c.igst)}</span></div>` : ""}
          <div class="flex justify-between font-semibold text-base border-t border-ink-300 pt-2 mt-2"><span>Total</span><span>${fmt(c.total)}</span></div>
        </div>
      </div>

      <p class="text-xs text-ink-500 mb-8"><span class="font-semibold">Amount in words:</span> ${numberToWordsIndian(c.total)}</p>

      <div class="grid grid-cols-2 gap-6 border-t border-ink-200 pt-6">
        <div>
          <span class="field-label">Bank details</span>
          <p class="text-sm text-ink-600 mt-1">${escapeHtml(s.bankAccountName||"")}</p>
          <p class="text-sm text-ink-600 mono">A/C ${escapeHtml(s.bankAccountNumber||"")}</p>
          <p class="text-sm text-ink-600">${escapeHtml(s.bankName||"")}, ${escapeHtml(s.branch||"")}</p>
          <p class="text-sm text-ink-600 mono">IFSC ${escapeHtml(s.ifsc||"")}</p>
        </div>
        <div class="text-right">
          <p class="text-xs text-ink-500 mb-10">${escapeHtml(s.terms||"")}</p>
          <p class="text-sm text-ink-500 border-t border-ink-300 pt-2 inline-block">Authorised Signatory</p>
        </div>
      </div>
    `;
  }

  renderLines();
  renderDoc();
}

async function saveInvoice(root) {
  const d = state.invoiceDraft;
  if (!d.clientName.trim()) { toast("Add a customer name before saving.", "rust"); return; }

  const c = (function() {
    let subtotal=0, disc=0, cgst=0, sgst=0, igst=0;
    const sameState = (d.clientState||"").trim().toLowerCase() === (state.settings.state||"").trim().toLowerCase();
    d.items.forEach(it => {
      const gross = (it.qty||0)*(it.rate||0);
      const net = Math.max(gross-(it.discount||0),0);
      subtotal += net; disc += (it.discount||0);
      if (d.docType==="tax") { const g = net*(it.gstRate||0)/100; if (sameState) { cgst+=g/2; sgst+=g/2; } else { igst+=g; } }
    });
    return { subtotal, disc, cgst, sgst, igst, total: subtotal + cgst+sgst+igst };
  })();

  const invoiceNo = nextInvoiceNo(d.docType);
  const inv = {
    id: uid(), docType: d.docType, invoiceNo, date: d.date,
    clientName: d.clientName, clientAddress: d.clientAddress, clientGSTIN: d.clientGSTIN, clientState: d.clientState,
    items: d.items, subtotal: c.subtotal, discount: c.disc, cgst: c.cgst, sgst: c.sgst, igst: c.igst, total: c.total,
    totalWords: numberToWordsIndian(c.total),
  };

  const btn = $("#save-invoice", root);
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await withSync("Saving invoice…", () => sheetsAppend("Invoices", [inv.id,inv.docType,inv.invoiceNo,inv.date,inv.clientName,inv.clientAddress,inv.clientGSTIN,inv.clientState,JSON.stringify(inv.items),inv.subtotal,inv.discount,inv.cgst,inv.sgst,inv.igst,inv.total,inv.totalWords]));
    state.invoices.push({ row: state.invoices.length+2, ...inv });

    const tx = { id: uid(), type:"inflow", category:"Invoice", amount: inv.total, date: inv.date, notes:`${invoiceNo} — ${d.clientName}`, party: d.clientName, source:"invoice", invoiceId: inv.id };
    await withSync("Logging cash entry…", () => sheetsAppend("Transactions", [tx.id,tx.type,tx.category,tx.amount,tx.date,tx.notes,tx.party,tx.source,tx.invoiceId]));
    state.transactions.push({ row: state.transactions.length+2, ...tx });

    toast(`${invoiceNo} saved and logged as inflow.`, "moss");
    state.invoiceDraft = null;
    navigate("invoice");
  } catch {
    btn.disabled = false; btn.textContent = "Save & log as inflow";
  }
}

/* ---------------------------------------------------------------------- */
function waitForGoogle() { if (window.google && google.accounts && google.accounts.oauth2) { initAuth(); } else { setTimeout(waitForGoogle, 50); } } waitForGoogle();
