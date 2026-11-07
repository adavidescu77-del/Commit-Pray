const $ = (id) => document.getElementById(id);

// Dacă browserul nu are chrome.sidePanel (ex: Opera mai vechi fără suport),
// acest panou rulează ca popup clasic. Un popup se închide automat când
// tab-ul activ se schimbă, ceea ce ar întrerupe modul "caută pe web" (care
// deschide tab-uri noi). Așa că în acel caz deschidem tab-urile fără să le
// facem active, ca popup-ul să rămână deschis până la final.
const HAS_SIDE_PANEL = !!chrome.sidePanel;

const PROVIDERS = {
  gemini:    { label: "Google Gemini (gratis)", model: "gemini-2.5-flash", maxChars: 150000, hint: "Cheie gratis: aistudio.google.com → Get API key" },
  groq:      { label: "Groq (gratis)", model: "llama-3.3-70b-versatile", maxChars: 20000, hint: "Cheie gratis: console.groq.com → API Keys. Limită mică pe minut, deci paginile lungi se taie." },
  openai:    { label: "OpenAI (ChatGPT, cu plată)", model: "gpt-5-mini", maxChars: 100000, hint: "Cheie: platform.openai.com/api-keys (necesită credit în cont). Apasă „Încarcă modelele disponibile” ca să alegi un model valid." },
  anthropic: { label: "Anthropic (Claude, cu plată)", model: "claude-sonnet-5-5", maxChars: 80000, hint: "Cheie: console.anthropic.com" },
};

let store = { provider: "gemini", cfg: {}, sources: [], goodPages: 3, maxPages: 12, primaryLang: "ro" };
let suppressDirty = false; // true cât timp completăm câmpurile programatic (nu de la utilizator)

function setStatus(t) { $("status").textContent = t; }

// ---------- Indicator „modificări nesalvate” ----------
function markDirty() {
  if (suppressDirty) return;
  $("dirty").style.display = "inline";
}
function markClean() {
  $("dirty").style.display = "none";
}

// ---------- Setări ----------
function fillSettings() {
  suppressDirty = true;
  const p = $("provider").value;
  const c = store.cfg[p] || {};
  $("key").value = c.key || "";
  renderModelOptions(p, c.model || PROVIDERS[p].model);
  $("hint").textContent = PROVIDERS[p].hint;
  suppressDirty = false;
}

(async () => {
  suppressDirty = true;
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const o = document.createElement("option");
    o.value = id; o.textContent = p.label;
    $("provider").appendChild(o);
  }
  const s = await chrome.storage.local.get(["provider", "cfg", "loc", "goodPages", "maxPages", "primaryLang", "termsUrl", "modelLists"]);
  store.modelLists = s.modelLists || {};
  store.provider = PROVIDERS[s.provider] ? s.provider : "gemini";
  store.cfg = s.cfg || {};
  $("loc").value = s.loc || "";
  store.goodPages = [1, 2, 3, 5, 8].includes(Number(s.goodPages)) ? Number(s.goodPages) : 3;
  $("goodPages").value = String(store.goodPages);
  store.maxPages = [6, 10, 12, 20, 30].includes(Number(s.maxPages)) ? Number(s.maxPages) : 12;
  $("maxPages").value = String(store.maxPages);
  store.primaryLang = ["ro", "en"].includes(s.primaryLang) ? s.primaryLang : "ro";
  $("primaryLang").value = store.primaryLang;
  $("termsUrl").value = s.termsUrl || "";
  refreshTerms(false);
  $("provider").value = store.provider;
  fillSettings();
  updateSummary();
  if (!store.cfg[store.provider]?.key) openView("ai");
  markClean();
  suppressDirty = false;
})();

// Schimbarea furnizorului doar reîncarcă valorile salvate ale acelui furnizor,
// nu reprezintă o modificare nesalvată în sine.
$("provider").onchange = fillSettings;

async function refreshTerms(force) {
  $("termsInfo").textContent = "Se încarcă baza de termeni...";
  try {
    await loadTerms(force);
    $("termsInfo").textContent = termsMeta;
  } catch (e) {
    $("termsInfo").textContent = "⚠️ " + e.message;
  }
}

$("primaryLang").onchange = () => {
  store.primaryLang = $("primaryLang").value;
  chrome.storage.local.set({ primaryLang: store.primaryLang });
};

$("termsUrl").onchange = async () => {
  const url = $("termsUrl").value.trim();
  if (url && !/^https:\/\//i.test(url)) { setStatus("URL-ul bazei de termeni trebuie să înceapă cu https://"); return; }
  await chrome.storage.local.set({ termsUrl: url });
  await chrome.storage.local.remove("termsCache");
  refreshTerms(true);
};

$("termsRefresh").onclick = () => refreshTerms(true);

$("goodPages").onchange = () => {
  store.goodPages = Number($("goodPages").value);
  chrome.storage.local.set({ goodPages: store.goodPages });
};

$("maxPages").onchange = () => {
  store.maxPages = Number($("maxPages").value);
  chrome.storage.local.set({ maxPages: store.maxPages });
};

// Orice tastare/schimbare directă de utilizator în câmpurile de setări
// marchează existența unor modificări nesalvate.
$("key").addEventListener("input", markDirty);
$("model").addEventListener("change", markDirty);

$("save").onclick = async () => {
  const p = $("provider").value;
  store.provider = p;
  store.cfg[p] = { key: $("key").value.trim(), model: $("model").value.trim() || PROVIDERS[p].model };
  await chrome.storage.local.set({ provider: store.provider, cfg: store.cfg });
  markClean();
  updateSummary();
  setStatus("Salvat ✔");
};

async function getCfg() {
  const s = await chrome.storage.local.get(["provider", "cfg"]);
  const provider = PROVIDERS[s.provider] ? s.provider : "gemini";
  const c = (s.cfg || {})[provider] || {};
  return { provider, key: c.key, model: c.model || PROVIDERS[provider].model };
}

// ---------- Listă modele disponibile ----------
async function fetchModels(provider, key) {
  let res, data, ids;
  if (provider === "groq") {
    res = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${key}` } });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare (${res.status})`);
    ids = data.data.map((m) => m.id).filter((id) => !/whisper|tts|guard|orpheus|playai|distil-whisper/i.test(id));
  } else if (provider === "openai") {
    res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare (${res.status})`);
    ids = data.data.map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt-)/i.test(id))
      .filter((id) => !/embed|tts|whisper|transcribe|image|audio|realtime|moderation|dall-e|search|instruct|codex/i.test(id));
  } else if (provider === "gemini") {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare (${res.status})`);
    ids = data.models
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((id) => /gemini|gemma/i.test(id));
  } else {
    res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare (${res.status})`);
    ids = data.data.map((m) => m.id);
  }
  return ids.sort();
}

$("loadModels").onclick = async () => {
  const p = $("provider").value;
  const key = $("key").value.trim();
  if (!key) return setStatus("Pune întâi cheia API, apoi încarcă modelele.");
  setStatus("Cer lista de modele...");
  try {
    const ids = await fetchModels(p, key);
    if (!ids.length) return setStatus("Nu am găsit modele pentru cheia asta.");
    store.modelLists = { ...(store.modelLists || {}), [p]: ids };
    await chrome.storage.local.set({ modelLists: store.modelLists });
    renderModelOptions(p, $("model").value);
    setStatus(`${ids.length} modele încărcate. Alege unul și apasă Salvează.`);
  } catch (e) {
    setStatus("Eroare la încărcarea modelelor: " + e.message);
  }
};

// ---------- Dropdown de model (mereu prezent) ----------
const DEFAULT_MODELS = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  openai: ["gpt-5-mini", "gpt-5", "gpt-5-nano"],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
};
function renderModelOptions(p, selected) {
  const ids = new Set([PROVIDERS[p].model, ...(DEFAULT_MODELS[p] || []), ...((store.modelLists || {})[p] || [])]);
  if (selected) ids.add(selected);
  const sel = $("model");
  sel.innerHTML = "";
  [...ids].forEach((id) => { const o = document.createElement("option"); o.value = id; o.textContent = id; sel.appendChild(o); });
  sel.value = selected || PROVIDERS[p].model;
}

// ---------- Rezumat pe ecranul principal ----------
function updateSummary() {
  const p = store.provider;
  $("summary").textContent = `${PROVIDERS[p].label} · ${store.cfg[p]?.model || PROVIDERS[p].model}`;
}

// ---------- Navigare între ecrane ----------
const VIEW_TITLES = { menu: "Setări", ai: "AI și model", search: "Căutare", lang: "Limbă și filtrare" };
function openView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  const main = name === "main";
  if (main) $("topTitle").innerHTML = '<span class="b">Bulls</span><span class="a">-Ai</span>';
  else $("topTitle").textContent = VIEW_TITLES[name];
  $("back").style.display = main ? "none" : "";
  $("openSettings").style.display = main ? "" : "none";
  window.scrollTo(0, 0);
}
$("openSettings").onclick = () => openView("menu");
$("back").onclick = () => openView(document.querySelector('.view.active').dataset.view === "menu" ? "main" : "menu");
$("summary").onclick = () => openView("ai");
document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => openView(b.dataset.goto)));
$("toggleKey").onclick = () => {
  const show = $("key").type === "password";
  $("key").type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "Ascunde" : "Arată";
};

// ---------- Apel generic către AI (întoarce textul brut) ----------
async function fetchRetry(url, init, tries = 3) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await fetch(url, init);
    if (res.status !== 429 || i === tries - 1) return res;
    const wait = 10 * (i + 1);
    setStatus(`Limită de cereri atinsă, reîncerc în ${wait}s...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  return res;
}

// opts.json (implicit true): cere răspuns JSON. opts.maxTokens: lungimea maximă a răspunsului (Claude).
async function callLLM(system, user, opts = {}) {
  const json = opts.json !== false;
  const { provider, key, model } = await getCfg();
  if (!key) { openView("ai"); throw new Error("Pune întâi cheia API în Setări."); }
  let res, data;

  if (provider === "anthropic") {
    res = await fetchRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens || 1500, system, messages: [{ role: "user", content: user }] }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare API (${res.status})`);
    return data.content.map((c) => c.text || "").join("");
  }
  if (provider === "gemini") {
    res = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: json ? { responseMimeType: "application/json", temperature: 0.1 } : { temperature: 0.3 },
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare API (${res.status})`);
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }
  if (provider === "groq") {
    res = await fetchRetry("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Eroare API (${res.status})`);
    return data.choices?.[0]?.message?.content || "";
  }
  // OpenAI: modelele noi (GPT-5, seria o) acceptă doar temperatura implicită, deci n-o trimitem.
  res = await fetchRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Eroare API (${res.status})`);
  return data.choices?.[0]?.message?.content || "";
}

function parseJSON(raw) {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
}

// ---------- Prompturi ----------
const SYSTEM_FIND =
  "Ești un asistent care găsește informații pe o pagină web. Primești textul paginii și o întrebare. " +
  "Răspunde DOAR cu JSON valid, fără alt text, în forma: " +
  '{"answer": "răspuns scurt în limba întrebării", "quotes": ["fragment exact 1", "fragment exact 2"], "safe": true}. ' +
  "Setează safe=false (și quotes: []) dacă pagina conține conținut sexual explicit, pornografic, violență grafică sau gore. " +
  "Regulile pentru quotes: fiecare fragment trebuie copiat IDENTIC, caracter cu caracter, din textul paginii " +
  "(scurt: o propoziție sau mai puțin, maxim 3-4 fragmente), ca să poată fi găsit și subliniat pe pagină. " +
  "Dacă informația NU e pe pagină, pune quotes: [] și spune asta în answer.";

const SYSTEM_RANK =
  "Primești o întrebare și o listă numerotată de rezultate de căutare web (titlu, adresă, fragment). " +
  "Alege cele mai probabile 3 rezultate care conțin răspunsul la întrebare, în ordinea relevanței. " +
  "Preferă surse oficiale sau de încredere și pagini care tratează direct subiectul. " +
  'Răspunde DOAR cu JSON valid: {"order": [2, 0, 5]} (numerele rezultatelor).';

async function askAboutPage(question, page) {
  const { provider } = await getCfg();
  const text = page.text.slice(0, PROVIDERS[provider].maxChars);
  const user = `Pagina: ${page.title} (${page.url})\n\n--- TEXT PAGINĂ ---\n${text}\n--- SFÂRȘIT ---\n\nÎntrebare: ${question}`;
  const raw = await callLLM(SYSTEM_FIND, user);
  return parseJSON(raw) || { answer: raw, quotes: [] };
}

// ---------- Funcții injectate în pagină ----------
function extractPage() {
  return { title: document.title, url: location.href, text: document.body ? document.body.innerText : "" };
}

function highlightInPage(quotes) {
  const NAME = "ai-finder";
  if (!document.getElementById("__ai_finder_style")) {
    const s = document.createElement("style");
    s.id = "__ai_finder_style";
    s.textContent = `::highlight(${NAME}){background-color:#ffe94d;color:#000;text-decoration:underline;text-decoration-color:#e11d48;text-decoration-thickness:2px;}`;
    document.head.appendChild(s);
  }
  if (!CSS.highlights) return { found: 0, error: "Browserul nu suportă CSS Highlight API" };
  CSS.highlights.delete(NAME);
  if (!quotes || !quotes.length) return { found: 0 };

  const clean = (c) => c.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let flat = "";
  const map = [];
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      flat += clean(t[i]).charAt(0) || t[i];
      map.push([n, i]);
    }
  }

  const hl = new Highlight();
  let found = 0, first = null;
  for (const q of quotes) {
    const needle = clean(String(q)).replace(/\s+/g, "");
    if (needle.length < 3) continue;
    let from = 0, idx;
    while ((idx = flat.indexOf(needle, from)) !== -1) {
      const [sn, so] = map[idx];
      const [en, eo] = map[idx + needle.length - 1];
      const r = new Range();
      r.setStart(sn, so);
      r.setEnd(en, eo + 1);
      hl.add(r);
      if (!first) first = r;
      found++;
      from = idx + needle.length;
    }
  }
  CSS.highlights.set(NAME, hl);
  if (first) {
    const el = first.startContainer.parentElement;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return { found };
}

function clearInPage() {
  if (CSS.highlights) for (const k of [...CSS.highlights.keys()]) if (k.startsWith("ai-finder")) CSS.highlights.delete(k);
  document.querySelectorAll("[data-aif]").forEach((e) => { e.removeAttribute("data-aif"); e.style.removeProperty("--aif"); });
  document.getElementById("__ai_finder_style2")?.remove();
  document.getElementById("__ai_finder_panel")?.remove();
}

// ---------- Siguranță conținut: baza de termeni interziși (online + rezervă locală) ----------
// Principii:
//  1. Termenii sunt legați de LIMBĂ. "cum" e interzis în engleză, dar permis în română.
//  2. Limba se identifică întâi (chrome.i18n.detectLanguage + euristică), apoi se aplică lista limbii + lista globală.
//  3. Baza de date = fișier JSON (vezi prohibited_terms.json) încărcat de la un URL din Setări și ținut în cache 24h.
//     Fișierul local prohibited_terms.json din extensie e mereu încărcat ca rezervă. Dacă nicio bază nu poate fi încărcată, căutarea se blochează.
//  4. NICIO pagină nu se deschide într-un tab înainte să fie citită în fundal și verificată.
const WARNING_TEXT = "⚠️ Unul sau mai mulți termeni interziși au fost găsiți în căutarea dumneavoastră.";
const TERMS_TTL = 24 * 60 * 60 * 1000;
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
const STOP = {
  en: new Set(["the", "and", "of", "to", "is", "for", "with", "that", "how", "what", "why", "are", "you", "your", "best", "about", "on", "it", "this", "from", "by", "at", "as", "an", "be", "do", "does", "can", "my", "me", "we", "or", "videos", "video", "free", "online"]),
  ro: new Set(["si", "sa", "cu", "pentru", "este", "care", "sau", "un", "ce", "din", "mai", "nu", "unei", "unui", "despre", "sunt", "vreau", "caut", "unde", "cand", "ale", "cel", "cea", "pe", "la", "de", "spre", "ghid", "agentie", "agentii", "se", "face", "fac", "daca", "dupa", "iar", "dar", "cat", "cate", "poate", "trebuie", "pot", "fost", "lui", "tot", "toate"]),
};
let TERMS = null;
let termsMeta = "";

function norm(s) { return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

function compileTerms(layers) {
  const mk = () => ({ set: new Set(), phrases: new Set(), allow: new Set(), unblock: new Set() });
  const add = (b, arr) => {
    for (const t of arr || []) {
      const n = norm(t).trim().replace(/\s+/g, " ");
      if (n) (n.includes(" ") ? b.phrases : b.set).add(n);
    }
  };
  const langs = {}, g = mk(), domains = new Set(), urlRes = [];
  for (const db of layers) {
    add(g, db.global);
    for (const [code, d] of Object.entries(db.languages || {})) {
      const b = (langs[code] = langs[code] || mk());
      add(b, d.terms); add(b, d.phrases);
      for (const p of d.allowPhrases || []) { const n = norm(p).trim(); if (n) b.allow.add(n); }
    }
    for (const [code, arr] of Object.entries(db.allow || {})) {
      const b = code === "global" ? g : (langs[code] = langs[code] || mk());
      for (const t of arr || []) b.unblock.add(norm(t).trim());
    }
    for (const d of db.domains || []) { const n = norm(d).trim().replace(/^www\./, ""); if (n) domains.add(n); }
    for (const p of db.urlPatterns || []) { try { urlRes.push(new RegExp(p, "i")); } catch { console.warn("Pattern invalid ignorat:", p); } }
  }
  for (const b of [g, ...Object.values(langs)]) {
    for (const t of b.unblock) { b.set.delete(t); b.phrases.delete(t); }
  }
  return { langs, g, domains: [...domains], urlRes };
}

async function loadTerms(force = false) {
  if (TERMS && !force) return TERMS;
  const layers = [];
  let source = "locală";
  try {
    layers.push(await (await fetch(chrome.runtime.getURL("prohibited_terms.json"))).json());
  } catch (e) { console.warn("Baza locală lipsește:", e); }

  const { termsUrl, termsCache } = await chrome.storage.local.get(["termsUrl", "termsCache"]);
  if (termsUrl) {
    let online = null;
    const sameUrl = termsCache && termsCache.url === termsUrl;
    if (sameUrl && !force && Date.now() - termsCache.at < TERMS_TTL) {
      online = termsCache.db; source = "online (cache)";
    } else {
      try {
        const res = await fetch(termsUrl, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const db = await res.json();
        if (!db || typeof db !== "object" || (!db.global && !db.languages)) throw new Error("format invalid");
        await chrome.storage.local.set({ termsCache: { url: termsUrl, at: Date.now(), db } });
        online = db; source = "online (actualizată acum)";
      } catch (e) {
        console.warn("Baza online nu a putut fi încărcată:", e);
        if (sameUrl) { online = termsCache.db; source = "online (cache vechi, sursa nu răspunde)"; }
        else source = "locală (sursa online nu răspunde)";
      }
    }
    if (online) layers.push(online);
  }
  if (!layers.length) throw new Error("Baza de termeni interziși nu a putut fi încărcată, așa că căutarea e blocată din precauție. Verifică fișierul prohibited_terms.json din extensie.");
  TERMS = compileTerms(layers);
  const last = layers[layers.length - 1];
  const count = [TERMS.g, ...Object.values(TERMS.langs)].reduce((n, b) => n + b.set.size + b.phrases.size, 0);
  termsMeta = `Baza de termeni: v${last.version ?? "?"}, ${last.updated ?? "fără dată"} · ${count} termeni · limbi: ${Object.keys(TERMS.langs).join(", ")} · sursă: ${source}`;
  return TERMS;
}

// ----- Identificarea limbii -----
function heuristicLangs(text) {
  const t = norm(text);
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];
  const diacritics = /[ăâîșşțţ]/i.test(String(text));
  for (const [lang, set] of Object.entries(STOP)) {
    const hits = words.filter((w) => set.has(w)).length;
    if (hits > 0 || (lang === "ro" && diacritics)) out.push(lang);
  }
  return out;
}

// Întoarce lista de limbi după care se verifică textul.
// fallback: ce se folosește când limba nu poate fi stabilită (array sau "all").
// prefer: dacă textul pare mixt și conține limba preferată (cea a utilizatorului), se folosește doar ea.
async function detectLangs(text, fallback, prefer = null) {
  if (!TERMS) await loadTerms();
  const all = Object.keys(TERMS.langs);
  const sample = String(text).slice(0, 3000);
  const nWords = sample.split(/\s+/).filter(Boolean).length;
  let cands = null;
  try {
    const r = await chrome.i18n.detectLanguage(sample);
    if (r?.isReliable && nWords >= 2) {
      const l = r.languages.filter((x) => x.percentage >= 25).map((x) => x.language.slice(0, 2).toLowerCase());
      cands = l.filter((x) => TERMS.langs[x]);
      if (!cands.length && l.length) return []; // limbă fără listă proprie: doar lista globală
    }
  } catch { /* detectLanguage indisponibil: folosim euristica */ }
  if (!cands || !cands.length) {
    const h = heuristicLangs(sample).filter((x) => TERMS.langs[x]);
    cands = h.length ? h : null;
  }
  if (!cands) return fallback === "all" ? all : (fallback || []);
  if (prefer && cands.length > 1 && cands.includes(prefer)) return [prefer];
  return cands;
}

// ----- Potrivirea termenilor -----
function countHits(text, langs) {
  const pick = langs === "all" ? Object.values(TERMS.langs) : (langs || []).map((l) => TERMS.langs[l]).filter(Boolean);
  const buckets = [TERMS.g, ...pick];
  let t = norm(text);
  for (const b of buckets) for (const p of b.allow) if (p) t = t.split(p).join(" "); // ex: "cum laude"
  // "p o r n", "p.o.r.n", "p-o-r-n" => "porn"
  t = t.replace(/(?:^|[^\p{L}\p{N}])((?:\p{L}[ .\-_*]){3,}\p{L})(?=$|[^\p{L}\p{N}])/gu, (m, g1) => m.replace(g1, g1.replace(/[ .\-_*]/g, "")));
  const count = (s, minLen) => {
    const tokens = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let hits = 0;
    for (const tok of tokens) {
      if (tok.length < minLen) continue;
      if (buckets.some((b) => b.set.has(tok))) hits++;
    }
    const joined = " " + tokens.join(" ") + " ";
    for (const b of buckets) for (const p of b.phrases) {
      if (minLen > 1 && p.length < minLen) continue;
      hits += joined.split(" " + p + " ").length - 1;
    }
    return hits;
  };
  const raw = count(t, 1);
  const leet = count(t.replace(/[013457@$!]/g, (c) => LEET[c]), 4); // "p0rn", "s3x" etc., doar termeni de min. 4 litere
  return Math.max(raw, leet);
}

function urlLangHint(url) {
  try {
    const u = new URL(url);
    const m = u.hostname.match(/^([a-z]{2})\.(?:m\.)?(wikipedia|wiktionary|wikibooks|wikiquote|wikinews|wikisource)\.org$/);
    const code = m ? m[1] : (u.hostname.endsWith(".ro") ? "ro" : (/\.(uk|us|au|ca|ie|nz)$/.test(u.hostname) ? "en" : null));
    const p = u.pathname.match(/^\/(ro|en)(?:\/|$)/);
    const c = code || (p ? p[1] : null);
    if (!c) return null;
    return TERMS.langs[c] ? [c] : [];
  } catch { return null; }
}

function isUnsafeUrl(url) {
  if (hostMatches(url, TERMS.domains)) return true;
  if (TERMS.urlRes.some((re) => re.test(url))) return true;
  let text = url;
  try { text = decodeURIComponent(url); } catch { /* rămâne URL-ul brut */ }
  const n = norm(text);
  if (countHits(n, []) > 0) return true; // doar lista globală: URL-urile nu au o limbă sigură
  for (const term of TERMS.g.set) if (term.length >= 5 && n.includes(term)) return true; // ex: "pornhub" conține "porn"
  return false;
}

async function isUnsafeResult(r) {
  await loadTerms();
  if (isUnsafeUrl(r.url || "")) return true;
  const text = `${r.title || ""} ${r.snippet || ""}`.trim();
  if (!text) return false;
  const langs = urlLangHint(r.url || "") ?? await detectLangs(text, [store.primaryLang], store.primaryLang);
  return countHits(text, langs) > 0;
}

// Citește o pagină în fundal (fără tab, fără imagini/video/scripturi) și o verifică.
async function fetchPageText(url) {
  await loadTerms();
  if (isUnsafeUrl(url)) throw new Error("sursă blocată");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") || "")) throw new Error("nu e pagină HTML");
    const finalUrl = res.url || url;
    if (isUnsafeUrl(finalUrl)) throw new Error("sursă blocată (redirect)");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const htmlLang = (doc.documentElement.getAttribute("lang") || "").slice(0, 2).toLowerCase();
    const signals = pageSignals(doc);
    doc.querySelectorAll("script,style,noscript,template,svg,iframe,object,embed,img,picture,video,audio,canvas").forEach((e) => e.remove());
    doc.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,tr,br,section,article,td").forEach((e) => e.append("\n"));
    const text = (doc.body?.textContent || "").replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    const title = (doc.title || "").trim();
    const langs = await detectLangs(text, TERMS.langs[htmlLang] ? [htmlLang] : [store.primaryLang], TERMS.langs[htmlLang] ? htmlLang : store.primaryLang);
    if (countHits(title, langs) > 0) throw new Error("conținut nepotrivit (titlu)");
    if (countHits(text.slice(0, 40000), langs) >= 3) throw new Error("conținut nepotrivit");
    return { title, url: finalUrl, text, langs, signals };
  } finally {
    clearTimeout(timer);
  }
}

// Verifică textul unei pagini deja deschise de utilizator (modul „Pagina curentă”).
async function pageTextIsProhibited(title, text) {
  await loadTerms();
  const langs = await detectLangs(text, [store.primaryLang], store.primaryLang);
  return countHits(title || "", langs) > 0 || countHits(String(text).slice(0, 40000), langs) >= 3;
}

// Termenii interziși în căutarea utilizatorului: se identifică limba, apoi se verifică lista ei + lista globală.
async function queryLangs(q) { await loadTerms(); return detectLangs(q, [store.primaryLang], store.primaryLang); }
async function guardQuery(q) {
  const langs = await queryLangs(q);
  if (countHits(q, langs) > 0) { showWarning(); return true; }
  return false;
}

// Ultima barieră: răspunsul AI nu se afișează dacă conține termeni interziși.
async function safeText(text) {
  if (!text) return text;
  await loadTerms();
  const langs = await detectLangs(text, [store.primaryLang], store.primaryLang);
  return countHits(text, langs) > 0 ? "Răspunsul a fost ascuns, deoarece ar conține termeni interziși." : text;
}
async function showAnswerSafe(text, sources) { showAnswer(await safeText(text), sources); }

function showWarning() {
  setStatus("");
  $("links").innerHTML = "";
  $("out").textContent = WARNING_TEXT;
  $("out").classList.add("warn");
  $("out").style.display = "block";
}

// ---------- Căutare web (fără server, prin pagini de rezultate) ----------

// Construiește restricția "site:a.com OR site:b.com" pentru căutarea exclusivă în sursele utilizatorului.
function buildSiteFilter(domains) {
  if (!domains || !domains.length) return "";
  return " (" + domains.map((d) => `site:${d}`).join(" OR ") + ")";
}

async function searchDDG(q, domains) {
  const query = q + buildSiteFilter(domains);
  const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=ro-ro&kp=1");
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const out = [];
  doc.querySelectorAll(".result").forEach((r) => {
    if (r.classList.contains("result--ad")) return;
    const a = r.querySelector("a.result__a");
    if (!a) return;
    let href = a.getAttribute("href") || "";
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/.test(href) || href.includes("duckduckgo.com/y.js")) return;
    out.push({ title: a.textContent.trim(), url: href, snippet: (r.querySelector(".result__snippet")?.textContent || "").trim() });
  });
  return out;
}

async function searchBing(q, domains) {
  const query = q + buildSiteFilter(domains);
  const res = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(query) + "&setlang=ro&adlt=strict");
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const out = [];
  doc.querySelectorAll("li.b_algo").forEach((li) => {
    const a = li.querySelector("h2 a");
    if (!a) return;
    let href = a.getAttribute("href") || "";
    const m = href.match(/[?&]u=a1([^&]+)/);
    if (m) {
      try { href = atob(m[1].replace(/-/g, "+").replace(/_/g, "/")); } catch {}
    }
    if (!/^https?:/.test(href)) return;
    out.push({ title: a.textContent.trim(), url: href, snippet: (li.querySelector(".b_caption p, p")?.textContent || "").trim() });
  });
  return out;
}

// Verifică dacă URL-ul aparține (sau e subdomeniu al) unuia dintre domeniile date.
function hostMatches(url, domains) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return domains.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// strict=true: păstrează DOAR rezultatele din `domains` (filtru făcut în cod, nu doar prin "site:").
// Dacă un motor întoarce rezultate dar niciunul din domeniile cerute, trece la următorul motor.
async function searchWeb(q, domains, { strict = false } = {}) {
  for (const fn of [searchDDG, searchBing]) {
    try {
      let r = await fn(q, domains);
      const flags = await Promise.all(r.map((x) => isUnsafeResult(x)));
      r = r.filter((_, i) => !flags[i]);
      if (strict && domains?.length) r = r.filter((x) => hostMatches(x.url, domains));
      if (r.length) return r.slice(0, 8);
    } catch (e) { console.warn("Căutare eșuată:", fn.name, e); }
  }
  return [];
}

// Caută separat în fiecare sursă (un "site:domeniu" per interogare e mai fiabil decât OR),
// apoi îmbină rezultatele alternând între domenii. Întoarce doar rezultate din sursele date.
async function searchInSources(q, domains) {
  const lists = await Promise.all(
    domains.slice(0, 5).map((d) => searchWeb(q, [d], { strict: true }).then((r) => r.slice(0, 4)).catch(() => []))
  );
  const out = [], seen = new Set();
  for (let i = 0; i < 4; i++) {
    for (const l of lists) {
      const r = l[i];
      if (r && !seen.has(r.url)) { seen.add(r.url); out.push(r); }
    }
  }
  return out;
}

// Mută în fața listei rezultatele din sursele preferate, păstrând ordinea relativă.
function prioritizeResults(results, domains) {
  if (!domains || !domains.length) return results;
  return [
    ...results.filter((r) => hostMatches(r.url, domains)),
    ...results.filter((r) => !hostMatches(r.url, domains)),
  ];
}

// ---------- Tab-uri ----------
function waitForTab(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 1500); // lasă conținutul dinamic să se încarce
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeout);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }).catch(() => {});
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showAnswer(text, sources) {
  $("out").classList.remove("warn", "sum");
  $("out").textContent = text || "(fără răspuns)";
  $("out").style.display = "block";
  const box = $("links");
  box.innerHTML = "";
  (sources || []).forEach((s) => {
    const a = document.createElement("a");
    a.href = s.url; a.target = "_blank"; a.textContent = "↗ " + (s.title || s.url);
    a.style.display = "block"; a.style.marginTop = "4px";
    box.appendChild(a);
  });
}

// Caută conform modului (tot web-ul / surse prioritare / doar surse). opts.quiet: fără mesaje de status.
async function collectResults(q, opts) {
  const { restrictToSources, prioritizeSources, quiet } = opts;
  const domains = store.sources;
  const say = (t) => { if (!quiet) setStatus(t); };
  if (restrictToSources) {
    say("Caut în sursele tale...");
    return await searchInSources(q, domains);
  }
  if (prioritizeSources && domains.length) {
    say("Caut întâi în sursele tale...");
    const fromSources = await searchInSources(q, domains);
    say("Caut și pe web...");
    const general = await searchWeb(q, null);
    const seen = new Set(fromSources.map((r) => r.url));
    return prioritizeResults([...fromSources, ...general.filter((r) => !seen.has(r.url))], domains);
  }
  say("Caut pe web...");
  return await searchWeb(q, null);
}

// ---------- Deep research ----------
// Folosește modul selectat ca „domeniu” al cercetării:
//  - free-search       => tot web-ul
//  - priority-sources  => web, cu sursele tale primele
//  - only-sources      => exclusiv sursele tale
//  - current-page      => doar pagina deschisă, analizată în profunzime
let cancelRequested = false;
let failLog = []; // motivele pentru care paginile au fost omise (afișate utilizatorului)
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

const SYSTEM_QUERIES =
  "Primești o temă de cercetat. Generează 3 interogări de căutare web diferite, care acoperă unghiuri diferite ale temei " +
  "(context/definiție, detalii concrete, date recente sau comparații/opinii). Interogări scurte, formulate în limba cea mai potrivită pentru a găsi surse bune. Nu include termeni sexuali expliciți, pornografici sau de violență grafică. " +
  'Răspunde DOAR cu JSON valid: {"queries": ["...", "...", "..."]}.';

const systemRankN = (n) =>
  "Primești o temă de cercetat și o listă numerotată de rezultate de căutare web (titlu, adresă, fragment). " +
  `Alege cele mai bune ${n} rezultate pentru o cercetare cuprinzătoare: pagini diferite, care acoperă unghiuri diferite ale temei, ` +
  "preferând surse oficiale sau de încredere. Evită duplicatele (aceeași pagină sau același conținut). " +
  'Răspunde DOAR cu JSON valid: {"order": [2, 0, 5]} (numerele rezultatelor, în ordinea relevanței).';

const SYSTEM_NOTES =
  "Ești un cercetător. Primești textul unei pagini web și o temă de cercetat. Extrage TOATE informațiile utile despre temă din pagină: " +
  "fapte, cifre, date, nume, explicații, opinii. Folosește doar ce scrie în pagină. Răspunde DOAR cu JSON valid, în forma: " +
  '{"relevant": true, "safe": true, "notes": "rezumat dens, 4-10 propoziții, în limba temei", "quotes": ["fragment exact 1", "fragment exact 2"]}. ' +
  "Setează safe=false și relevant=false dacă pagina conține conținut sexual explicit, pornografic, violență grafică sau gore. " +
  "Regulile pentru quotes: fragmente copiate IDENTIC, caracter cu caracter, din textul paginii (o propoziție sau mai puțin, maxim 5, cele mai importante), " +
  'ca să poată fi subliniate pe pagină. Dacă pagina nu conține nimic util despre temă: {"relevant": false, "notes": "", "quotes": []}.';

const SYSTEM_REPORT =
  "Ești un cercetător. Primești o temă și notițe din mai multe surse numerotate [1], [2], ... " +
  "Scrie un raport de cercetare clar și bine structurat, în limba temei, de maxim ~600 de cuvinte. " +
  "Folosește DOAR informațiile din notițe, fără să inventezi. Citează sursele în text cu [n]. " +
  "Dacă sursele se contrazic, spune asta explicit. Dacă lipsesc informații importante sau există lacune rămase neacoperite, menționează-le într-o secțiune „Limite”. " +
  "Format: text simplu, FĂRĂ markdown (fără **, #, tabele). Titluri scurte pe rând separat, paragrafe scurte, liste cu „- ”. " +
  "Încheie cu o secțiune „Concluzie” de 2-3 propoziții.";

// Îmbină liste de rezultate alternând între ele, fără duplicate.
function mergeResultLists(lists) {
  const out = [], seen = new Set();
  const key = (u) => u.split("#")[0].replace(/\/$/, "");
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const r = l[i];
      if (r && !seen.has(key(r.url))) { seen.add(key(r.url)); out.push(r); }
    }
  }
  return out;
}

const SYSTEM_GAPS =
  "Ești un cercetător riguros. Primești o temă, interogările deja făcute și notițele strânse până acum din surse numerotate. " +
  "Evaluează dacă notițele acoperă tema. Caută: (a) informații importante care lipsesc, (b) contradicții între surse, " +
  "(c) afirmații importante susținute de o singură sursă și care merită verificate în altă parte. " +
  'Dacă acoperirea e suficientă, răspunde {"enough": true, "gaps": [], "queries": []}. ' +
  'Altfel răspunde DOAR cu JSON valid: {"enough": false, "gaps": ["lacună 1, scurt", "lacună 2"], "queries": ["interogare țintită 1", "interogare 2"]}. ' +
  "Maxim 3 lacune și 3 interogări. Interogările sunt scurte, țintite pe lacune, DIFERITE de cele deja făcute. " +
  "Nu include termeni sexuali expliciți, pornografici sau de violență grafică.";

async function analyzePage(topic, page, maxChars, focus = "") {
  const extra = focus ? `\n\nConcentrează-te în special pe aceste lacune de informație: ${focus}` : "";
  const user = `Pagina: ${page.title} (${page.url})\n\n--- TEXT PAGINĂ ---\n${page.text.slice(0, maxChars)}\n--- SFÂRȘIT ---\n\nTema de cercetat: ${topic}${extra}`;
  const raw = await callLLM(SYSTEM_NOTES, user);
  return parseJSON(raw) || { relevant: false, notes: "", quotes: [] };
}

const urlKey = (u) => u.split("#")[0].replace(/\/$/, "");

// Caută cu mai multe interogări, exclude paginile deja văzute și lasă AI-ul să aleagă cele mai bune n pagini.
async function discoverTargets(topic, queries, opts, n, seen, tag = "") {
  const domains = store.sources;
  const lists = [];
  for (let i = 0; i < queries.length; i++) {
    if (cancelRequested) break;
    setStatus(`${tag}Caut (${i + 1}/${queries.length}): ${queries[i].slice(0, 50)}...`);
    lists.push(await collectResults(queries[i], opts));
  }
  let results = mergeResultLists(lists);
  if (opts.prioritizeSources) results = prioritizeResults(results, domains);
  const found = results.length;
  results = results.filter((r) => !seen.has(urlKey(r.url))).slice(0, 24);
  if (!results.length) return { targets: [], found };

  setStatus(`${tag}AI-ul alege paginile de analizat...`);
  let order = results.map((_, i) => i);
  try {
    const list = results.map((r, i) => `${i}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    const rank = parseJSON(await callLLM(systemRankN(n), `Temă: ${topic}\n\nRezultate:\n${list}`));
    if (Array.isArray(rank?.order)) {
      const valid = rank.order.map(Number).filter((i) => Number.isInteger(i) && results[i]);
      if (valid.length) order = [...new Set([...valid, ...order])];
    }
  } catch (e) { console.warn("Ranking eșuat, folosesc ordinea implicită", e); }
  if (opts.prioritizeSources && domains.length) {
    order = [
      ...order.filter((i) => hostMatches(results[i].url, domains)),
      ...order.filter((i) => !hostMatches(results[i].url, domains)),
    ];
  }
  const targets = order.slice(0, n).map((i) => ({ title: results[i].title, url: results[i].url }));
  targets.forEach((t) => seen.add(urlKey(t.url)));
  return { targets, found };
}

// Citește paginile ÎN FUNDAL (fără tab-uri, cu verificare de siguranță) și extrage notițe din fiecare.
async function readAnalyze(targets, topic, focus, perPageChars, tag = "", onNote = null) {
  const total = targets.length;
  setStatus(`${tag}Citesc ${total} pagini în fundal...`);
  // Citirile pornesc toate în paralel, dar nu așteptăm ultima: analizăm pagina 1 imediat ce e citită.
  const pages = targets.map(async (t) => {
    try {
      if (t.own) {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: t.tabId }, func: extractPage });
        if (await pageTextIsProhibited(result?.title, result?.text)) throw new Error("conținut nepotrivit");
        return result;
      }
      return await fetchPageText(t.url);
    } catch (e) {
      console.warn("Pagină omisă:", t.url, e);
      failLog.push(`${hostOf(t.url)}: ${e.message}`);
      return null;
    }
  });

  const notes = [];
  for (let k = 0; k < total; k++) {
    const t = targets[k], page = await pages[k];
    if (!page || cancelRequested) continue;
    setStatus(`${tag}Analizez pagina ${k + 1}/${total}: ${t.title.slice(0, 50)}...`);
    try {
      if (!page.text || page.text.length < 200) throw new Error("pagină goală sau încărcată doar prin JavaScript");
      const ai = await analyzePage(topic, page, perPageChars, focus);
      if (ai.safe === false) failLog.push(`${hostOf(t.url)}: AI-ul a marcat pagina ca nesigură`);
      else if (ai.relevant === false || !ai.notes) failLog.push(`${hostOf(t.url)}: AI-ul a considerat pagina irelevantă`);
      if (ai.safe !== false && ai.relevant !== false && ai.notes) {
        const note = { title: page.title || t.title, url: page.url || t.url, notes: ai.notes, quotes: ai.quotes || [], own: !!t.own, tabId: t.tabId };
        notes.push(note);
        if (onNote) onNote(note); // nu așteptăm: tab-ul se deschide în paralel cu analiza următoarelor pagini
      }
    } catch (e) {
      console.warn("Pagină ratată:", t.url, e);
      failLog.push(`${hostOf(t.url)}: ${e.message}`);
    }
  }
  return notes;
}

// AI-ul evaluează ce lipsește sau se contrazice și propune interogări țintite pentru runda următoare.
async function findGaps(topic, notes, doneQueries, qLangs) {
  const material = notes.map((n, i) => `[${i + 1}] ${n.title}: ${n.notes.slice(0, 700)}`).join("\n");
  const user = `Tema: ${topic}\n\nInterogări deja făcute:\n- ${doneQueries.join("\n- ")}\n\nNotițe strânse:\n${material}`;
  const p = parseJSON(await callLLM(SYSTEM_GAPS, user));
  if (!p || typeof p !== "object") return null;
  const done = new Set(doneQueries.map((x) => x.toLowerCase()));
  // Interogările propuse de AI trec prin baza de termeni interziși, în limba cererii tale.
  const queries = (Array.isArray(p.queries) ? p.queries : [])
    .map((x) => String(x).trim())
    .filter((x) => x && !done.has(x.toLowerCase()) && countHits(x, qLangs) === 0)
    .slice(0, 3);
  const gaps = (Array.isArray(p.gaps) ? p.gaps : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  return { enough: p.enough === true, gaps, queries };
}

// ---------- Grupare tab-uri (echivalentul „Tab Islands” / „Tab groups”) ----------
// Reguli:
//  - dacă tab-ul tău activ e deja într-un grup, paginile noi se deschid în ACEL grup (nu se creează altul);
//  - altfel, se creează un grup nou doar când se deschid cel puțin 2 pagini (createNew = true);
//  - o singură pagină nu creează niciodată un grup.
// Totul e opțional: dacă browserul nu expune chrome.tabs.group (sau o blochează pentru extensii),
// gruparea se oprește silențios după prima eroare și extensia merge ca înainte.
const groupState = { id: null, existing: null, broken: false };
let groupQueue = Promise.resolve(); // serializează apelurile, ca tab-urile deschise în paralel să nu creeze mai multe grupuri
async function detectUserGroup() {
  groupState.id = null; groupState.existing = null; groupState.broken = false;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t && typeof t.groupId === "number" && t.groupId >= 0) groupState.existing = t.groupId;
  } catch (e) { /* fără detectare: se comportă ca și cum nu ești într-un grup */ }
}
function addTabToGroup(tabId, title, { createNew = false } = {}) {
  groupQueue = groupQueue.then(async () => {
    if (groupState.broken || typeof chrome.tabs?.group !== "function") return;
    try {
      if (groupState.existing != null) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: groupState.existing });
      } else if (!createNew) {
        return;
      } else if (groupState.id == null) {
        const id = await chrome.tabs.group({ tabIds: [tabId] });
        if (typeof id !== "number") { groupState.broken = true; return; }
        groupState.id = id;
        try {
          await chrome.tabGroups?.update(id, { title: "🔎 " + String(title).slice(0, 30), color: "yellow", collapsed: false });
        } catch (e) { /* titlul/culoarea sunt opționale */ }
      } else {
        await chrome.tabs.group({ tabIds: [tabId], groupId: groupState.id });
      }
    } catch (e) {
      groupState.broken = true;
      console.info("Gruparea tab-urilor nu este disponibilă:", e?.message || e);
    }
  }).catch(() => {});
  return groupQueue;
}

// ---------- AI Finder: verificarea firmelor după criterii ----------
// Criterii obligatorii: locație, contact, despre noi. Opționale (doar bonus la scor): poze, recenzii.
const CRITERIA = [
  { id: "location", icon: "📍", label: "Locație",        color: "#16a34a", required: true },
  { id: "contact",  icon: "📞", label: "Contact",        color: "#ea580c", required: true },
  { id: "about",    icon: "ℹ️", label: "Despre noi",     color: "#9333ea", required: true },
  { id: "photos",   icon: "📷", label: "Poze / lucrări", color: "#2563eb", required: false },
  { id: "reviews",  icon: "⭐", label: "Recenzii",       color: "#db2777", required: false },
];
const STATE_POINTS = { yes: 1, maybe: 0.5, no: 0 };
const STATE_MARK = { yes: "✅", maybe: "❓", no: "❌" };

const SYSTEM_CRITERIA =
  "Verifici dacă site-ul unei firme (sau al unui prestator de servicii) merită vizitat. Primești serviciul căutat, zona dorită, " +
  "textul paginii și semnale tehnice detectate în codul paginii (număr de imagini de conținut, galerie, linkuri de telefon, formulare etc.). " +
  "Răspunde DOAR cu JSON valid, în forma: " +
  '{"safe": true, "type": "firma", "summary": "o propoziție despre ce oferă firma", ' +
  '"criteria": {' +
  '"photos": {"found": true, "quotes": ["..."]}, ' +
  '"location": {"found": true, "covers_area": true, "areas": "zonele menționate, scurt", "quotes": ["..."]}, ' +
  '"contact": {"found": true, "quotes": ["..."]}, ' +
  '"about": {"found": true, "quotes": ["..."]}, ' +
  '"reviews": {"found": false, "quotes": []}}}. ' +
  "Semnificații: " +
  "type = \"firma\" dacă pagina aparține unei firme/prestator care oferă serviciul; \"director\" dacă este un catalog, platformă de anunțuri, agregator, " +
  "articol sau comparator; \"alt\" pentru orice altceva. " +
  "photos = pagina prezintă galerie, lucrări realizate, proiecte sau portofoliu (nu doar o imagine decorativă). " +
  "location = pagina spune clar unde se află firma sau în ce zonă activează; covers_area = true dacă zona dorită este acoperită, " +
  "false dacă firma activează clar în altă zonă, null dacă zona dorită nu e specificată sau nu se poate stabili. " +
  "contact = telefon, e-mail, formular de contact sau buton de solicitare ofertă. " +
  "about = secțiune despre firmă, echipă, povestea sau experiența firmei. " +
  "reviews = recenzii, păreri, testimoniale sau note ale clienților. " +
  "Regulile pentru quotes: maxim 2 fragmente per criteriu, copiate IDENTIC, caracter cu caracter, din textul paginii, scurte (o propoziție sau mai puțin), " +
  "ca să poată fi găsite și subliniate pe pagină. Pentru un criteriu negăsit pune found=false și quotes=[]. " +
  "Setează safe=false dacă pagina conține conținut sexual explicit, pornografic, violență grafică sau gore.";

const SYSTEM_SERVICE_QUERIES =
  "Primești un serviciu căutat de un client (și eventual zona). Generează 3 interogări de căutare web diferite, ca să găsești firme care oferă serviciul: " +
  "formulări diferite (firmă, echipă, servicii, lucrări realizate, ofertă). Interogări scurte, în aceeași limbă cu cererea, care păstrează zona dacă există. " +
  "Nu include termeni sexuali expliciți, pornografici sau de violență grafică. " +
  'Răspunde DOAR cu JSON valid: {"queries": ["...", "...", "..."]}.';

// Semnale din codul HTML (rulează pe documentul brut, înainte să fie curățat).
function pageSignals(doc) {
  const imgs = [...doc.querySelectorAll("img")].filter((im) => {
    const src = (im.getAttribute("src") || im.getAttribute("data-src") || im.getAttribute("data-lazy-src") || "").toLowerCase();
    if (!src || src.startsWith("data:image/svg")) return false;
    if (/logo|icon|sprite|avatar|favicon|flag|pixel|spacer|badge|\.svg(\?|$)/.test(src)) return false;
    const w = parseInt(im.getAttribute("width") || "0", 10), h = parseInt(im.getAttribute("height") || "0", 10);
    if ((w && w < 80) || (h && h < 80)) return false;
    return true;
  }).length;
  const has = (sel) => !!doc.querySelector(sel);
  const gallery = has('[class*="galler" i],[id*="galler" i],[class*="galer" i],[id*="galer" i],[class*="portfolio" i],[id*="portfolio" i],[class*="lightbox" i],[class*="lucrari" i],[class*="proiecte" i],[class*="realizari" i]');
  const tel = doc.querySelectorAll('a[href^="tel:" i]').length;
  const mailto = doc.querySelectorAll('a[href^="mailto:" i]').length;
  const forms = [...doc.querySelectorAll("form")].filter((f) => f.querySelector("input:not([type=hidden]):not([type=search]),textarea")).length;
  const reviewHints = has('[class*="review" i],[class*="testimonial" i],[class*="recenz" i],[class*="rating" i],a[href*="trustpilot"],a[href*="g.page"],a[href*="google.com/maps"]');
  const aboutLink = [...doc.querySelectorAll("a")].some((a) => /despre|about|echip|cine suntem|who we are/i.test(a.textContent || "") || /despre|about/i.test(a.getAttribute("href") || ""));
  return { imgs, gallery, tel, mailto, forms, reviewHints, aboutLink };
}

// Combină părerea AI-ului cu semnalele din cod. Stări: yes / maybe / no.
function mergeCriteria(ai, sig, text, area) {
  const c = ai.criteria || {};
  const g = (k) => c[k] || {};
  const q = (k) => (Array.isArray(g(k).quotes) ? g(k).quotes.map(String).filter(Boolean).slice(0, 2) : []);
  const phoneInText = /(\+?40|0)[\s.\-]?7\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3}|(\+?40|0)[\s.\-]?[23]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3}/.test(text);

  const out = {};
  // Poze: dovada tare = imagini reale în cod + galerie sau confirmarea AI-ului. Doar textul fără imagini = „poate” (pagini încărcate prin JavaScript).
  out.photos = {
    state: sig.imgs >= 3 && (g("photos").found || sig.gallery) ? "yes" : (g("photos").found || sig.gallery || sig.imgs >= 6 ? "maybe" : "no"),
    quotes: q("photos"),
  };
  let locState = g("location").found ? "yes" : "no";
  if (locState === "yes" && area && g("location").covers_area === false) locState = "maybe";
  out.location = { state: locState, quotes: q("location"), areas: String(g("location").areas || ""), otherArea: !!area && g("location").covers_area === false };
  out.contact = {
    state: g("contact").found || sig.tel > 0 || sig.forms > 0 || phoneInText ? "yes" : (sig.mailto > 0 ? "maybe" : "no"),
    quotes: q("contact"),
  };
  out.about = { state: g("about").found ? "yes" : (sig.aboutLink ? "maybe" : "no"), quotes: q("about") };
  out.reviews = { state: g("reviews").found || sig.reviewHints ? "yes" : "no", quotes: q("reviews") };

  let score = 0;
  for (const cr of CRITERIA) if (cr.required) score += STATE_POINTS[out[cr.id].state];
  score += out.reviews.state === "yes" ? 0.25 : 0; // bonus mic, doar la egalitate
  score += out.photos.state === "yes" ? 0.25 : 0;
  return { criteria: out, score };
}

async function evaluateSite(service, area, page) {
  const { provider } = await getCfg();
  const text = page.text.slice(0, Math.min(PROVIDERS[provider].maxChars, 40000));
  const user =
    `Serviciul căutat: ${service}\nZona dorită: ${area || "(nespecificată)"}\n` +
    `Pagina: ${page.title} (${page.url})\n\nSemnale tehnice din cod: ${JSON.stringify(page.signals || {})}\n\n` +
    `--- TEXT PAGINĂ ---\n${text}\n--- SFÂRȘIT ---`;
  const ai = parseJSON(await callLLM(SYSTEM_CRITERIA, user)) || {};
  const merged = mergeCriteria(ai, page.signals || {}, text, area);
  return {
    title: page.title, url: page.url, host: hostOf(page.url),
    type: ai.type || "firma", safe: ai.safe !== false, summary: String(ai.summary || ""),
    ...merged,
  };
}

// ---------- Funcții injectate în pagină (trebuie să fie independente) ----------
function highlightCriteria(items, focusId, meta) {
  const PFX = "ai-finder-";
  const PANEL_ID = "__ai_finder_panel";
  const clearAll = () => {
    if (CSS.highlights) for (const k of [...CSS.highlights.keys()]) if (k.startsWith(PFX)) CSS.highlights.delete(k);
    document.querySelectorAll("[data-aif]").forEach((e) => { e.removeAttribute("data-aif"); e.style.removeProperty("--aif"); });
    document.getElementById("__ai_finder_style2")?.remove();
    document.getElementById(PANEL_ID)?.remove();
  };
  clearAll();
  const st = document.createElement("style");
  st.id = "__ai_finder_style2";
  st.textContent =
    items.map((i) => `::highlight(${PFX}${i.id}){background-color:${i.color}66;color:inherit;text-decoration:underline;text-decoration-color:${i.color};text-decoration-thickness:3px;}`).join("\n") +
    "\n[data-aif]{outline:3px solid var(--aif,#0f766e)!important;outline-offset:3px!important;}";
  document.head.appendChild(st);

  const res = { text: {}, dom: {} };
  let firstEl = null;
  const elsById = {};
  const addEl = (id, el) => {
    if (!el) return;
    const a = (elsById[id] = elsById[id] || []);
    if (!a.includes(el)) a.push(el);
    if (!firstEl) firstEl = el;
  };

  // 1) Fragmente de text
  if (CSS.highlights) {
    const clean = (c) => c.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let flat = "";
    const map = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue;
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i])) continue;
        flat += clean(t[i]).charAt(0) || t[i];
        map.push([n, i]);
      }
    }
    for (const it of items) {
      const hl = new Highlight();
      let found = 0;
      for (const qt of it.quotes || []) {
        const needle = clean(String(qt)).replace(/\s+/g, "");
        if (needle.length < 3) continue;
        let from = 0, idx;
        while ((idx = flat.indexOf(needle, from)) !== -1) {
          const [sn, so] = map[idx];
          const [en, eo] = map[idx + needle.length - 1];
          const r = new Range();
          r.setStart(sn, so);
          r.setEnd(en, eo + 1);
          hl.add(r);
          addEl(it.id, sn.parentElement);
          found++;
          from = idx + needle.length;
        }
      }
      if (found) CSS.highlights.set(PFX + it.id, hl);
      res.text[it.id] = found;
    }
  }

  // 2) Elemente (poze, butoane de contact, formulare, recenzii) — chenar colorat
  const color = (id) => (items.find((i) => i.id === id) || {}).color;
  const mark = (id, els) => {
    let k = 0;
    for (const el of els) {
      if (!el || k >= 6) break;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      el.setAttribute("data-aif", id);
      el.style.setProperty("--aif", color(id));
      addEl(id, el);
      k++;
    }
    res.dom[id] = k;
  };
  const ids = items.map((i) => i.id);
  if (ids.includes("photos")) {
    const gal = [...document.querySelectorAll('[class*="galler" i],[id*="galler" i],[class*="galer" i],[id*="galer" i],[class*="portfolio" i],[id*="portfolio" i],[class*="lucrari" i],[class*="proiecte" i]')]
      .filter((e) => e.querySelector("img"));
    if (gal.length) mark("photos", gal.slice(0, 2));
    else {
      const big = [...document.querySelectorAll("img")].filter((i) => i.width >= 150 && i.height >= 100 && !/logo|icon|avatar/i.test(i.src));
      mark("photos", big.slice(0, 4));
    }
  }
  if (ids.includes("contact")) {
    mark("contact", [
      ...document.querySelectorAll('a[href^="tel:" i]'),
      ...document.querySelectorAll("form"),
      ...document.querySelectorAll('a[href^="mailto:" i]'),
    ].filter((e, i, a) => a.indexOf(e) === i));
  }
  if (ids.includes("reviews")) {
    mark("reviews", [...document.querySelectorAll('[class*="testimonial" i],[class*="review" i],[class*="recenz" i]')].filter((e) => e.textContent.trim().length > 20));
  }
  // ordine în pagină, de sus în jos, ca navigarea să fie logică
  for (const id of Object.keys(elsById)) {
    elsById[id].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  const pulse = (el, c) => {
    try {
      el.animate(
        [{ outline: `4px solid ${c}`, outlineOffset: "4px" }, { outline: `4px solid ${c}00`, outlineOffset: "14px" }],
        { duration: 1000, easing: "ease-out" }
      );
    } catch (e) {}
  };
  const goTo = (el, c) => {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    pulse(el, c);
  };

  // 3) Etichete lipicioase (ca post-it-urile din cărți) pe marginea dreaptă, lângă panoul extensiei
  if (meta) {
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText = "all:initial;position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const css = document.createElement("style");
    css.textContent = `
      *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      .stack{display:flex;flex-direction:column;align-items:flex-end;gap:7px}
      .tab{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:7px;height:38px;padding:0 16px 0 11px;
        border-radius:12px 0 0 12px;background:var(--c);color:#fff;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;
        box-shadow:-3px 3px 8px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.35);
        transform:translateX(8px);transition:transform .18s ease,box-shadow .18s ease}
      .tab:hover,.tab:focus-visible,.tab.open{transform:translateX(0);box-shadow:-5px 4px 12px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.35)}
      .tab:focus-visible{outline:2px solid #fff;outline-offset:-4px}
      .ic{font-size:16px;line-height:1}
      .lb{max-width:0;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:max-width .22s ease,opacity .15s ease}
      .tab:hover .lb,.tab:focus-visible .lb,.tab.open .lb{max-width:150px;opacity:1}
      .n{min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:rgba(255,255,255,.92);color:#222;font-size:11px;font-weight:700;display:grid;place-items:center}
      .tab.maybe{background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.2) 0 6px,transparent 6px 12px)}
      .tab.off{background:#8b8b92;opacity:.6;cursor:default}
      .tab.note{--c:#ffb81c;color:#1a1200;height:42px}
      .tab.note .n{background:#1a1200;color:#ffb81c}
      .stack.collapsed .tab:not(.note){display:none}
    `;
    const stack = document.createElement("div");
    stack.className = "stack";

    const mk = (cls, c, icon, label, count) => {
      const b = document.createElement("button");
      b.className = "tab " + cls;
      b.style.setProperty("--c", c);
      const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = icon;
      const lb = document.createElement("span"); lb.className = "lb"; lb.textContent = label;
      const n = document.createElement("span"); n.className = "n"; n.textContent = count;
      b.append(ic, lb, n);
      return { b, n };
    };

    const note = mk("note", "#ffb81c", "🔎", meta.host, `${meta.ok}/${meta.total}`);
    note.b.title = "Click = ascunde / arată etichetele";
    note.b.onclick = () => stack.classList.toggle("collapsed");
    stack.appendChild(note.b);

    for (const row of meta.rows) {
      const els = elsById[row.id] || [];
      const off = row.state === "no" || !els.length;
      const t = mk((row.state === "maybe" ? "maybe " : "") + (off ? "off" : ""), row.color, row.icon, row.label,
        row.state === "no" ? "✕" : els.length ? String(els.length) : "—");
      t.b.title = row.state === "no" ? "Nu a fost găsit pe site"
        : !els.length ? "Nu am găsit un fragment de subliniat pe această pagină (poate e pe altă pagină a site-ului)"
        : row.state === "maybe" ? "Posibil, neconfirmat. Click = mergi la el" : "Click = mergi la el (click din nou = următorul)";
      if (!off) {
        let pos = -1, timer = null;
        t.b.onclick = () => {
          pos = (pos + 1) % els.length;
          goTo(els[pos], row.color);
          if (els.length > 1) t.n.textContent = `${pos + 1}/${els.length}`;
          t.b.classList.add("open");
          clearTimeout(timer);
          timer = setTimeout(() => t.b.classList.remove("open"), 1800);
        };
      }
      stack.appendChild(t.b);
    }
    root.append(css, stack);
    document.documentElement.appendChild(host);
  }

  const target = (focusId && elsById[focusId]?.[0]) || firstEl;
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (focusId) pulse(target, color(focusId) || "#0f766e");
  }
  return res;
}

// Date pentru panoul din pagină.
function panelMeta(r) {
  const req = CRITERIA.filter((c) => c.required);
  return {
    host: r.host,
    ok: req.filter((c) => r.criteria[c.id].state === "yes").length,
    total: req.length,
    rows: CRITERIA.map((c) => ({
      id: c.id, icon: c.icon, color: c.color,
      label: c.label,
      state: r.criteria[c.id].state,
    })),
  };
}

// Culorile și quotes-urile criteriilor, în formatul cerut de highlightCriteria.
function criteriaItems(res) {
  return CRITERIA
    .filter((c) => res.criteria[c.id].state !== "no")
    .map((c) => ({ id: c.id, color: c.color, quotes: res.criteria[c.id].quotes }));
}

// Click pe o firmă: aduce (sau deschide) site-ul, subliniază criteriile și afișează panoul de navigare din pagină.
async function focusSite(r) {
  try {
    let tab = r.tabId != null ? await chrome.tabs.get(r.tabId).catch(() => null) : null;
    if (!tab) {
      setStatus(`Deschid ${r.host}...`);
      tab = await chrome.tabs.create({ url: r.url, active: true });
      r.tabId = tab.id;
      await waitForTab(tab.id);
    } else {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, func: highlightCriteria, args: [criteriaItems(r), null, panelMeta(r)] })
      .catch(() => null);
    setStatus(`${r.host}: criteriile sunt subliniate. Folosește panoul din stânga paginii ca să sari între ele.`);
  } catch (e) {
    setStatus("Nu am putut deschide pagina: " + e.message);
  }
}

// Rezumat de sus: cea mai bună firmă și ce îi lipsește.
async function renderSummary(results, best) {
  const req = CRITERIA.filter((c) => c.required);
  const top = best[0] || results[0];
  const okOf = (r) => req.filter((c) => r.criteria[c.id].state === "yes").length;
  const missing = req
    .filter((c) => top.criteria[c.id].state !== "yes")
    .map((c) => `${c.icon} ${c.label} (${top.criteria[c.id].state === "maybe" ? "neconfirmat" : "lipsă"})`);
  const plain = `${results.length} firme verificate. ${top.host}. ${missing.join(", ")}`;
  const safe = await safeText(plain);
  if (safe !== plain) { showAnswer(safe, []); return; }

  const out = $("out");
  out.classList.remove("warn");
  out.classList.add("sum");
  out.textContent = "";
  $("links").innerHTML = "";

  const title = document.createElement("div");
  title.className = "sum-title";
  title.textContent = best.length
    ? `${results.length} firme verificate · ${best.length === 1 ? "1 recomandată" : best.length + " recomandate"}`
    : `${results.length} firme verificate · niciuna completă`;
  out.appendChild(title);

  const pick = document.createElement("div");
  pick.className = "sum-pick";
  const a = document.createElement("a");
  a.href = top.url; a.target = "_blank"; a.rel = "noopener";
  a.textContent = top.host;
  a.title = "Deschide și subliniază criteriile";
  a.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    focusSite(top);
  });
  const sc = document.createElement("span");
  const ok = okOf(top);
  sc.className = "score " + (ok === req.length ? "good" : ok >= Math.ceil(req.length / 2) ? "mid" : "bad");
  sc.textContent = `${ok}/${req.length}`;
  pick.append(a, sc);
  out.appendChild(pick);

  const line = document.createElement("div");
  line.className = "sum-line";
  if (!missing.length) {
    line.textContent = best.length > 1
      ? `Îndeplinește toate criteriile obligatorii. Încă ${best.length - 1} firme sunt la fel de complete.`
      : "Îndeplinește toate criteriile obligatorii.";
  } else {
    line.textContent = `Cea mai completă din cele verificate. Îi lipsește: ${missing.join(", ")}.`;
  }
  out.appendChild(line);
  out.style.display = "block";
}

// ---------- Raport în panou ----------
function renderReport(results, area) {
  const box = $("report");
  box.innerHTML = "";
  if (!results.length) return;
  const req = CRITERIA.filter((c) => c.required);

  results.forEach((r, idx) => {
    const card = document.createElement("div");
    card.className = "site";
    const open = (e) => {
      // click normal = deschide/aduce tab-ul, subliniază și afișează etichetele din pagină; Ctrl/Cmd/middle-click = link obișnuit
      if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0)) return;
      if (e) e.preventDefault();
      focusSite(r);
    };

    const head = document.createElement("div");
    head.className = "site-head";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(idx + 1);
    const a = document.createElement("a");
    a.href = r.url; a.target = "_blank"; a.rel = "noopener";
    a.title = "Deschide și subliniază criteriile";
    a.textContent = r.host;
    a.addEventListener("click", open);
    const score = document.createElement("span");
    const ok = req.filter((c) => r.criteria[c.id].state === "yes").length;
    score.className = "score " + (ok === req.length ? "good" : ok >= Math.ceil(req.length / 2) ? "mid" : "bad");
    score.textContent = `${ok}/${req.length}`;
    score.title = "Criterii obligatorii îndeplinite";
    head.append(rank, a, score);
    card.appendChild(head);

    if (r.summary) {
      const d = document.createElement("p");
      d.className = "site-desc";
      d.textContent = r.summary;
      card.appendChild(d);
    }

    const loc = r.criteria.location;
    if (loc.otherArea || loc.areas) {
      const p = document.createElement("div");
      p.className = "loc" + (loc.otherArea ? " warn" : "");
      p.textContent = loc.otherArea
        ? `⚠ Pare să activeze în altă zonă decât „${area}”${loc.areas ? ` (${loc.areas})` : ""}`
        : `📍 ${loc.areas}`;
      card.appendChild(p);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "open-site";
    btn.textContent = "↗ Deschide și subliniază";
    btn.onclick = () => open();
    card.appendChild(btn);

    box.appendChild(card);
  });
}

// ---------- Fluxul principal: caută firme, verifică-le, deschide-le subliniate ----------
async function runFinder(q, { deep = false } = {}) {
  failLog = [];
  await detectUserGroup();
  const area = $("loc").value.trim();
  const query = area && !norm(q).includes(norm(area)) ? `${q} ${area}` : q;
  const goodWanted = store.goodPages || 3;      // oprește când s-au găsit atâtea pagini bune
  const maxChecked = store.maxPages || 12;      // oprește după ce s-au verificat atâtea pagini, chiar dacă nu sunt destule bune
  const isGood = (r) => CRITERIA.filter((c) => c.required).every((c) => r.criteria[c.id].state === "yes");
  const qL = await queryLangs(query);

  // 1) Interogări
  let queries = [query];
  if (deep) {
    setStatus("Planific căutările...");
    try {
      const p = parseJSON(await callLLM(SYSTEM_SERVICE_QUERIES, `Serviciu: ${q}\nZona: ${area || "(nespecificată)"}`));
      if (Array.isArray(p?.queries)) {
        const extra = p.queries.map((x) => String(x).trim()).filter((x) => x && x.toLowerCase() !== query.toLowerCase() && countHits(x, qL) === 0);
        queries = [query, ...extra].slice(0, 3);
      }
    } catch (e) { console.warn("Generarea interogărilor a eșuat", e); }
  }

  // 2) Rezultate: un singur rezultat per site
  const lists = [];
  for (let i = 0; i < queries.length; i++) {
    if (cancelRequested) { setStatus("Oprit."); return; }
    setStatus(`Caut firme (${i + 1}/${queries.length}): ${queries[i].slice(0, 50)}...`);
    lists.push(await collectResults(queries[i], { restrictToSources: false, prioritizeSources: false, quiet: true }));
  }
  const seenHosts = new Set();
  const candidates = mergeResultLists(lists).filter((r) => {
    const h = hostOf(r.url);
    if (seenHosts.has(h)) return false;
    seenHosts.add(h);
    return true;
  }).slice(0, maxChecked);
  if (!candidates.length) throw new Error("Nu am putut obține rezultate de căutare (posibil blocat temporar). Încearcă din nou.");

  // 3) Verificare pe criterii, în fundal (nicio pagină nu se deschide înainte)
  const results = [];
  let skipped = 0, checked = 0, good = 0;
  for (let i = 0; i < candidates.length && checked < maxChecked && good < goodWanted; i++) {
    if (cancelRequested) break;
    const c = candidates[i];
    checked++;
    setStatus(`Verific pagina ${checked}/${maxChecked} (bune: ${good}/${goodWanted}): ${hostOf(c.url)}...`);
    try {
      const page = await fetchPageText(c.url);
      if (!page.text || page.text.length < 200) throw new Error("pagină goală sau încărcată doar prin JavaScript");
      const r = await evaluateSite(q, area, page);
      if (!r.safe) throw new Error("conținut nepotrivit");
      if (r.type !== "firma") { skipped++; continue; } // cataloage, anunțuri, articole
      results.push(r);
      if (isGood(r)) good++;
    } catch (e) {
      console.warn("Site omis:", c.url, e);
      failLog.push(`${hostOf(c.url)}: ${e.message}`);
    }
  }

  if (!results.length) {
    const why = failLog.length ? "\n\nMotive:\n- " + [...new Set(failLog)].slice(0, 6).join("\n- ") : "";
    showAnswer("Nu am găsit site-uri de firme pe care să le pot verifica." + why, candidates.slice(0, 5));
    setStatus(cancelRequested ? "Oprit." : "Nu am găsit firme verificabile.");
    return;
  }
  results.sort((a, b) => b.score - a.score);
  renderReport(results, area);

  const best = results.filter((r) => CRITERIA.filter((c) => c.required).every((c) => r.criteria[c.id].state === "yes"));
  await renderSummary(results, best);

  // 4) Deschide cele mai bune 3 site-uri, cu criteriile subliniate; primul se aduce în prim-plan
  const toOpen = results.filter((r) => r.score >= 1.5).slice(0, 3);
  const opened = [];
  let focused = false;
  for (const r of toOpen) {
    if (cancelRequested) break;
    try {
      setStatus(`Deschid ${r.host} și subliniez criteriile...`);
      const tab = await chrome.tabs.create({ url: r.url, active: false });
      opened.push(tab.id);
      r.tabId = tab.id;
      if (groupState.existing != null) await addTabToGroup(tab.id, q);
      else if (opened.length === 2) { await addTabToGroup(opened[0], q, { createNew: true }); await addTabToGroup(tab.id, q, { createNew: true }); }
      else if (opened.length > 2) await addTabToGroup(tab.id, q, { createNew: true });
      await waitForTab(tab.id);
      const [{ result: hl }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: highlightCriteria, args: [criteriaItems(r), null, panelMeta(r)] });
      if (!focused && HAS_SIDE_PANEL && hl && (Object.values(hl.text).some((n) => n > 0) || Object.values(hl.dom).some((n) => n > 0))) {
        focused = true;
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      }
    } catch (e) { console.warn("Deschidere/subliniere eșuată:", r.url, e); }
  }
  setStatus(`Gata. ${checked} pagini verificate, ${good} bune, ${results.length} firme în raport${skipped ? `, ${skipped} cataloage ocolite` : ""}${cancelRequested ? " (oprit mai devreme)" : ""}. Cele mai bune au rămas deschise, cu criteriile subliniate.`);
}

// ---------- Butoane ----------
function setBusy(b) {
  $("go").disabled = b;
}

$("stop").onclick = () => { cancelRequested = true; setStatus("Opresc... termin pasul curent."); };

async function startSearch() {
  const q = $("q").value.trim();
  if (!q) return;
  setBusy(true);
  cancelRequested = false;
  $("stop").style.display = "";
  $("out").style.display = "none";
  $("links").innerHTML = "";
  $("report").innerHTML = "";
  try {
    if (!(await guardQuery(q + " " + $("loc").value))) {
      await runFinder(q, { deep: true });
    }
  } catch (e) {
    setStatus("Eroare: " + e.message);
  } finally {
    $("stop").style.display = "none";
    setBusy(false);
  }
}
$("go").onclick = startSearch;

$("clear").onclick = async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clearInPage }).catch(() => {});
  setStatus("Subliniere ștearsă.");
};

$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("go").click(); }
});
$("loc").addEventListener("change", () => chrome.storage.local.set({ loc: $("loc").value.trim() }));