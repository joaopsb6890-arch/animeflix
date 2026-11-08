/* AnimeFlix — utilidades, API e persistência local. */
const AF = (window.AF = window.AF || {});

AF.API_BASE = location.protocol.startsWith('http')
    ? location.origin
    : (window.ANIMEFLIX_SERVER || 'http://127.0.0.1:8000');

AF.NO_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='300'>" +
    "<rect width='100%' height='100%' fill='#15151d'/>" +
    "<text x='50%' y='50%' fill='#4a4a5c' font-size='16' text-anchor='middle'>sem foto</text></svg>");

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
AF.esc = t => String(t ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
AF.$ = (sel, root) => (root || document).querySelector(sel);
AF.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

AF.el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
};

AF.clamp = (v, a, b) => Math.min(b, Math.max(a, v));

AF.clock = sec => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
};

AF.longClock = sec => {
    sec = Math.floor(sec || 0);
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'min';
    return m + 'min';
};

/* O servidor entrega as fontes já assinadas ("/proxy?url=…&sig=…"): basta ancorar
   no domínio. Uma URL crua não passa mais pelo proxy (volta como veio). */
AF.proxyUrl = (u) => {
    if (!u) return '';
    return u.startsWith('/proxy?') ? AF.API_BASE + u : u;
};

/* ── rede ───────────────────────────────────────────────────────────────────── */
const inflight = new Map();

AF.apiGet = async (path, opts = {}) => {
    if (!opts.noCache && inflight.has(path)) return inflight.get(path);
    const p = (async () => {
        const res = await fetch(AF.API_BASE + path, { cache: 'no-store' });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).detail || ''; } catch (e) { detail = res.statusText; }
            const err = new Error(detail || ('HTTP ' + res.status));
            err.status = res.status;
            throw err;
        }
        return res.json();
    })().finally(() => inflight.delete(path));
    if (!opts.noCache) inflight.set(path, p);
    return p;
};

AF.getText = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
};

/* ── recursos do servidor ───────────────────────────────────────────────────── */
AF.features = { subdl: false, ptbr: true };
AF.loadConfig = async () => {
    try {
        const c = await AF.apiGet('/api/config', { noCache: true });
        AF.features = Object.assign(AF.features, c.features || {});
    } catch (e) { /* sem config: segue com os padrões */ }
};

/* Rótulos de áudio — um lugar só, usados no player, nos ajustes e no catálogo. */
AF.AUDIO = {
    'sub':    { label: 'Original + legenda',  short: 'LEG',   hint: 'áudio japonês, legenda em PT-BR quando houver' },
    'sub-pt': { label: 'Legendado PT-BR',     short: 'PT·LEG', hint: 'legenda em português já no vídeo' },
    'dub-pt': { label: 'Dublado PT-BR',       short: 'PT·DUB', hint: 'dublagem brasileira' },
    'dub':    { label: 'Dublado em inglês',   short: 'EN·DUB', hint: 'dublagem em inglês' },
};

/* Ordem de tentativa quando o áudio pedido não existe para o episódio. */
AF.AUDIO_CHAIN = {
    'dub-pt': ['dub-pt', 'sub-pt', 'sub', 'dub'],
    'sub-pt': ['sub-pt', 'sub', 'dub-pt', 'dub'],
    'sub':    ['sub', 'sub-pt', 'dub-pt', 'dub'],
    'dub':    ['dub', 'sub', 'dub-pt', 'sub-pt'],
};

/* Buscas recentes (só neste aparelho) */
AF.searches = {
    list() { try { return JSON.parse(localStorage.getItem('animeflix.searches') || '[]') || []; } catch (e) { return []; } },
    add(q) {
        q = String(q || '').trim();
        if (q.length < 2) return;
        const l = this.list().filter(x => x.toLowerCase() !== q.toLowerCase());
        l.unshift(q);
        try { localStorage.setItem('animeflix.searches', JSON.stringify(l.slice(0, 8))); } catch (e) {}
    },
    clear() { try { localStorage.removeItem('animeflix.searches'); } catch (e) {} },
};

/* ── toast ──────────────────────────────────────────────────────────────────── */
AF.toast = (msg, ms = 3800, action) => {
    const host = document.getElementById('toasts');
    if (!host) return;
    const t = AF.el('div', 'toast');
    t.innerHTML = '<span>' + AF.esc(msg) + '</span>';
    if (action) {
        const b = AF.el('button', 'toast-act', AF.esc(action.label));
        b.onclick = () => { hide(); action.run(); };
        t.appendChild(b);
    }
    const hide = () => {
        clearTimeout(t._t);
        t.classList.add('out');
        setTimeout(() => t.remove(), 260);
    };
    t.onclick = hide;
    host.appendChild(t);
    t._t = setTimeout(hide, ms);
    return hide;
};

/* ── configurações ──────────────────────────────────────────────────────────── */
AF.DEFAULTS = {
    volume: 1, muted: false, rate: 1, seekStep: 10, longPressRate: 2,
    tt: 'sub', server: '', quality: '', autoNext: true, resumePrompt: true,
    autoPtSub: true, onboarded: false, autoFs: true,
    autoSkipIntro: false, autoSkipOutro: false, gestures: true, uiHide: 3200,
    dim: 100, fit: 'contain',
    sub: { on: true, idx: -1, key: '', size: 100, color: '#ffffff', box: true, outline: true, delay: 0, pos: 90 },
};

const PREF_KEY = 'animeflix.prefs';

AF.cfg = {
    data: JSON.parse(JSON.stringify(AF.DEFAULTS)),
    load() {
        try {
            const raw = localStorage.getItem(PREF_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                this.data = Object.assign(JSON.parse(JSON.stringify(AF.DEFAULTS)), saved);
                this.data.sub = Object.assign({}, AF.DEFAULTS.sub, saved.sub || {});
                if (this.data.sub.pos === 72) this.data.sub.pos = 90;   /* antigo padrão: ficava no meio da tela */
            }
        } catch (e) { /* prefs corrompidas: volta ao padrão */ }
        return this.data;
    },
    save() {
        try { localStorage.setItem(PREF_KEY, JSON.stringify(this.data)); } catch (e) {}
    },
    set(patch) { Object.assign(this.data, patch); this.save(); },
    setSub(patch) { Object.assign(this.data.sub, patch); this.save(); },
    reset() { this.data = JSON.parse(JSON.stringify(AF.DEFAULTS)); this.save(); },
};
AF.cfg.load();

/* ── histórico / favoritos / fila ───────────────────────────────────────────── */
const histKey = (animeId, ep) => animeId + '@' + ep;

AF.hist = {
    all: {},
    load() {
        try { this.all = JSON.parse(localStorage.getItem('animeflix.hist') || '{}') || {}; }
        catch (e) { this.all = {}; }
    },
    save() {
        const keys = Object.keys(this.all);
        if (keys.length > 120) {
            keys.sort((a, b) => (this.all[a].at || 0) - (this.all[b].at || 0))
                .slice(0, keys.length - 120).forEach(k => delete this.all[k]);
        }
        try { localStorage.setItem('animeflix.hist', JSON.stringify(this.all)); } catch (e) {}
    },
    get(animeId, ep) { return this.all[histKey(animeId, ep)] || null; },
    touch(animeId, ep, patch) {
        const k = histKey(animeId, ep);
        this.all[k] = Object.assign({ at: Date.now(), t: 0, d: 0 }, this.all[k] || {}, patch, { at: Date.now() });
        this.save();
    },
    done(animeId, ep) { this.touch(animeId, ep, { done: true, t: 0 }); },
    drop(animeId, ep) { delete this.all[histKey(animeId, ep)]; this.save(); },
    lastOf(animeId) {
        const rows = this.ofAnime(animeId);
        return rows.sort((a, b) => b.at - a.at)[0] || null;
    },
    ofAnime(animeId) {
        return Object.entries(this.all)
            .filter(([k, v]) => k.startsWith(animeId + '@') && (v.d > 30 || v.done))
            .map(([k, v]) => Object.assign({ key: k, ep: k.slice(animeId.length + 1) }, v));
    },
    recent(limit = 16) {
        return Object.entries(this.all)
            .filter(([, v]) => v.animeId)
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, limit)
            .map(([k, v]) => Object.assign({ key: k, ep: k.split('@').pop(), animeId: k.split('@')[0] }, v));
    },
    clear() { this.all = {}; this.save(); },
};
AF.hist.load();

AF.favs = {
    list: [],
    load() { try { this.list = JSON.parse(localStorage.getItem('animeflix.favs') || '[]') || []; } catch (e) { this.list = []; } },
    save() { try { localStorage.setItem('animeflix.favs', JSON.stringify(this.list)); } catch (e) {} },
    has(id) { return this.list.some(x => x._id === id); },
    toggle(card) {
        const i = this.list.findIndex(x => x._id === card._id);
        if (i >= 0) this.list.splice(i, 1);
        else this.list.unshift({ _id: card._id, name: card.name, thumbnail: card.thumbnail });
        this.save();
        return i < 0;
    },
};
AF.favs.load();

AF.queue = {
    items: [],
    load() { try { this.items = JSON.parse(localStorage.getItem('animeflix.queue') || '[]') || []; } catch (e) { this.items = []; } },
    save() { try { localStorage.setItem('animeflix.queue', JSON.stringify(this.items.slice(0, 80))); } catch (e) {} },
    add(item) {
        if (this.items.some(i => i.animeId === item.animeId && i.ep === item.ep)) return false;
        this.items.unshift(item); this.save(); return true;
    },
    take(animeId, ep) {
        const i = this.items.findIndex(x => x.animeId === animeId && (!ep || x.ep === ep));
        return i < 0 ? null : this.items.splice(i, 1)[0];
    },
    firstFor(animeId) { return this.items.find(x => x.animeId === animeId) || null; },
    remove(i) { this.items.splice(i, 1); this.save(); },
    clear(animeId) { this.items = animeId ? this.items.filter(x => x.animeId !== animeId) : []; this.save(); },
};
AF.queue.load();

/* ── helpers de catálogo ────────────────────────────────────────────────────── */
AF.showOf = a => (a && a.node && a.node._id ? a.node : a);

AF.epNumber = e => parseFloat(String((e && (e.number || e.episodeIdNum)) || '0').split('-')[0]) || 0;

AF.progressPct = h => {
    if (!h || !h.d || h.done) return h && h.done ? 100 : 0;
    return AF.clamp(Math.round(h.t / h.d * 100), 2, 100);
};

/* Marca o fim de um card de catálogo para virar argumento de openAnime. */
AF.cardFrom = (show, epNum) => ({
    _id: show._id,
    id: show.id,
    name: show.name || show.englishName || AF.showOf(show).name || '',
    thumbnail: show.thumbnail || '',
    epNum: epNum == null ? '' : String(epNum),
});
