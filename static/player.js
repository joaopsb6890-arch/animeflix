/* AnimeFlix — legenda (parser VTT/SRT próprio) + motor do player.
 *
 * A legenda é desenhada por fora de propósito: o <track> nativo não dá controle
 * de tamanho/cor/atraso no WebView, e o app precisa de sync fino e estilo.
 *
 * Usa o AF declarado por core.js: redeclará-lo aqui é um SyntaxError no scope
 * global compartilhado e mataria o player inteiro no WebView.
 */

const stamp = s => {
    s = String(s).trim().replace(',', '.');
    const p = s.split(':').map(Number);
    if (p.some(isNaN)) return NaN;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return NaN;
};

const stripTags = t => String(t)
    .replace(/<[^>]*>/g, '')
    .replace(/\\N/g, ' ')
    .replace(/&(?:amp|#0*38);/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

AF.parseCues = text => {
    text = String(text).replace(/\r/g, '').replace(/^/, '');
    const out = [];
    for (const block of text.split(/\n{2,}/)) {
        const lines = block.split('\n');
        const ti = lines.findIndex(l => l.includes('-->'));
        if (ti < 0) continue;
        const parts = lines[ti].split('-->');
        const start = stamp(parts[0]);
        const end = stamp(String(parts[1] || '').trim().split(/\s+/)[0]);
        if (isNaN(start) || isNaN(end) || end <= start) continue;
        const txt = stripTags(lines.slice(ti + 1).join(' ').replace(/\s+/g, ' '));
        if (txt) out.push({ start, end, txt });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
};

AF.Subs = class Subs {
    constructor(layer) {
        this.layer = layer;
        this.tracks = [];
        this.idx = -1;
        this.cues = null;
        this.pos = 0;
        this.shown = '';
        this.cache = new Map();
        this.style = Object.assign({}, AF.cfg.data.sub);
    }

    setStyle(s) { Object.assign(this.style, s); this.applyStyle(); }

    applyStyle() {
        const el = this.layer, s = this.style;
        el.style.fontSize = 'calc(0.86rem * ' + (s.size / 100) * 1.35 + ')';
        el.style.color = s.color;
        el.style.bottom = (100 - s.pos) + '%';
        el.style.textShadow = s.outline
            ? '0 0 2px #000, 0 1px 3px #000, 0 0 6px rgba(0,0,0,.9)' : 'none';
        el.style.background = s.box ? 'rgba(6,6,10,.62)' : 'transparent';
        el.classList.toggle('nobox', !s.box);
    }

    setTracks(tracks) {
        this.tracks = (tracks || []).filter(t => t.url || t.text);
        this.cache.clear();
    }

    async select(idx) {
        this.idx = idx;
        this.cues = null;
        this.pos = 0;
        if (idx < 0 || !this.tracks[idx]) { this.layer.textContent = ''; this.shown = ''; return; }
        this.layer.textContent = 'carregando legenda…';
        let cues = this.cache.get(idx);
        if (!cues) {
            try {
                const t = this.tracks[idx];
                const text = t.text != null ? t.text : await AF.getText(AF.proxyUrl(t.url, t.referer));
                cues = AF.parseCues(text);
                this.cache.set(idx, cues);
            } catch (e) {
                this.layer.textContent = '';
                this.shown = '';
                throw e;
            }
        }
        this.cues = cues;
        this.layer.textContent = '';
        this.shown = '';
        return (this.cues || []).length;
    }

    render(time) {
        if (!this.cues || !this.cues.length) return;
        const t = time + (this.style.delay || 0) / 1000;
        let i = this.pos;
        while (i + 1 < this.cues.length && this.cues[i + 1].start <= t) i++;
        while (i > 0 && this.cues[i].start > t) i--;
        this.pos = i;
        const line = [];
        for (let k = i; k >= 0 && k > i - 4; k--) {
            const c = this.cues[k];
            if (c.start <= t && t < c.end && !line.includes(c.txt)) line.unshift(c.txt);
        }
        const txt = line.join('\n');
        if (txt !== this.shown) {
            this.shown = txt;
            this.layer.textContent = txt || '';
        }
    }
};

/* ── player ─────────────────────────────────────────────────────────────────── */
const UI = `
<div class="pl">
  <div class="pl-stage">
    <video class="pl-v" playsinline preload="metadata"></video>
    <div class="pl-subs"></div>
    <div class="pl-dim"></div>
    <div class="pl-rip left"><span>-10s</span></div>
    <div class="pl-rip right"><span>+10s</span></div>
    <div class="pl-rip mid"><span>⏸</span></div>
    <div class="pl-note"></div>
    <div class="pl-load"><div class="spin"></div><b></b></div>
    <div class="pl-stats"></div>
    <div class="pl-count"><b></b><button class="chip">Cancelar</button></div>
    <div class="pl-skips"></div>
  </div>
  <div class="pl-ui">
    <div class="pl-top">
      <button class="ib" data-act="sheet" title="Voltar">←</button>
      <div class="pl-tt"><b></b><i></i></div>
      <button class="pl-lang" data-act="aud" title="Áudio e idioma"><b></b></button>
      <button class="ib" data-act="lock" title="Travar controles">🔓</button>
    </div>
    <div class="pl-mid">
      <button class="big" data-act="back" title="Retroceder">↺</button>
      <button class="big play" data-act="play" title="Reproduzir">▶</button>
      <button class="big" data-act="fwd" title="Avançar">↻</button>
    </div>
    <div class="pl-bot">
      <div class="pl-bar" data-bar>
        <div class="pl-buf"></div>
        <div class="pl-prog"></div>
        <div class="pl-marks"></div>
        <div class="pl-knob"></div>
        <div class="pl-tip"></div>
      </div>
      <div class="pl-row">
        <button class="ib" data-act="play">▶</button>
        <button class="ib" data-act="prev-ep">⏮</button>
        <button class="ib" data-act="next-ep">⏭</button>
        <span class="pl-time">0:00 / 0:00</span>
        <span class="grow"></span>
        <button class="ib" data-act="subs" title="Legenda">CC</button>
        <button class="ib" data-act="speed">1×</button>
        <button class="ib" data-act="aud" data-short title="Áudio">LEG</button>
        <button class="ib" data-act="volume">🔊</button>
        <button class="ib" data-act="menu" title="Mais opções">⋮</button>
        <button class="ib" data-act="theater">◱</button>
        <button class="ib" data-act="pip">⧉</button>
        <button class="ib" data-act="fs">⛶</button>
      </div>
    </div>
    <div class="pl-menu"><div class="pl-menu-h"><b></b><button class="ib" data-act="menu-close">✕</button></div><div class="pl-menu-b"></div></div>
    <div class="pl-side"><div class="pl-side-h"><b>Episódios</b><button class="ib" data-act="menu-close">✕</button></div>
      <input class="pl-side-f" type="text" placeholder="filtrar…"><div class="pl-side-b"></div></div>
  </div>
</div>`;

AF.Player = class Player {
    constructor(frame) {
        this.frame = frame;
        this.ctx = frame.ctx;
        this.eps = this.ctx.eps;
        this.epIdx = this.ctx.epIdx;
        this.tt = this.ctx.tt || AF.cfg.data.tt;      /* áudio que está tocando */
        this.pref = this.tt;                           /* áudio pedido: vale para o próximo episódio */
        this.sources = [];
        this.cur = null;
        this.hls = null;
        this.switching = false;
        this.rotating = false;
        this.state = 'idle';
        this.locked = false;
        this.theater = false;
        this.ab = null;
        this.statsOn = false;
        this.resumeAt = 0;
        this.skipped = {};
        this.sleep = null;
        this.timers = [];
        this.lastLog = '';
        this.subFilter = '';
        this.menuStack = [];
        /* legendas que não vieram da fonte (SubDL, arquivo importado): sobrevivem
           à troca automática de servidor, que recria this.subs.tracks do zero. */
        this.extraSubs = [];

        frame.node.innerHTML = UI;
        this.root = AF.$('.pl', frame.node);
        this.stage = AF.$('.pl-stage', this.root);
        this.v = AF.$('.pl-v', this.root);
        this.ui = AF.$('.pl-ui', this.root);
        this.noteEl = AF.$('.pl-note', this.root);
        this.loadEl = AF.$('.pl-load', this.root);
        this.statsEl = AF.$('.pl-stats', this.root);
        this.countEl = AF.$('.pl-count', this.root);
        this.bar = AF.$('[data-bar]', this.root);
        this.skipsEl = AF.$('.pl-skips', this.root);
        this.menu = AF.$('.pl-menu', this.root);
        this.side = AF.$('.pl-side', this.root);
        this.subs = new AF.Subs(AF.$('.pl-subs', this.root));
        this.subs.setStyle(AF.cfg.data.sub);
        this.subs.applyStyle();

        this.v.volume = AF.cfg.data.volume;
        this.v.muted = AF.cfg.data.muted;
        this.v.playbackRate = AF.cfg.data.rate;
        this.setDim(AF.cfg.data.dim);
        this.bind();
        this.tick();
    }

    /* ── infra ─────────────────────────────────────────────────────────────── */
    active() { return AF.nav.active() === this.frame && !this.destroyed; }

    every(ms, fn) {
        const id = setInterval(() => { if (!this.destroyed) fn(); }, ms);
        this.timers.push(id);
        return id;
    }

    after(ms, fn) {
        const id = setTimeout(() => { if (!this.destroyed) fn(); }, ms);
        this.timers.push(id);
        return id;
    }

    clearTimers() {
        this.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
        this.timers = [];
    }

    /* o áudio que está tocando de verdade (a fonte pode ter caído em outro) */
    curTT() { return (this.cur && this.cur.tt) || this.tt; }

    ep() { return this.eps[this.epIdx] || null; }
    epNum() { const e = this.ep(); return e ? String(e.number || e.episodeIdNum) : ''; }
    epKey() { return this.ctx.animeId + '@' + this.epNum(); }

    setLoad(text) {
        this.loadEl.style.display = text ? 'flex' : 'none';
        AF.$('b', this.loadEl).textContent = text || '';
    }

    note(html, ms = 2600, action) {
        this.noteEl.innerHTML = html;
        this.noteEl.style.display = html ? 'flex' : 'flex';
        this.noteEl.classList.add('show');
        clearTimeout(this._noteT);
        const close = () => { this.noteEl.classList.remove('show'); };
        if (action) {
            const b = AF.el('button', 'chip', action.label);
            b.onclick = () => { close(); action.run(); };
            this.noteEl.appendChild(b);
        }
        if (ms) this._noteT = setTimeout(close, ms);
    }

    flash(which, label) {
        const el = AF.$('.pl-rip.' + which, this.root);
        AF.$('span', el).textContent = label;
        el.classList.remove('go');
        void el.offsetWidth;
        el.classList.add('go');
    }

    setTitle() {
        const n = this.epNum();
        AF.$('.pl-tt b', this.root).textContent = this.ctx.animeName || this.ctx.animeId;
        AF.$('.pl-tt i', this.root).textContent =
            'Ep ' + n + (this.cur ? ' · ' + this.cur.server + (this.cur.quality ? ' · ' + this.cur.quality : '') : '');
        this.frame.title = '▶ ' + (this.ctx.animeName || '') + ' · Ep ' + n;
        const au = AF.AUDIO[this.curTT()] || AF.AUDIO.sub;
        AF.$$('.pl-row [data-short]', this.root).forEach(b => { b.textContent = au.short; });
        const pill = AF.$('.pl-lang b', this.root);
        if (pill) pill.textContent = au.label + (this.subs.idx >= 0 && this.subs.tracks[this.subs.idx] ? ' · legenda' : '');
        AF.nav.repaint();
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Ep ' + n + (this.ep() && this.ep().name ? ' — ' + this.ep().name : ''),
                    artist: this.ctx.animeName || '',
                    artwork: this.ctx.poster ? [{ src: AF.proxyUrl(this.ctx.poster, '') }] : [],
                });
            } catch (e) {}
        }
    }

    /* ── UI visível / auto-oculto ──────────────────────────────────────────── */
    showUI(stick) {
        this.ui.classList.add('on');
        clearTimeout(this._hide);
        if (stick || !this.v.paused) {
            this._hide = setTimeout(() => {
                if (!this.v.paused && !this.menu.classList.contains('on') &&
                    !this.side.classList.contains('on') && !this.locked) this.ui.classList.remove('on');
            }, AF.cfg.data.uiHide);
        }
    }

    /* ── ligações de evento ────────────────────────────────────────────────── */
    bind() {
        const v = this.v;

        this.root.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            this.showUI(true);
            const act = b.dataset.act;
            if (this.locked && act !== 'lock') return;
            this.act(act, b);
        });

        this.root.addEventListener('touchstart', () => this.showUI(), { passive: true });
        this.root.addEventListener('mousemove', () => this.showUI());

        ['play', 'pause'].forEach(ev => v.addEventListener(ev, () => {
            AF.$$('.ib[data-act="play"]', this.root).forEach(b => { b.textContent = v.paused ? '▶' : '❚❚'; });
            AF.$('.big.play', this.root).textContent = v.paused ? '▶' : '❚❚';
            if (!v.paused) { this.showUI(); this.keepAwake(); }
            else this.showUI(true);
        }));

        v.addEventListener('ended', () => this.onEnded());
        v.addEventListener('waiting', () => { this.state = 'buffering'; this.setLoad('carregando…'); });
        v.addEventListener('playing', () => { this.state = 'playing'; this.setLoad(''); });
        v.addEventListener('canplay', () => this.setLoad(v.paused ? '' : 'carregando…'));
        v.addEventListener('loadedmetadata', () => { this.state = 'ready'; this.paintBar(); });
        v.addEventListener('volumechange', () => this.paintVol());
        v.addEventListener('ratechange', () => { AF.$$('.ib[data-act="speed"]', this.root).forEach(b => b.textContent = v.playbackRate.toFixed(2).replace(/0$/, '').replace(/\.$/, '') + '×'); });
        v.addEventListener('error', () => this.onVideoError());

        v.addEventListener('enterpictureinpicture', () => AF.$('.ib[data-act="pip"]', this.root).classList.add('on'));
        v.addEventListener('leavepictureinpicture', () => AF.$('.ib[data-act="pip"]', this.root).classList.remove('on'));

        ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
            document.addEventListener(ev, () => {
                const fs = document.fullscreenElement || document.webkitFullscreenElement;
                this.root.classList.toggle('fs', !!fs);
            }));

        this.bindKeys();

        this.bindBar();
        this.bindGestures();
        this.every(400, () => this.tick());
        this.every(5000, () => this.saveProgress());
        this.showUI(true);
    }

    bindBar() {
        const bar = this.bar;
        const seek = e => {
            const r = bar.getBoundingClientRect();
            const p = AF.clamp((e.clientX - r.left) / r.width, 0, 1);
            AF.$('.pl-tip', bar).textContent = AF.clock(p * (this.v.duration || 0));
            AF.$('.pl-tip', bar).style.left = (p * 100) + '%';
            return p;
        };
        let dragging = false;
        const start = e => {
            if (this.locked) return;
            dragging = true;
            bar.classList.add('drag');
            const p = seek(e);
            const move = ev => { if (dragging) AF.$('.pl-prog', bar).style.width = (seek(ev) * 100) + '%'; };
            const up = ev => {
                dragging = false;
                bar.classList.remove('drag');
                const q = seek(ev);
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                this.seekTo(q * (this.v.duration || 0));
                this.paintBar();
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        };
        bar.addEventListener('pointerdown', start);
        bar.addEventListener('pointermove', e => { if (!dragging && e.pointerType === 'mouse') seek(e); });
    }

    bindGestures() {
        const stage = this.stage;
        let sx = 0, sy = 0, t0 = 0, mode = '', moved = false, lp = 0, origVol = 1, origDim = 100, wasRate = 1;

        const near = (x) => x < stage.clientWidth * 0.34 ? 'left' : (x > stage.clientWidth * 0.66 ? 'right' : 'mid');

        stage.addEventListener('pointerdown', e => {
            if (this.locked || this.destroyed || !this.v.src && !this.hls) return;
            sx = e.clientX; sy = e.clientY; t0 = Date.now(); moved = false; mode = '';
            origVol = this.v.volume; origDim = AF.cfg.data.dim; wasRate = this.v.playbackRate;
            if (!AF.cfg.data.gestures) return;
            lp = setTimeout(() => {
                if (!moved) {
                    mode = 'boost';
                    this.v.playbackRate = AF.cfg.data.longPressRate;
                    this.flash('mid', AF.cfg.data.longPressRate + '×');
                }
            }, 480);
        });

        stage.addEventListener('pointermove', e => {
            if (t0 === 0) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (Math.abs(dx) + Math.abs(dy) < 14) return;
            moved = true;
            clearTimeout(lp);
            if (!AF.cfg.data.gestures) return;
            if (mode !== 'boost' && !mode) mode = sx < stage.clientWidth / 2 ? 'dim' : 'vol';
            if (Math.abs(dx) > Math.abs(dy) * 1.6) mode = 'seek';
            if (mode === 'vol') {
                this.setVolume(AF.clamp(origVol - dy / stage.clientHeight, 0, 1));
            } else if (mode === 'dim') {
                this.setDim(AF.clamp(origDim - dy / stage.clientHeight * 90, 15, 100));
            } else if (mode === 'seek' && this.v.duration) {
                const delta = dx / stage.clientWidth * 70;
                AF.$('.pl-tip', this.bar).textContent = AF.clock(this.v.currentTime + delta);
                this._seekDelta = delta;
            }
        });

        const end = e => {
            clearTimeout(lp);
            if (mode === 'boost') { this.v.playbackRate = wasRate; this.flash('mid', wasRate + '×'); }
            else if (mode === 'seek') {
                const d = this._seekDelta || 0;
                this.seekTo(this.v.currentTime + d);
                this.flash(d < 0 ? 'left' : 'right', AF.longClock(Math.abs(d)));
                this._seekDelta = 0;
            } else if (moved) { this._seekDelta = 0; }
            else if (t0 && Date.now() - t0 < 260) this.tap(e);
            mode = ''; t0 = 0; moved = false;
        };
        stage.addEventListener('pointerup', end);
        stage.addEventListener('pointercancel', () => { clearTimeout(lp); mode = ''; t0 = 0; });
    }

    tap(e) {
        const now = Date.now();
        const zone = (e.clientX - this.stage.getBoundingClientRect().left);
        const side = zone < this.stage.clientWidth * 0.35 ? 'left' : zone > this.stage.clientWidth * 0.65 ? 'right' : 'mid';
        if (this._lastTap && now - this._lastTap < 320 && side === this._lastTapSide) {
            clearTimeout(this._tapDelay);
            this._lastTap = 0;
            if (side === 'mid') this.act('play');
            else if (AF.cfg.data.gestures) {
                this.seekBy((side === 'left' ? -1 : 1) * AF.cfg.data.seekStep);
                this.flash(side, side === 'left' ? '-' + AF.cfg.data.seekStep + 's' : '+' + AF.cfg.data.seekStep + 's');
            }
        } else {
            this._lastTap = now; this._lastTapSide = side;
            this._tapDelay = setTimeout(() => {
                this._lastTap = 0;
                if (this.ui.classList.contains('on') && !this.v.paused) this.ui.classList.remove('on');
                else this.showUI();
            }, 300);
        }
    }

    /* ── teclado ───────────────────────────────────────────────────────────── */
    onKey(e) {
        if (!this.active() || this.locked) return;
        const tag = (document.activeElement || {}).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const step = AF.cfg.data.seekStep;
        const k = e.key.toLowerCase();
        const map = {
            ' ': () => this.act('play'), k: () => this.act('play'),
            'j': () => this.seekBy(-step), 'l': () => this.seekBy(step),
            'arrowleft': () => this.seekBy(-5), 'arrowright': () => this.seekBy(5),
            'arrowup': () => this.setVolume(this.v.volume + 0.05),
            'arrowdown': () => this.setVolume(this.v.volume - 0.05),
            'm': () => this.act('mute'), 'f': () => this.act('fs'), 't': () => this.act('theater'),
            'a': () => this.act('aud'), 'c': () => this.act('subs'), 's': () => this.act('stats'), 'i': () => this.act('info'),
            'n': () => this.stepEp(1), 'p': () => this.stepEp(-1), 'b': () => this.act('pip'),
            'z': () => this.act('loop'), 'r': () => this.seekTo(0),
            ',': () => this.act('speed-'), '.': () => this.act('speed+'),
            '<': () => this.act('prev-ep'), '>': () => this.act('next-ep'),
            '?': () => AF.showHelp(), 'escape': () => { this.closeMenu(); this.ui.classList.remove('on'); },
        };
        if (/^[0-9]$/.test(k) && this.v.duration) {
            this.seekTo(this.v.duration * (parseInt(k, 10) / 10));
            this.showUI(true); e.preventDefault(); return;
        }
        const fn = map[k];
        if (!fn) return;
        e.preventDefault();
        fn();
        this.showUI(true);
    }

    /* ── fontes / reprodução ───────────────────────────────────────────────── */
    async loadEpisode(idx, opts = {}) {
        const ep = this.eps[idx];
        if (!ep) return;
        this.epIdx = idx;
        this.ctx.epIdx = idx;
        this.state = 'loading';
        this.skipped = {};
        this.ab = null;
        this.closeMenu();
        this.destroyMedia();
        this.setTitle();
        this.setLoad('procurando fontes do Ep ' + this.epNum() + '…');
        this.side.classList.remove('on');

        const h = AF.hist.get(this.ctx.animeId, this.epNum());
        const fromHist = (h && !h.done && h.t > 20 && (!h.d || h.t < h.d - 45)) ? h.t : 0;
        this.resumeAt = opts.at != null ? opts.at : fromHist;

        if (opts.tt) this.pref = opts.tt;
        if (this._lastEp !== idx) { this.extraSubs = []; this._autoKey = ''; }
        this._lastEp = idx;

        /* tenta o áudio pedido; se o episódio não tiver, desce a cadeia (dub PT-BR →
           legendado PT-BR → original → inglês) em vez de deixar a pessoa sem vídeo */
        const want = this.pref;
        if (opts.sources && opts.sources.length) {
            this.sources = opts.sources;
        } else {
            this.sources = [];
            const tried = [];
            const chain = this.ctx.single ? ['sub'] : (AF.AUDIO_CHAIN[want] || AF.AUDIO_CHAIN.sub);
            for (let i = 0; i < chain.length; i++) {
                const tt = chain[i];
                if (i > 0) this.setLoad('sem ' + AF.AUDIO[chain[i - 1]].label + ' — tentando ' + AF.AUDIO[tt].label + '…');
                const list = await this.fetchSources(tt, i === 0 ? (opts.server || AF.cfg.data.server || '') : '');
                if (this.destroyed || this.epIdx !== idx) return;
                if (list.length) { this.sources = list; this.tt = tt; break; }
                tried.push(AF.AUDIO[tt].label + ': ' + (this.lastLog || 'sem resposta'));
            }
            this.allLogs = tried.join(' | ');
        }
        if (this.sources.length && this.tt !== want && !opts.sources) {
            AF.toast('Este episódio não tem “' + AF.AUDIO[want].label + '”. Tocando: ' + AF.AUDIO[this.tt].label + '.', 5200,
                { label: 'áudio', run: () => this.act('aud') });
        }
        if (!this.sources.length) {
            this.setLoad('');
            this.note('<span class="bad">Ep ' + AF.esc(this.epNum()) + ' sem fonte jogável</span><small>' +
                AF.esc(this.allLogs || this.lastLog || 'nenhum servidor respondeu') + '</small>', 0,
                { label: 'tentar de novo', run: () => this.loadEpisode(idx, opts) });
            return;
        }
        this.setLoad('');
        this.renderSkipButtons();
        await this.tryAll();
        this.refreshSide();
    }

    async fetchSources(tt, server) {
        const path = (this.ctx.streamBase || '/anime/stream/') + encodeURIComponent(String(this.ctx.animeId).replace(/^ia:/, '')) +
            '?ep=' + encodeURIComponent(this.epNum()) + '&translationType=' + tt +
            '&title=' + encodeURIComponent(this.ctx.animeName || '') +
            (server ? '&server=' + encodeURIComponent(server) : '');
        try {
            const d = await AF.apiGet(path, { noCache: true });
            this.lastLog = (d.log || []).join(' | ');
            return (d.sources || []).map(s => Object.assign({}, s, { tt: s.translationType || tt }));
        } catch (e) {
            this.lastLog = e.message;
            return [];
        }
    }

    async tryAll() {
        /* um erro de mídia chega por dois caminhos (o listener do attach e o listener
           permanente do vídeo). Sem trava, duas rotações disputam o mesmo <video>.
           Quem chega depois não precisa de fila: a rotação em andamento já relê
           `_bad` a cada volta e vai pular a fonte que acabou de morrer. */
        if (this.rotating) return false;
        this.rotating = true;
        try {
            /* `switching` diz que estávamos no meio do playback. attach() lê keepAt antes
               de destroyMedia(), e destroyMedia zera currentTime — então na 2ª fonte o tempo
               já não está no element: precisa viajar capturado aqui. */
            const carry = this.switching ? (this.v.currentTime || 0) : 0;
            for (const s of this.sources) {
                if (s._bad) continue;
                this.setLoad('tentando ' + s.server + ' ' + (s.quality || '') + '…');
                this.switching = false;
                /* trocar de servidor no meio do playback tem de ser rápido: 32s parado
                   pareceria travamento. O prazo longo fica só para a primeira carga. */
                const ok = await this.attach(s, { carry, deadline: carry ? 12000 : 32000 });
                if (ok) { this.setLoad(''); this.setTitle(); return true; }
                s._bad = true;
            }
        } finally {
            this.rotating = false;
        }
        this.setLoad('');
        this.destroyMedia();
        this.note('<span class="bad">Nenhuma fonte reproduziu o Ep ' + AF.esc(this.epNum()) + '</span><small>' +
            AF.esc(this.lastLog || '') + '</small>', 0,
            { label: 'recarregar', run: () => this.reloadSources() });
        return false;
    }

    async reloadSources() {
        this.setLoad('relendo servidores…');
        this.sources = await this.fetchSources(this.tt, '');
        if (!this.sources.length) { this.setLoad(''); this.note('Ainda sem fontes.'); return; }
        await this.tryAll();
    }

    destroyMedia() {
        if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
        const v = this.v;
        try { v.pause(); } catch (e) {}
        v.removeAttribute('src');
        try { v.load(); } catch (e) {}
        this.cur = null;
        this.state = 'idle';
        this.subs.cues = null;
        this.subs.layer.textContent = '';
        this.subs.shown = '';
    }

    attach(src, opts = {}) {
        return new Promise(resolve => {
            const v = this.v;
            /* tryAll captura o tempo antes de destruir o media; sem isso o 2º attach
               lería currentTime=0 e o fallback começaria o episódio do zero. */
            const keepAt = opts.carry || (this.switching && v.duration ? v.currentTime : 0);
            this.destroyMedia();
            this.cur = src;
            const url = AF.proxyUrl(src.url, src.referer);
            let settled = false;
            let timer = 0;
            const off = () => {
                v.removeEventListener('loadeddata', win);
                v.removeEventListener('error', onErr);
                clearTimeout(timer);
            };
            const fail = () => { if (settled) return; settled = true; off(); if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; } resolve(false); };
            const onErr = () => { settled ? this.dieDuring(src) : fail(); };
            const win = async () => {
                if (settled) return;
                settled = true;
                off();
                this.loadSubTracks(src);
                if (src.poster) this.v.poster = AF.proxyUrl(src.poster, src.referer);
                if (this.ctx.epIdx < 0) this.ctx.epIdx = this.epIdx;
                if (this.resumeAt > 10) {
                    const at = this.resumeAt;
                    this.after(120, () => { try { v.currentTime = at; } catch (e) {} });
                    AF.toast('Continuando de ' + AF.clock(at), 4200, { label: 'do início', run: () => this.seekTo(0) });
                    this.resumeAt = 0;
                } else if (keepAt > 5) { try { v.currentTime = keepAt; } catch (e) {} }
                try { await v.play(); } catch (e) { this.note('toque em ▶ para iniciar', 3000); }
                this.setTitle();
                this.applyFit();
                this.saveProgress();
                resolve(true);
            };
            timer = setTimeout(fail, opts.deadline || 32000);
            v.addEventListener('loadeddata', win);
            v.addEventListener('error', onErr);

            if (src.type === 'hls' && window.Hls && Hls.isSupported()) {
                this.hls = new Hls({ maxBufferLength: 30, lowLatencyMode: false, enableWorker: true });
                this.hls.loadSource(url);
                this.hls.attachMedia(v);
                this.hls.on(Hls.Events.ERROR, (ev, d) => {
                    if (!d.fatal) return;
                    settled ? this.dieDuring(src) : fail();
                });
                this.hls.on(Hls.Events.MANIFEST_PARSED, () => this.renderQualityMenu());
            } else if (src.type === 'hls') {
                v.src = url;
            } else {
                v.src = url;
            }
        });
    }

    isPt(t) {
        const l = String(t.lang || '').toLowerCase();
        const lab = String(t.label || '').toLowerCase();
        return l.startsWith('pt') || lab.includes('pt-br') ||
            lab.includes('portuguese') || lab.includes('brasileir');
    }

    /* PT-BR primeiro, depois o que a API marcou como default, depois o resto.
       A ordem define o índice que fica salvo em cfg.sub.idx. */
    orderSubs(tracks) {
        const rank = t => this.isPt(t) ? 0 : (t.default ? 1 : 2);
        return tracks.slice().sort((a, b) => rank(a) - rank(b));
    }

    loadSubTracks(src) {
        const p = this._loadSubTracks(src);
        const all = (src.subs || []).concat(this.extraSubs);
        const hasPt = all.some(t => this.isPt(t));
        const tt = src.tt || src.translationType || this.tt;
        /* áudio original/inglês sem legenda em português: busca no SubDL sozinho */
        if (!hasPt && (tt === 'sub' || tt === 'dub') && AF.features.subdl &&
            AF.cfg.data.autoPtSub && AF.cfg.data.sub.on !== false) this.autoPtSubs();
        return p;
    }

    async autoPtSubs() {
        const key = this.epKey();
        if (this._autoKey === key) return;
        this._autoKey = key;
        const q = String(this.ctx.animeName || '').trim();
        if (!q) return;
        try {
            const d = await AF.apiGet('/subs/search?q=' + encodeURIComponent(q) +
                '&ep=' + encodeURIComponent(this.epNum()), { noCache: true });
            const res = d.results || [];
            const best = res.find(r => !r.machine_translated) || res[0];
            if (!best || key !== this.epKey() || this.destroyed) return;
            const text = await this.subFetch(best.url);
            if (key !== this.epKey() || this.destroyed) return;
            await this.pickSubTrack({ text, label: best.label, lang: 'pt-BR', token: best.token });
            this.note('Legenda em português carregada', 2600);
            this.setTitle();
        } catch (e) { /* silencioso: o menu de legenda continua com a busca manual */ }
    }

    _loadSubTracks(src) {
        const fromSrc = (src.subs || []).map(s => ({
            url: s.url, label: s.label || s.lang || 'legenda', lang: s.lang,
            referer: src.referer, default: !!s.default,
        }));
        const tracks = this.orderSubs(fromSrc.concat(this.extraSubs));
        this.subs.setTracks(tracks);
        const s = AF.cfg.data.sub;
        if (!tracks.length || s.on === false) {
            this.subs.select(-1);
            if (!tracks.length) s.idx = -1;
            AF.cfg.save();
            return;
        }
        /* cfg.sub.key sobrevive porque as fontes mudam de um servidor para o
           outro: depois do fallback automático o índice remembered pode apontar
           para outra legenda, o rótulo não. */
        let idx = s.key ? tracks.findIndex(t => t.label === s.key) : -1;
        if (idx < 0 && s.idx >= 0 && s.idx < tracks.length) idx = s.idx;
        if (idx < 0) {
            const pt = tracks.findIndex(t => this.isPt(t));
            const def = tracks.findIndex(t => t.default);
            idx = pt >= 0 ? pt : def >= 0 ? def : 0;
        }
        return this.subs.select(idx).then(n => {
            s.idx = idx;
            s.key = tracks[idx].label;
            s.on = idx >= 0;
            AF.cfg.save();
            if (!n) this.note('a legenda não tem falas', 2600);
        }).catch(() => {
            this.subs.layer.textContent = '';
            this.note('não deu para baixar a legenda', 2600);
        });
    }

    async subFetch(url) {
        const res = await fetch(AF.API_BASE + url, { cache: 'no-store' });
        if (!res.ok) {
            let d = '';
            try { d = (await res.json()).detail || ''; } catch (e) { d = 'HTTP ' + res.status; }
            throw new Error(d || 'HTTP ' + res.status);
        }
        return res.text();
    }

    /* Legenda que não veio da fonte entra no fim da lista e vira a selecionada.
       Sem setTracks() de propósito: aquilo limpa o cache de cues já parseadas. */
    async pickSubTrack(track) {
        if (!AF.parseCues(track.text || '').length) throw new Error('sem falas');
        track.extra = true;
        if (track.token && this.extraSubs.some(x => x.token === track.token)) return AF.parseCues(track.text).length;
        this.extraSubs.push(track);
        this.subs.tracks = this.subs.tracks.concat([track]);
        const i = this.subs.tracks.length - 1;
        try {
            const n = await this.subs.select(i);
            AF.cfg.data.sub.on = true;
            AF.cfg.data.sub.idx = i;
            AF.cfg.data.sub.key = track.label;
            AF.cfg.save();
            return n;
        } catch (e) {
            this.subs.select(-1);
            throw e;
        }
    }

    dieDuring(src) {
        /* um 'error' atrasado de uma fonte que já trocamos não pode reiniciar a rotina
           inteira: isso derrubaria o vídeo que está tocando agora. */
        if (!src || this.destroyed || src !== this.cur) return;
        src._bad = true;
        const rest = this.sources.filter(s => !s._bad);
        if (!rest.length) {
            this.destroyMedia();
            this.note('<span class="bad">As fontes acabaram</span>', 0,
                { label: 'recarregar', run: () => this.reloadSources() });
            return;
        }
        AF.toast('Fonte caiu — indo para ' + rest[0].server + ' ' + (rest[0].quality || ''));
        this.switching = true;
        this.tryAll();
    }

    onVideoError() {
        if (this.cur) this.dieDuring(this.cur);
    }

    onEnded() {
        AF.hist.done(this.ctx.animeId, this.epNum());
        const next = AF.queue.firstFor(this.ctx.animeId);
        if (next) {
            const i = this.eps.findIndex(e => String(e.number) === String(next.ep));
            AF.queue.remove(0);
            if (i >= 0) { this.loadEpisode(i); return; }
        }
        if (!AF.cfg.data.autoNext || this.epIdx >= this.eps.length - 1) {
            this.note('Fim do episódio.', 4000);
            return;
        }
        let left = 6;
        this.countEl.style.display = 'flex';
        AF.$('b', this.countEl).textContent = 'Próximo episódio em ' + left;
        const iv = setInterval(() => {
            left--;
            AF.$('b', this.countEl).textContent = 'Próximo episódio em ' + left;
            if (left <= 0) { clearInterval(iv); this.countEl.style.display = 'none'; this.loadEpisode(this.epIdx + 1); }
        }, 1000);
        this.timers.push(iv);
        AF.$('button', this.countEl).onclick = () => { clearInterval(iv); this.countEl.style.display = 'none'; this.showUI(true); };
    }

    stepEp(d) {
        const i = this.epIdx + d;
        if (i < 0 || i >= this.eps.length) { AF.toast('Não há outro episódio aqui'); return; }
        this.resumeAt = 0;
        this.loadEpisode(i);
    }

    /* ── controles ─────────────────────────────────────────────────────────── */
    seekTo(t) {
        const v = this.v;
        if (!v.duration) return;
        v.currentTime = AF.clamp(t, 0, v.duration - 0.5);
        if (this.hls) { try { this.hls.startLoad(); } catch (e) {} }
        this.paintBar();
    }

    seekBy(d) { this.seekTo(this.v.currentTime + d); this.flash(d < 0 ? 'left' : 'right', (d < 0 ? '-' : '+') + Math.abs(Math.round(d)) + 's'); }

    setVolume(x) {
        const v = this.v;
        v.volume = AF.clamp(x, 0, 1);
        v.muted = v.volume <= 0.001 ? true : v.muted;
        AF.cfg.set({ volume: v.volume });
        this.paintVol();
    }

    paintVol() {
        const icon = this.v.muted || this.v.volume <= 0.001 ? '🔇' : this.v.volume < 0.4 ? '🔉' : '🔊';
        AF.$$('.ib[data-act="volume"]', this.root).forEach(b => b.textContent = icon);
    }

    setDim(pct) {
        AF.$('.pl-dim', this.root).style.opacity = (100 - AF.clamp(pct, 15, 100)) / 130;
        AF.cfg.set({ dim: pct });
    }

    applyFit() {
        const fit = AF.cfg.data.fit;
        const fixed = (fit === '16:9' || fit === '4:3' || fit === '2.39:1');
        this.v.style.objectFit = fixed ? 'contain' : fit;
        this.v.style.aspectRatio = fixed ? fit : '';
        this.v.style.maxHeight = fixed ? '100%' : '';
    }

    paintBar() {
        const v = this.v;
        const d = v.duration || 0, t = v.currentTime || 0;
        AF.$('.pl-prog', this.root).style.width = (d ? t / d * 100 : 0) + '%';
        AF.$('.pl-knob', this.root).style.left = (d ? t / d * 100 : 0) + '%';
        let end = 0;
        try { for (let i = 0; i < v.buffered.length; i++) end = Math.max(end, v.buffered.end(i)); } catch (e) {}
        AF.$('.pl-buf', this.root).style.width = (d ? Math.min(100, end / d * 100) : 0) + '%';
        AF.$('.pl-time', this.root).textContent = AF.clock(t) + ' / ' + AF.clock(d);
    }

    tick() {
        if (!this.destroyed) {
            this.paintBar();
            if (this.cur) this.subs.render(this.v.currentTime || 0);
            this.autoSkip();
            this.abLoop();
            if (this.statsOn) this.paintStats();
        }
    }

    abLoop() {
        if (!this.ab || !this.ab.b) return;
        if (this.v.currentTime >= this.ab.b) {
            this.v.currentTime = this.ab.a;
            this.flash('mid', 'loop A–B');
        }
    }

    autoSkip() {
        const sk = (this.cur && this.cur.skip) || {};
        const v = this.v;
        if (!v.duration) return;
        const check = (kind, rng) => {
            if (!rng || rng.start == null || this.skipped[kind]) return;
            const end = rng.end || rng.start + 90;
            const key = kind === 'intro' ? 'autoSkipIntro' : 'autoSkipOutro';
            if (!AF.cfg.data[key]) return;
            if (v.currentTime >= rng.start && v.currentTime < end - 1) {
                this.skipped[kind] = true;
                this.seekTo(end + 0.5);
                this.note(kind === 'intro' ? 'intro pulada' : 'encerramento pulado', 2000,
                    { label: 'voltar', run: () => { this.seekTo(rng.start); this.skipped[kind] = false; } });
            }
        };
        check('intro', sk.intro);
        check('outro', sk.outro);
    }

    renderSkipButtons() {
        this.skipsEl.innerHTML = '';
        const sk = (this.cur && this.cur.skip) || {};
        const mk = (label, at, to) => {
            if (at == null) return;
            const b = AF.el('button', 'chip skip-go', label);
            b.onclick = () => { this.seekTo(to); this.skipped[label.includes('intro') ? 'intro' : 'outro'] = true; };
            b.dataset.at = at;
            b.dataset.to = to;
            this.skipsEl.appendChild(b);
        };
        mk('pular intro', sk.intro && sk.intro.start, sk.intro && (sk.intro.end || (sk.intro.start || 0) + 90));
        mk('pular open.', sk.outro && sk.outro.start, sk.outro && (sk.outro.end || (sk.outro.start || 0) + 90));
        this.every(600, () => {
            AF.$$('.skip-go', this.skipsEl).forEach(b => {
                const at = Number(b.dataset.at), to = Number(b.dataset.to);
                b.style.display = (this.v.currentTime >= at - 2 && this.v.currentTime < to) ? '' : 'none';
            });
        });
    }

    saveProgress() {
        const v = this.v;
        if (!v.duration || v.currentTime < 3) return;
        const ratio = v.currentTime / v.duration;
        if (ratio > 0.95) AF.hist.done(this.ctx.animeId, this.epNum());
        else AF.hist.touch(this.ctx.animeId, this.epNum(), {
            t: v.currentTime, d: v.duration, animeId: this.ctx.animeId,
            anime: this.ctx.animeName, thumb: this.ctx.poster, epNum: this.epNum(),
            tt: this.tt, server: this.cur && this.cur.server, quality: this.cur && this.cur.quality,
            url: this.ctx.animeId,
        });
    }

    /* ── ações dos botões ──────────────────────────────────────────────────── */
    act(a, btn) {
        const v = this.v;
        switch (a) {
            case 'play': v.paused ? v.play().catch(() => this.note('toque de novo', 2000)) : v.pause(); break;
            case 'back': this.seekBy(-AF.cfg.data.seekStep); break;
            case 'fwd': this.seekBy(AF.cfg.data.seekStep); break;
            case 'prev-ep': case 'next-ep': this.stepEp(a === 'next-ep' ? 1 : -1); break;
            case 'mute': v.muted = !v.muted; AF.cfg.set({ muted: v.muted }); this.paintVol(); break;
            case 'volume': this.openMenu(this.menuVolume()); break;
            case 'speed': this.openMenu(this.menuSpeed()); break;
            case 'speed+': v.playbackRate = AF.clamp(v.playbackRate + 0.25, 0.25, 3); AF.cfg.set({ rate: v.playbackRate }); break;
            case 'speed-': v.playbackRate = AF.clamp(v.playbackRate - 0.25, 0.25, 3); AF.cfg.set({ rate: v.playbackRate }); break;
            case 'subs': this.openMenu(this.menuSubs()); break;
            case 'aud': this.openMenu(this.menuAudio()); break;
            case 'menu': this.openMenu(this.menuMain()); break;
            case 'menu-close': this.closeMenu(); break;
            case 'sheet':
                if (this.menuStack.length > 1) this.popMenu();
                else if (this.menu.classList.contains('on') || this.side.classList.contains('on')) this.closeMenu();
                else this.menuEpisodes();
                break;
            case 'theater': this.toggleTheater(); break;
            case 'fs': this.toggleFs(); break;
            case 'pip': this.togglePip(); break;
            case 'lock': this.toggleLock(); break;
            case 'stats': this.statsOn = !this.statsOn; this.statsEl.style.display = this.statsOn ? 'block' : 'none'; break;
            case 'info': this.openMenu(this.menuInfo()); break;
            case 'loop':
                if (!this.ab) this.ab = { a: v.currentTime, b: 0 };
                else if (!this.ab.b) this.ab.b = Math.max(v.currentTime, this.ab.a + 2);
                else this.ab = null;
                this.note(this.ab ? (this.ab.b ? 'loop A–B ativo' : 'ponto A marcado') : 'loop desligado', 2000);
                break;
            case 'snap': this.snapshot(); break;
            case 'close-player': AF.nav.back(); break;
            case 'go-anime': AF.nav.toAnime(this.ctx.animeId); break;
            default: break;
        }
    }

    toggleLock() {
        this.locked = !this.locked;
        AF.$('.ib[data-act="lock"]', this.root).textContent = this.locked ? '🔒' : '🔓';
        this.ui.classList.toggle('locked', this.locked);
        this.showUI(true);
    }

    toggleTheater() {
        this.theater = !this.theater;
        this.frame.node.classList.toggle('theater', this.theater);
        AF.$('.ib[data-act="theater"]', this.root).classList.toggle('on', this.theater);
    }

    /* abre o episódio já em tela cheia e deitado (só em celular/tablet) */
    autoFullscreen() {
        if (!AF.cfg.data.autoFs || !window.matchMedia || !matchMedia('(pointer: coarse)').matches) return;
        const el = this.root;
        if (document.fullscreenElement || document.webkitFullscreenElement) return;
        const lock = () => {
            try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* sem suporte */ }
        };
        if (window.Android && window.Android.setLandscape) { try { window.Android.setLandscape(true); } catch (e) {} }
        const p = el.requestFullscreen ? el.requestFullscreen() :
            (el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null);
        if (p && p.then) p.then(lock).catch(() => {}); else lock();
    }

    releaseOrientation() {
        try { screen.orientation.unlock(); } catch (e) { /* sem suporte */ }
        if (window.Android && window.Android.setLandscape) { try { window.Android.setLandscape(false); } catch (e) {} }
    }

    toggleFs() {
        const el = this.root;
        const isFs = () => document.fullscreenElement || document.webkitFullscreenElement;
        if (!isFs()) {
            const p = el.requestFullscreen ? el.requestFullscreen() :
                (el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null);
            if (p && p.catch) p.catch(() => { this.toggleTheater(); AF.toast('Tela cheia indisponível — modo cinema ativado'); });
            if (!p) { this.toggleTheater(); AF.toast('Tela cheia indisponível'); }
        } else if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }

    togglePip() {
        if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
        /* O WebView do Android não expõe picture-in-picture para a página, então
           `pictureInPictureEnabled` é false mesmo com o app suportando PiP. A ponte
           nativa é o caminho real no APK; a API web é o caminho no navegador. */
        if (window.Android && window.Android.enterPip) {
            this.v.play().catch(() => {});
            window.Android.enterPip(this.v.videoWidth || 16, this.v.videoHeight || 9);
            return;
        }
        if (!document.pictureInPictureEnabled || !this.v.requestPictureInPicture) {
            AF.toast('PiP indisponível aqui — abra o app no Android 8+');
            return;
        }
        this.v.requestPictureInPicture().catch(e => AF.toast('PiP falhou: ' + e.message));
    }

    snapshot() {
        try {
            const c = document.createElement('canvas');
            c.width = this.v.videoWidth || 1280; c.height = this.v.videoHeight || 720;
            c.getContext('2d').drawImage(this.v, 0, 0, c.width, c.height);
            const a = document.createElement('a');
            a.href = c.toDataURL('image/png');
            a.download = (this.ctx.animeName || 'anime') + ' ep' + this.epNum() + '.png';
            a.click();
            AF.toast('Foto do quadro salva');
        } catch (e) { AF.toast('Não foi possível salvar o quadro (CORS do vídeo)'); }
    }

    keepAwake() {
        if (!('wakeLock' in navigator) || this._wl) return;
        navigator.wakeLock.request('screen').then(l => {
            this._wl = l;
            l.addEventListener('release', () => { this._wl = null; });
        }).catch(() => {});
    }

    /* ── menus ─────────────────────────────────────────────────────────────── */
    openMenu(page) {
        this.menuStack = [page];
        this.drawMenu();
        this.menu.classList.add('on');
        this.side.classList.remove('on');
        this.showUI(true);
    }

    pushMenu(page) { this.menuStack.push(page); this.drawMenu(); }
    popMenu() { if (this.menuStack.length > 1) { this.menuStack.pop(); this.drawMenu(); } else this.closeMenu(); }

    closeMenu() {
        this.menu.classList.remove('on');
        this.side.classList.remove('on');
        this.menuStack = [];
    }

    drawMenu() {
        const page = this.menuStack[this.menuStack.length - 1] || { title: '', items: [] };
        AF.$('.pl-menu-h b', this.root).textContent = page.title || '';
        const body = AF.$('.pl-menu-b', this.root);
        body.innerHTML = '';
        page.items.forEach(it => {
            if (it.sep) { body.appendChild(AF.el('div', 'mi-sep')); return; }
            if (it.head) { body.appendChild(AF.el('div', 'mi head', AF.esc(it.head))); return; }
            const row = AF.el('button', 'mi' + (it.on ? ' on' : ''));
            row.innerHTML = (it.on ? '<span class="dot"></span>' : '<span class="dot none"></span>') +
                '<span class="lab">' + (it.html == null ? '' : it.html) + '</span>' +
                (it.right ? '<span class="rgt">' + it.right + '</span>' : it.page ? '<span class="rgt">›</span>' : '');
            row.onclick = () => {
                if (it.page) this.pushMenu(it.page());
                else if (it.run) { it.run(); if (it.keepOpen !== true) this.drawMenu(); }
            };
            body.appendChild(row);
        });
        if (page.back !== false) {
            const b = AF.el('button', 'mi back', '<span class="dot none"></span><span class="lab">← voltar</span>');
            b.onclick = () => this.popMenu();
            body.appendChild(b);
        }
    }

    renderQualityMenu() { if (this.menu.classList.contains('on')) this.drawMenu(); }

    menuVolume() {
        const pct = Math.round(this.v.volume * 100);
        const items = [
            { head: 'Atual: ' + pct + '%' + (this.v.muted ? ' (mudo)' : '') },
            { html: this.v.muted ? 'Ativar áudio' : 'Silenciar', on: this.v.muted,
              run: () => { this.act('mute'); this.drawMenu(); } },
            { sep: true },
        ];
        [0, 10, 25, 40, 60, 80, 100].forEach(p => items.push({
            html: p + '%', on: Math.abs(pct - p) < 5,
            run: () => { this.v.muted = p <= 0; this.setVolume(p / 100); this.drawMenu(); },
        }));
        items.push({ sep: true },
            { html: '⬆ ⬇ no teclado ajustam 5%', run: null });
        return { title: 'Volume', items };
    }

    menuSpeed() {
        const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
        return { title: 'Velocidade de reprodução', items: rates.map(r => ({
            html: r + '×', on: Math.abs(this.v.playbackRate - r) < 0.01,
            run: () => { this.v.playbackRate = r; AF.cfg.set({ rate: r }); },
        })) };
    }

    menuAudio() {
        const now = this.curTT();
        const av = this.ctx.audios || {};
        const items = [{ head: 'Áudio e idioma' }];
        ['dub-pt', 'sub-pt', 'sub', 'dub'].forEach(k => {
            const a = AF.AUDIO[k];
            items.push({
                html: AF.esc(a.label), right: av[k] === false ? 'indisponível' : '',
                on: now === k, run: () => this.switchAudio(k),
            });
        });
        items.push({ head: a_hint(now) });
        items.push({ sep: true });
        items.push({ html: 'Legenda', page: () => this.menuSubs() });
        items.push({ html: 'Servidor: ' + AF.esc((this.cur && this.cur.server) || '—'), page: () => this.menuServers() });
        items.push({ html: 'Qualidade', page: () => this.menuQuality() });
        return { title: 'Áudio', items };
        function a_hint(k) { return AF.AUDIO[k] ? AF.AUDIO[k].hint : ''; }
    }

    /* troca o áudio SEM largar o vídeo atual se o novo não existir */
    async switchAudio(tt) {
        if (this.curTT() === tt) return;
        const at = this.v.currentTime || 0;
        this.setLoad('procurando ' + AF.AUDIO[tt].label + '…');
        const list = await this.fetchSources(tt, '');
        this.setLoad('');
        if (!list.length) {
            AF.toast('Este episódio não tem “' + AF.AUDIO[tt].label + '”.' + (this.lastLog ? ' ' + this.lastLog.slice(0, 90) : ''), 5200);
            return;
        }
        AF.cfg.set({ tt });
        this.tt = this.pref = tt;
        this.closeMenu();
        this.loadEpisode(this.epIdx, { tt, at, sources: list });
    }

    menuServers() {
        const names = [...new Set(this.sources.map(s => s.server))];
        return { title: 'Servidor', items: names.map(n => ({
            html: AF.esc(n), on: this.cur && this.cur.server === n,
            run: async () => {
                this.switching = true;
                let list = this.sources.filter(s => s.server === n);
                if (!list.length) list = await this.fetchSources(this.tt, n);
                if (!list.length) { AF.toast(n + ' não devolveu fonte'); return; }
                list.forEach(s => { if (!this.sources.includes(s)) this.sources.push(s); });
                if (await this.attach(list[0])) return;
                list.forEach(s => s._bad = true);
                AF.toast(n + ' falhou ao reproduzir');
            },
        })) };
    }

    menuQuality() {
        const items = [];
        if (this.hls) {
            const levels = this.hls.levels || [];
            items.push({ html: 'auto (por rede)', on: this.hls.autoLevelEnabled || this.hls.currentLevel < 0,
                run: () => { this.hls.nextLevel = -1; } });
            levels.slice().sort((a, b) => (b.height || 0) - (a.height || 0)).forEach(l => {
                const i = levels.indexOf(l);
                items.push({ html: (l.height ? l.height + 'p' : Math.round((l.bitrate || 0) / 1000) + 'k'),
                    on: !this.hls.autoLevelEnabled && this.hls.currentLevel === i,
                    run: () => { this.hls.currentLevel = i; AF.toast('Qualidade travada em ' + (l.height || '?') ); } });
            });
        }
        const same = this.sources.filter(s => s.server === (this.cur && this.cur.server) && s.quality);
        same.forEach(s => items.push({ html: AF.esc(s.server + ' ' + s.quality), on: this.cur === s,
            run: () => { this.switching = true; this.attach(s); } }));
        if (!items.length) items.push({ html: 'este servidor só tem uma qualidade' });
        return { title: 'Qualidade', items };
    }

    menuSubs() {
        const tracks = this.subs.tracks;
        const items = [{ html: 'sem legenda', on: this.subs.idx < 0, run: async () => { await this.subs.select(-1); AF.cfg.data.sub.on = false; AF.cfg.save(); } }];
        tracks.forEach((t, i) => items.push({
            html: AF.esc(t.label || ('legenda ' + (i + 1))), on: this.subs.idx === i,
            run: async () => {
                try { const n = await this.subs.select(i); AF.toast(n ? n + ' falas carregadas' : 'legenda vazia'); }
                catch (e) { AF.toast('não deu para baixar a legenda: ' + e.message); }
                AF.cfg.data.sub.on = true; AF.cfg.data.sub.idx = i; AF.cfg.save();
            },
        }));
        if (!tracks.length) items.push({ html: 'esta fonte não trouxe legenda' });
        items.push({ head: 'em português' });
        items.push(AF.features.subdl
            ? { html: 'Buscar legenda PT-BR', run: () => this.searchSubdl() }
            : { html: 'Busca automática indisponível neste servidor', right: 'use arquivo', run: null });
        items.push({ html: 'Importar arquivo…', run: () => this.importSub() });
        if (this.extraSubs.length) {
            items.push({ html: 'limpar legendas extras', right: String(this.extraSubs.length),
                run: () => {
                    this.extraSubs = [];
                    this.subs.select(-1);
                    AF.cfg.data.sub.on = false;
                    AF.cfg.data.sub.idx = -1;
                    AF.cfg.data.sub.key = '';
                    AF.cfg.save();
                    AF.toast('tirei as legendas que você acrescentou');
                    this.drawMenu();
                } });
        }
        items.push({ head: 'apariência' });
        items.push({ html: 'estilo e atraso', page: () => this.menuSubStyle() });
        return { title: 'Legenda', items };
    }

    /* a legenda do SubDL que já está na tela — o token é estável, o rótulo não */
    usedExtra(t) { return !!t.token && this.extraSubs.some(x => x.token === t.token); }

    async searchSubdl() {
        const q = String(this.ctx.animeName || (this.ctx.card && this.ctx.card.name) || '').trim();
        if (!q) { AF.toast('não sei o título deste anime para buscar'); return; }
        const ep = this.epNum();
        this.setLoad('buscando legenda PT-BR…');
        let res;
        try {
            const d = await AF.apiGet('/subs/search?q=' + encodeURIComponent(q) +
                '&ep=' + encodeURIComponent(ep), { noCache: true });
            res = d.results || [];
        } catch (e) {
            this.setLoad('');
            /* 501 e 401 já vêm do servidor com a frase do que fazer (SUBDL_KEY). */
            AF.toast(e.message, e.status === 501 ? 7000 : 3800);
            return;
        }
        this.setLoad('');
        if (!res.length) {
            AF.toast('nenhuma legenda PT-BR para "' + q + '"' + (ep ? ' Ep ' + ep : ''));
            return;
        }
        this.pushMenu({ title: 'SubDL · ' + res.length + ' opções', items: res.slice(0, 15).map(r => ({
            html: AF.esc(r.label),
            right: r.downloads ? '↓' + r.downloads : r.machine_translated ? 'máquina' : '',
            on: this.usedExtra(r),
            run: () => this.useSubdl(r),
        })) });
    }

    async useSubdl(r) {
        this.setLoad('baixando legenda…');
        let text = '';
        try {
            /* AF.API_BASE + url, nunca proxyUrl: /subs/file é desta origem e o
               /proxy recusaria o próprio localhost. A chave fica no servidor. */
            text = await this.subFetch(r.url);
        } catch (e) {
            this.setLoad('');
            AF.toast(e.message, 6000);
            return;
        }
        this.setLoad('');
        try {
            const n = await this.pickSubTrack({ text, label: r.label, lang: 'pt-BR', token: r.token });
            AF.toast(n + ' falas PT-BR de ' + r.label);
        } catch (e) {
            AF.toast('essa legenda veio sem falas');
        }
        this.drawMenu();
    }

    importSub() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.srt,.vtt,text/plain';
        inp.style.display = 'none';
        this.root.appendChild(inp);
        inp.onchange = () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (!f) return;
            const fr = new FileReader();
            fr.onerror = () => AF.toast('não consegui ler ' + f.name);
            fr.onload = async () => {
                const name = String(f.name || 'legenda');
                try {
                    const n = await this.pickSubTrack({
                        text: String(fr.result || ''),
                        label: name,
                        lang: /pt[-_]?br|portug|brasileir/i.test(name) ? 'pt-BR' : '',
                    });
                    AF.toast(n + ' falas de ' + name);
                } catch (e) {
                    AF.toast('isto não parece uma legenda .srt/.vtt');
                }
                this.drawMenu();
            };
            fr.readAsText(f);
        };
        inp.click();
    }

    menuSubStyle() {
        const s = AF.cfg.data.sub;
        const step = (html, d) => ({ html, run: () => { AF.cfg.setSub({ size: AF.clamp(s.size + d, 60, 260) }); this.subs.setStyle(AF.cfg.data.sub); } });
        return { title: 'Estilo da legenda', items: [
            step('tamanho: ' + s.size + '%  (−10)', -10),
            step('tamanho: ' + s.size + '%  (+10)', 10),
            { html: 'atraso: ' + s.delay + ' ms  (−250)', run: () => { AF.cfg.setSub({ delay: s.delay - 250 }); this.subs.setStyle(AF.cfg.data.sub); } },
            { html: 'atraso: ' + s.delay + ' ms  (+250)', run: () => { AF.cfg.setSub({ delay: s.delay + 250 }); this.subs.setStyle(AF.cfg.data.sub); } },
            { html: 'fundo da caixa', on: s.box, run: () => { AF.cfg.setSub({ box: !s.box }); this.subs.setStyle(AF.cfg.data.sub); } },
            { html: 'contorno', on: s.outline, run: () => { AF.cfg.setSub({ outline: !s.outline }); this.subs.setStyle(AF.cfg.data.sub); } },
            { head: 'cor' },
            ...['#ffffff', '#ffd479', '#7dd3fc', '#86efac', '#f9a8d4'].map(c => ({
                html: '<i class="sw" style="background:' + c + '"></i> ' + c, on: s.color === c,
                run: () => { AF.cfg.setSub({ color: c }); this.subs.setStyle(AF.cfg.data.sub); } })),
            { head: 'altura na tela' },
            ...[[70, 'alta'], [80, 'média'], [90, 'baixa'], [95, 'bem baixa']].map(([p, nm]) => ({ html: 'posição ' + nm, on: s.pos === p, run: () => { AF.cfg.setSub({ pos: p }); this.subs.setStyle(AF.cfg.data.sub); } })),
        ] };
    }

    menuSleep() {
        const mins = [10, 20, 30, 45, 60, 90];
        const items = [{ html: 'desligar timer', on: !this.sleep, run: () => this.setSleep(0) }];
        mins.forEach(m => items.push({ html: 'parar em ' + m + ' min', on: this.sleep === m, run: () => this.setSleep(m) }));
        if (this.sleepLeft) items.push({ html: 'restam ' + AF.longClock(this.sleepLeft / 1000) });
        return { title: 'Dormir', items };
    }

    setSleep(min) {
        clearTimeout(this._sleep);
        this.sleep = min;
        if (!min) { AF.toast('timer desativado'); return; }
        this._sleep = setTimeout(() => {
            const fade = setInterval(() => {
                this.v.volume = Math.max(0, this.v.volume - 0.05);
                if (this.v.volume <= 0) { clearInterval(fade); this.v.pause(); AF.toast('Timer de sono: pausa.'); }
            }, 120);
            this.timers.push(fade);
        }, min * 60000);
        const start = Date.now();
        this.sleepLeft = min * 60000;
        const iv = setInterval(() => { this.sleepLeft = min * 60000 - (Date.now() - start); }, 1000);
        this.timers.push(iv);
        AF.toast('Vai pausar em ' + min + ' min');
    }

    menuMain() {
        const c = AF.cfg.data;
        return { title: 'Mais opções', items: [
            { head: 'reprodução' },
            { html: 'Qualidade', page: () => this.menuQuality() },
            { html: 'Servidor', page: () => this.menuServers() },
            { html: 'Áudio e idioma', right: AF.esc((AF.AUDIO[this.curTT()] || AF.AUDIO.sub).short), page: () => this.menuAudio() },
            { html: 'Velocidade', page: () => this.menuSpeed() },
            { html: 'Legenda', page: () => this.menuSubs() },
            { html: 'Volume', page: () => this.menuVolume() },
            { html: 'Picture-in-picture', run: () => this.togglePip() },
            { html: 'Pular intro automático', on: c.autoSkipIntro, run: () => AF.cfg.set({ autoSkipIntro: !c.autoSkipIntro }) },
            { html: 'Pular encerramento automático', on: c.autoSkipOutro, run: () => AF.cfg.set({ autoSkipOutro: !c.autoSkipOutro }) },
            { html: 'Próximo episódio automático', on: c.autoNext, run: () => AF.cfg.set({ autoNext: !c.autoNext }) },
            { html: 'Loop A–B (tecla z)', right: this.ab ? (this.ab.b ? 'A✓ B✓' : 'A✓') : '—', run: () => this.act('loop') },
            { head: 'tela' },
            { html: 'Encaixe: ' + c.fit, page: () => this.menuFit() },
            { html: 'Brilho do quadro', right: c.dim + '%', page: () => this.menuDim() },
            { html: 'Modo cinema (tecla t)', on: this.theater, run: () => this.toggleTheater() },
            { html: 'Estatísticas (tecla s)', on: this.statsOn, run: () => this.act('stats') },
            { html: 'Foto do quadro', run: () => this.snapshot() },
            { head: 'sessão' },
            { html: 'Dormir / timer', page: () => this.menuSleep() },
            { html: 'Passos de seek', right: c.seekStep + 's', page: () => this.menuSeekStep() },
            { html: 'Fila de episódios', page: () => this.menuQueue() },
            { html: 'Ficha do anime', run: () => this.act('go-anime') },
            { html: 'Atalhos de teclado', run: () => AF.showHelp() },
            { html: 'Fechar o player', run: () => this.act('close-player') },
        ] };
    }

    menuFit() {
        const list = ['contain', 'cover', '16:9', '4:3', '2.39:1'];
        return { title: 'Encaixe do vídeo', items: list.map(f => ({
            html: f === 'contain' ? 'manter proporção' : f === 'cover' ? 'preencher (corta)' : 'esticar ' + f,
            on: AF.cfg.data.fit === f, run: () => { AF.cfg.set({ fit: f }); this.applyFit(); } })) };
    }

    menuDim() {
        return { title: 'Brilho do quadro', items: [25, 50, 75, 90, 100].map(p => ({
            html: p + '%', on: AF.cfg.data.dim === p, run: () => this.setDim(p) })) };
    }

    menuSeekStep() {
        return { title: 'Salto de seek', items: [5, 10, 15, 30, 60].map(s => ({
            html: s + ' segundos', on: AF.cfg.data.seekStep === s, run: () => AF.cfg.set({ seekStep: s }) })) };
    }

    menuInfo() {
        const s = this.cur || {};
        return { title: 'Fonte atual', back: true, items: [
            { html: 'servidor: ' + AF.esc(s.server || '—'), run: null },
            { html: 'hospedagem: ' + AF.esc(s.host || '—'), run: null },
            { html: 'tipo: ' + AF.esc(s.type || '—') + ' ' + AF.esc(s.quality || ''), run: null },
            { html: 'áudio: ' + AF.esc((AF.AUDIO[this.curTT()] || AF.AUDIO.sub).label), run: null },
            { html: 'legendas: ' + this.subs.tracks.length, run: null },
            { html: 'duração: ' + AF.clock(this.v.duration || 0), run: null },
            { html: 'copiar URL do source', run: () => { navigator.clipboard && navigator.clipboard.writeText(s.url || '').then(() => AF.toast('copiado')).catch(() => AF.toast('clipboard bloqueado')); } },
        ] };
    }

    menuQueue() {
        const items = AF.queue.items.slice(0, 30).map((q, i) => ({
            html: AF.esc((q.anime || q.animeId) + ' · Ep ' + q.ep),
            right: q.animeId === this.ctx.animeId ? 'desta série' : 'fila',
            run: () => {
                AF.queue.remove(i);
                if (q.animeId === this.ctx.animeId) {
                    const j = this.eps.findIndex(e => String(e.number) === String(q.ep));
                    if (j >= 0) this.loadEpisode(j);
                } else AF.openAnimeByCard(q, { playEp: q.ep });
            },
        }));
        if (!items.length) items.push({ html: 'a fila está vazia — use "assistir depois" na ficha do anime' });
        items.push({ html: 'limpar fila desta série', run: () => { AF.queue.clear(this.ctx.animeId); this.pushMenu(this.menuQueue()); } });
        return { title: 'Fila', items };
    }

    menuEpisodes() {
        this.side.classList.add('on');
        this.menu.classList.remove('on');
        this.refreshSide();
    }

    refreshSide() {
        if (!this.side.classList.contains('on')) return;
        const body = AF.$('.pl-side-b', this.side);
        body.innerHTML = '';
        this.eps.forEach((e, i) => {
            const num = String(e.number || AF.epNumber(e));
            if (this.subFilter && !num.includes(this.subFilter)) return;
            const b = AF.el('button', 'se' + (i === this.epIdx ? ' on' : ''));
            b.innerHTML = '<b>' + AF.esc(num) + '</b><i>' + AF.esc(e.name || '') + '</i>';
            b.onclick = () => { this.resumeAt = 0; this.loadEpisode(i); };
            body.appendChild(b);
        });
    }

    /* ── ciclo de vida por aba ─────────────────────────────────────────────── */
    onHide() {
        this.saveProgress();
        try { this.v.pause(); } catch (e) {}
        if (this.hls) { try { this.hls.stopLoad(); } catch (e) {} }
        clearTimeout(this._hide);
    }

    onShow() {
        if (this.hls) { try { this.hls.startLoad(); } catch (e) {} }
        this.showUI(true);
        this.bindKeys();
    }

    bindKeys() {
        if (this._keyFn) return;
        this._keyFn = e => this.onKey(e);
        document.addEventListener('keydown', this._keyFn);
    }

    unbindKeys() {
        if (!this._keyFn) return;
        document.removeEventListener('keydown', this._keyFn);
        this._keyFn = null;
    }

    destroy() {
        this.destroyed = true;
        this.releaseOrientation();
        this.saveProgress();
        this.clearTimers();
        this.destroyMedia();
        this.unbindKeys();
        if (this._wl) { try { this._wl.release(); } catch (e) {} }
    }

    paintStats() {
        const v = this.v;
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
        let buf = 0;
        try { for (let i = 0; i < v.buffered.length; i++) buf = Math.max(buf, v.buffered.end(i) - v.currentTime); } catch (e) {}
        const lvl = this.hls && this.hls.levels && this.hls.levels[this.hls.currentLevel];
        this.statsEl.innerHTML = [
            ['resolução', (v.videoWidth || '?') + '×' + (v.videoHeight || '?')],
            ['fps real', q.totalVideoFrames ? (q.totalVideoFrames / Math.max(1, v.currentTime)).toFixed(1) : '—'],
            ['quadros perdidos', q.droppedVideoFrames || 0],
            ['buffer à frente', buf.toFixed(1) + ' s'],
            ['bitrate nível', lvl ? Math.round(lvl.bitrate / 1000) + ' kbps' : '—'],
            ['nível', this.hls ? (this.hls.autoLevelEnabled ? 'auto' : this.hls.currentLevel) : 'direto'],
            ['hospedagem', (this.cur && this.cur.host) || '—'],
            ['speed', v.playbackRate + '×'],
        ].map(([k, val]) => '<div><span>' + k + '</span><b>' + AF.esc(val) + '</b></div>').join('');
    }
};
