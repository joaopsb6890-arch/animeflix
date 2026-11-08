/* AnimeFlix — pilha de navegação: catálogo → ficha → player, com botão voltar. */
(function (AF) {
    const el = AF.el, esc = AF.esc, $ = AF.$;

    /* uma pilha funda consome DOM; ao estourar, o frame do meio sai, nunca o topo */
    const MAX_FRAMES = 6;

    const nav = AF.nav = {
        list: [],
        seq: 1,
        views: null,

        init() {
            this.views = $('#views');
            const b = $('#backBtn');
            if (b) b.onclick = () => { if (!AF.nav.back()) AF.toast('voltar de novo para sair'); };
            this.push('home');
            this.buildTabbar();
        },

        /* barra inferior: só aparece no catálogo (a ficha e o player usam a tela toda) */
        buildTabbar() {
            const bar = $('#tabbar');
            if (!bar) return;
            const tabs = [['home', 'Início'], ['search', 'Buscar'], ['movies', 'Filmes'], ['list', 'Minha lista'], ['more', 'Mais']];
            bar.innerHTML = tabs.map(t => '<button class="tb" data-tab="' + t[0] + '" aria-label="' + t[1] + '">' +
                AF.icon(t[0] === 'movies' ? 'film' : t[0]) + '<span>' + t[1] + '</span></button>').join('');
            AF.$$('.tb', bar).forEach(b => b.onclick = () => {
                if (b.dataset.tab === 'more') AF.openMore();
                else this.goTab(b.dataset.tab);
            });
            const s = $('#searchBtn'), g = $('#settingsBtn');
            if (s) { s.innerHTML = AF.icon('search'); s.onclick = () => this.goTab('search'); }
            if (g) { g.innerHTML = AF.icon('gear'); g.onclick = () => AF.openSettings(); }
        },

        homeFrame() { return this.list.find(f => f.kind === 'home') || null; },

        goTab(tab) {
            const home = this.homeFrame();
            if (!home) return;
            const again = this.active() === home && home.ctx.tab === tab;
            this.toTop(home);
            if (tab !== 'home' || !again) { home.ctx.cat = ''; home.ctx.genre = ''; }
            home.ctx.tab = tab;
            if (tab === 'home' && again) home.ctx.cat = '';
            home.paint();
            home.node.scrollTo(0, 0);
        },

        active() { return this.list.length ? this.list[this.list.length - 1] : null; },

        atBottom() { return this.list.length <= 1; },

        push(kind, opts) {
            opts = opts || {};
            const f = {
                id: 'f' + this.seq++,
                kind: kind,
                title: opts.title || (kind === 'home' ? 'AnimeFlix' : kind === 'anime' ? 'Ficha' : '▶ Player'),
                ctx: opts.ctx || {},
                player: null,
                node: el('section', 'view ' + kind),
            };
            f.node.dataset.frame = f.id;
            this.list.push(f);
            this.views.appendChild(f.node);
            while (this.list.length > MAX_FRAMES) this.destroy(this.list[1]), this.list.splice(1, 1);

            if (kind === 'home') renderHome(f);
            else if (kind === 'anime') renderAnime(f);
            this.show(f);
            return f;
        },

        /* cada frame guarda o próprio node no DOM, então o scroll de quem ficou embaixo está intacto */
        show(f) {
            if (!f) return;
            this.list.forEach(x => {
                const on = x === f;
                x.node.classList.toggle('on', on);
                if (x.player) { on ? x.player.onShow() : x.player.onHide(); }
            });
            document.body.classList.toggle('has-player', this.list.some(x => x.player));
            this.repaint();
        },

        destroy(f) {
            if (f.player) { try { f.player.destroy(); } catch (e) {} f.player = null; }
            f.node.remove();
        },

        pop() {
            if (this.list.length <= 1) return false;
            const f = this.list.pop();
            this.destroy(f);
            this.show(this.active());
            return true;
        },

        /* derruba tudo acima de f e mostra f */
        toTop(f) {
            while (this.list.length && this.list[this.list.length - 1] !== f) this.pop();
            this.show(f);
            return f;
        },

        back() { return this.pop(); },

        byAnime(animeId) {
            return this.list.find(f => f.kind === 'anime' && f.ctx.animeId === animeId) || null;
        },

        /* vai para a ficha de um anime: reaproveita se já estiver na pilha */
        toAnime(animeId, card) {
            const found = this.byAnime(animeId);
            if (found) return this.toTop(found);
            return AF.openAnimeByCard(card || { _id: animeId, name: animeId });
        },

        repaint() {
            const cur = this.active();
            const back = $('#backBtn'), title = $('#viewTitle');
            const atHome = !!cur && cur.kind === 'home';
            if (back) back.classList.toggle('hide', this.atBottom());
            if (title) title.textContent = !cur || atHome ? 'AnimeFlix' : cur.title;
            document.title = cur && !atHome ? cur.title : 'AnimeFlix';
            document.body.classList.toggle('at-home', atHome);
            const home = this.homeFrame();
            AF.$$('.tb').forEach(b => b.classList.toggle('on', !!home && b.dataset.tab === home.ctx.tab));
        },

        /* compat: nomes antigos de seção → abas novas */
        goView(view) {
            const map = { home: 'home', history: 'history', favs: 'list', queue: 'list' };
            const home = this.homeFrame();
            if (home && view === 'queue') home.ctx.listTab = 'queue';
            if (home && view === 'favs') home.ctx.listTab = 'favs';
            this.goTab(map[view] || 'home');
        },
    };

    /* ── entrar no player ──────────────────────────────────────────────────── */
    AF.openPlayer = (ctx, epIdx) => {
        /* um vídeo ativo por vez: qualquer player ainda empilhado sai antes */
        for (let i = nav.list.length - 1; i >= 0; i--) {
            if (nav.list[i].kind !== 'player') continue;
            const old = nav.list.splice(i, 1)[0];
            nav.destroy(old);
        }
        const full = Object.assign({}, ctx, { epIdx: epIdx | 0 });
        const f = nav.push('player', { title: '▶ ' + (ctx.animeName || '') + ' · Ep ' + epLabel(full), ctx: full });
        f.player = new AF.Player(f);
        f.player.autoFullscreen();           /* ainda dentro do toque: o navegador exige */
        drive(f, full, epIdx | 0);
        return f;
    };

    function drive(frame, ctx, epIdx) {
        const p = frame.player;
        if (!p) return;
        p.ctx = ctx;
        frame.ctx = ctx;
        p.eps = ctx.eps || [];
        p.epIdx = epIdx | 0;
        p.tt = ctx.tt || AF.cfg.data.tt;
        p.resumeAt = resumePoint(ctx.animeId, p.eps[epIdx | 0]);
        p.loadEpisode(epIdx | 0);
    }

    /* mesmo formato do "onde eu parei" que o próprio player usa */
    function resumePoint(animeId, e) {
        if (!e) return 0;
        const h = AF.hist.get(animeId, String(e.number || AF.epNumber(e)));
        return (h && !h.done && h.t > 20 && (!h.d || h.t < h.d - 45)) ? h.t : 0;
    }

    function epLabel(ctx) {
        const e = (ctx.eps || [])[ctx.epIdx | 0];
        return e ? String(e.number || e.episodeIdNum) : '?';
    }

    /* card = {_id,name,thumbnail,epNum} (vindo do catálogo, fila ou histórico) */
    AF.openAnimeByCard = (card, opts) => {
        opts = opts || {};
        const id = card._id || card.animeId || card.id;
        const use = {
            _id: id,
            name: card.name || card.anime || card.englishName || id,
            thumbnail: card.thumbnail || card.thumb || '',
            epNum: card.epNum || card.ep || opts.playEp || '',
        };
        const tm = /^(movie|tv):(\d+)$/.exec(String(id));
        if (tm) { AF.openTitle({ kind: tm[1], id: tm[2], title: use.name, thumbnail: use.thumbnail }); return null; }
        if (String(id).startsWith('ia:')) { AF.playArchive({ id, title: use.name, thumbnail: use.thumbnail }); return null; }
        const existing = nav.byAnime(id);
        if (existing) {
            nav.toTop(existing);
            if (opts.playEp) AF.playFrom(existing, use.epNum || opts.playEp);
            return existing;
        }
        const f = nav.push('anime', {
            title: use.name || String(id),
            ctx: { animeId: id, card: use, epNum: use.epNum },
        });
        if (opts.playEp) f.ctx.autoPlay = String(opts.playEp);
        return f;
    };

    /* Toca um episódio (número ou índice) a partir do frame de ficha. */
    AF.playFrom = (frame, epRef, tt) => {
        const ctx = frame.ctx;
        if (!ctx.eps || !ctx.eps.length) {
            ctx.pending = epRef;
            ctx.pendingTt = tt;
            AF.toast('Carregando episódios…');
            loadEpisodes(frame).then(ok => { if (ok) AF.playFrom(frame, epRef, tt); });
            return;
        }
        let idx = 0;
        if (typeof epRef === 'number') idx = AF.clamp(epRef, 0, ctx.eps.length - 1);
        else {
            const want = String(epRef || '').trim();
            idx = ctx.eps.findIndex(e => String(e.number) === want || String(e.number).endsWith('-' + want));
            if (idx < 0) {
                const n = parseFloat(want);
                idx = ctx.eps.findIndex(e => AF.epNumber(e) === n);
            }
            if (idx < 0) idx = 0;
        }
        AF.openPlayer({
            animeId: ctx.animeId,
            animeName: ctx.name || ctx.card.name,
            eps: ctx.eps,
            epIdx: idx,
            tt: tt || ctx.tt || AF.cfg.data.tt,
            audios: ctx.audios || null,
            poster: ctx.poster || ctx.card.thumbnail,
        }, idx);
    };

    /* ── ícones (traço fino, herdam a cor do texto) ───────────────────────── */
    const ICO = {
        home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
        search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
        list: '<path d="M6.5 4h11v16.5L12 16.5l-5.5 4z"/>',
        clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
        more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    };
    AF.icon = (name, cls) => '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[name] || '') + '</svg>';

    /* ── view: catálogo ────────────────────────────────────────────────────── */
    /* categorias da faixa; `rail` = também vira carrossel no início */
    const CATS = [
        { id: '', label: 'Início' },
        { id: 'popular', label: 'Populares', api: p => '/anime/browse?path=most-popular&page=' + p },
        { id: 'dubbed', label: 'Dublados', api: p => '/anime/browse?path=dubbed&page=' + p },
        { id: 'airing', label: 'No ar', api: p => '/anime/browse?path=in-air&page=' + p },
        { id: 'top100', label: 'Top 100', api: p => '/anime/browse?path=top-100&page=' + p },
        { id: 'movies', label: 'Filmes', api: p => '/anime/browse?path=movies&page=' + p },
        { id: 'genre', label: 'Gêneros', api: (p, genre) => '/anime/browse?path=genres/' + genre + '&page=' + p },
    ];
    const RAILS = [
        { id: 'new', title: 'Novos episódios', api: '/anime/home?page=1', pick: d => d.recent },
        { id: 'dubbed', title: 'Com dublagem', api: '/anime/browse?path=dubbed&page=1', cat: 'dubbed' },
        { id: 'popular', title: 'Mais populares', api: '/anime/browse?path=most-popular&page=1', cat: 'popular' },
        { id: 'airing', title: 'Em exibição', api: '/anime/browse?path=in-air&page=1', cat: 'airing' },
        { id: 'top', title: 'Top 100', api: '/anime/browse?path=top-100&page=1', cat: 'top100' },
    ];
    let genresCache = null;

    /* respostas do catálogo ficam 5 min na memória: trocar de aba não refaz a rede */
    const memo = new Map();
    async function fetchCat(path) {
        const hit = memo.get(path);
        if (hit && hit.at > Date.now() - 300000) return hit.data;
        const data = await AF.apiGet(path);
        memo.set(path, { at: Date.now(), data });
        return data;
    }

    function renderHome(frame) {
        const ctx = frame.ctx;
        ctx.tab = ctx.tab || 'home';
        ctx.cat = ctx.cat || '';
        ctx.page = ctx.page || 1;
        ctx.genre = ctx.genre || '';
        ctx.query = ctx.query || '';
        ctx.listTab = ctx.listTab || 'favs';
        frame.node.innerHTML = '<div class="home"></div>';
        const root = $('.home', frame.node);
        let gen = 0;                       // invalida pinturas antigas quando a aba muda

        frame.paint = () => {
            gen++;
            if (frame._hero) { clearInterval(frame._hero); frame._hero = 0; }
            root.innerHTML = '';
            if (ctx.tab === 'search') paintSearch(frame, root, gen, () => gen);
            else if (ctx.tab === 'movies') paintMovies(frame, root, gen, () => gen);
            else if (ctx.tab === 'list') paintList(frame, root);
            else if (ctx.tab === 'history') paintHistory(frame, root);
            else paintStart(frame, root, gen, () => gen);
            nav.repaint();
        };
        frame.reload = () => { ctx.page = 1; memo.clear(); frame.paint(); };
        frame.paint();
    }

    /* ── Início: destaque + continuar + categorias + carrosséis ────────────── */
    function catsBar(frame, onPick) {
        const ctx = frame.ctx;
        const bar = el('div', 'cats');
        CATS.forEach(c => {
            const b = el('button', 'chip' + (ctx.cat === c.id ? ' on' : ''), esc(c.label));
            b.onclick = () => { ctx.cat = c.id; ctx.page = 1; if (c.id !== 'genre') ctx.genre = ''; onPick(); };
            bar.appendChild(b);
        });
        return bar;
    }

    function paintStart(frame, root, gen, cur) {
        const ctx = frame.ctx;
        const again = () => frame.paint();
        const cats = catsBar(frame, again);

        if (ctx.cat) {                         /* categoria escolhida → grade com paginação */
            root.appendChild(el('div', 'page-h', '<h2>' + esc((CATS.find(c => c.id === ctx.cat) || {}).label) + '</h2>'));
            root.appendChild(cats);
            paintCatGrid(frame, root, gen, cur);
            return;
        }

        const heroHost = el('div', 'hb-host', '<div class="hb-skel"></div>');
        const contHost = el('div', 'contwrap');
        root.appendChild(heroHost);
        root.appendChild(cats);
        root.appendChild(contHost);
        drawContinue(contHost, frame);

        fetchCat('/anime/home?page=1').then(data => {
            if (gen !== cur()) return;
            const trending = (data.trending && data.trending.length ? data.trending : data.recent || []).map(AF.showOf);
            paintHero(frame, heroHost, trending.filter(x => x.thumbnail).slice(0, 5));
            appendRail(root, 'Em alta agora', trending, null, frame);
            RAILS.forEach(r => railSlot(frame, root, r, gen, cur, data));
        }).catch(e => {
            if (gen !== cur()) return;
            heroHost.innerHTML = '';
            root.appendChild(errorBox(e, () => frame.reload()));
        });
    }

    function errorBox(e, retry) {
        const box = el('div', 'hint bad', 'Não consegui carregar: ' + esc(e.message || 'sem resposta') +
            '<br><button class="btn ghost" style="margin-top:8px">tentar de novo</button>');
        $('button', box).onclick = retry;
        return box;
    }

    function paintHero(frame, host, items) {
        if (!items.length) { host.innerHTML = ''; return; }
        let i = 0;
        const hb = el('div', 'hb');
        host.innerHTML = '';
        host.appendChild(hb);

        const draw = () => {
            const show = items[i];
            const node = AF.cardFrom(show);
            const last = AF.hist.lastOf(node._id);
            const tags = [];
            if (Number(show.score)) tags.push('<span class="bg sc">★ ' + esc(Number(show.score).toFixed(1)) + '</span>');
            if (show.dubcount) tags.push('<span class="bg dub">DUBLADO</span>');
            if (show.subcount) tags.push('<span class="bg">LEGENDADO</span>');
            if (show.type) tags.push('<span class="bg">' + esc(show.type) + '</span>');
            hb.innerHTML =
                '<div class="hb-bg"></div>' +
                '<div class="hb-in"><img class="hb-poster" alt="">' +
                '<div class="hb-info"><div class="hb-tags">' + tags.join('') + '</div>' +
                '<h2 class="hb-title"></h2>' +
                '<div class="hb-meta">' + esc([show.duration, show.epcount ? show.epcount + ' episódios' : ''].filter(Boolean).join(' · ')) + '</div>' +
                '<div class="hb-acts">' +
                '<button class="btn primary" data-play>' + AF.icon('play') + ' ' + (last ? 'Continuar Ep ' + esc(last.epNum || last.ep) : 'Assistir') + '</button>' +
                '<button class="btn" data-fav>' + AF.icon(AF.favs.has(node._id) ? 'check' : 'plus') + ' Minha lista</button>' +
                '</div></div></div>' +
                '<div class="hb-dots">' + items.map((_, k) => '<i class="' + (k === i ? 'on' : '') + '"></i>').join('') + '</div>';
            $('.hb-title', hb).textContent = node.name;
            const img = $('.hb-poster', hb);
            img.src = show.thumbnail;
            img.onerror = () => { img.onerror = null; img.src = AF.NO_IMG; };
            $('.hb-bg', hb).style.backgroundImage = 'url("' + String(show.thumbnail).replace(/"/g, '%22') + '")';
            $('[data-play]', hb).onclick = () => AF.openAnimeByCard(node, { playEp: last ? (last.epNum || last.ep) : '1' });
            $('[data-fav]', hb).onclick = ev => {
                const on = AF.favs.toggle({ _id: node._id, name: node.name, thumbnail: node.thumbnail });
                ev.currentTarget.innerHTML = AF.icon(on ? 'check' : 'plus') + ' Minha lista';
                AF.toast(on ? 'Adicionado à sua lista' : 'Removido da sua lista');
            };
            $('.hb-info', hb).onclick = ev => { if (!ev.target.closest('button')) AF.openAnimeByCard(node); };
        };
        draw();
        if (items.length > 1) {
            frame._hero = setInterval(() => {
                if (!document.body.contains(hb)) { clearInterval(frame._hero); return; }
                if (nav.active() !== frame || AF.sheetOpen()) return;
                i = (i + 1) % items.length;
                draw();
            }, 7000);
        }
    }

    function appendRail(root, title, items, catId, frame) {
        const list = (items || []).map(AF.showOf);
        if (!list.length) return null;
        const sec = el('section', 'rail');
        sec.innerHTML = '<div class="rail-h"><h3>' + esc(title) + '</h3>' +
            (catId ? '<button data-all>Ver tudo</button>' : '') + '</div><div class="rail-row"></div>';
        const row = $('.rail-row', sec);
        list.forEach(s => row.appendChild(cardNode(s)));
        const all = $('[data-all]', sec);
        if (all) all.onclick = () => { frame.ctx.cat = catId; frame.ctx.page = 1; frame.paint(); frame.node.scrollTo(0, 0); };
        root.appendChild(sec);
        return sec;
    }

    /* cada carrossel pede os dados sozinho: o início aparece sem esperar pelos mais lentos */
    function railSlot(frame, root, r, gen, cur, homeData) {
        const slot = el('section', 'rail', '<div class="rail-h"><h3>' + esc(r.title) + '</h3></div>' +
            '<div class="rail-row">' + '<div class="skel"></div>'.repeat(4) + '</div>');
        root.appendChild(slot);
        const done = items => {
            if (gen !== cur()) return;
            const made = (items || []).length ? appendRail(document.createDocumentFragment(), r.title, items, r.cat, frame) : null;
            if (made) slot.replaceWith(made); else slot.remove();
        };
        if (r.pick) { done(r.pick(homeData)); return; }
        fetchCat(r.api).then(d => done(d.results || [])).catch(() => { if (gen === cur()) slot.remove(); });
    }

    async function paintCatGrid(frame, root, gen, cur) {
        const ctx = frame.ctx;
        const grid = el('div', 'grid');
        const moreBar = el('div', 'morebar', '<button class="btn ghost" data-more style="display:none">Carregar mais</button>');
        const more = $('[data-more]', moreBar);

        if (ctx.cat === 'genre') {
            if (!genresCache) {
                try { genresCache = (await AF.apiGet('/anime/genres')).genres || []; } catch (e) { genresCache = []; }
                if (gen !== cur()) return;
            }
            const gb = el('div', 'genrebar');
            genresCache.forEach(g => {
                const b = el('button', 'chip sm' + (ctx.genre === g.id ? ' on' : ''), esc(g.name));
                b.onclick = () => { ctx.genre = g.id; ctx.page = 1; frame.paint(); };
                gb.appendChild(b);
            });
            if (!genresCache.length) gb.innerHTML = '<span class="hint">nenhum gênero disponível agora</span>';
            root.appendChild(gb);
            if (!ctx.genre) { root.appendChild(el('div', 'hint', 'Escolha um gênero acima.')); return; }
        }
        root.appendChild(grid);
        root.appendChild(moreBar);

        const cat = CATS.find(c => c.id === ctx.cat);
        const load = async (append) => {
            if (!append) grid.innerHTML = '<div class="hint">Carregando…</div>';
            more.style.display = 'none';
            let data;
            try { data = await fetchCat(cat.api(ctx.page, ctx.genre)); }
            catch (e) {
                if (gen !== cur()) return;
                grid.innerHTML = '';
                grid.appendChild(errorBox(e, () => load(append)));
                return;
            }
            if (gen !== cur()) return;
            const items = data.results || [];
            renderInto(grid, items, append);
            more.style.display = items.length >= 20 ? '' : 'none';
        };
        more.onclick = () => { ctx.page++; load(true); };
        load(false);
    }

    /* ── Buscar ────────────────────────────────────────────────────────────── */
    function paintSearch(frame, root, gen, cur) {
        const ctx = frame.ctx;
        root.innerHTML =
            '<div class="sv"><div class="sv-bar">' + AF.icon('search') +
            '<input type="search" placeholder="Buscar anime ou filme" autocomplete="off" enterkeyhint="search" aria-label="Buscar">' +
            '<button class="ib x" title="Limpar" hidden>' + AF.icon('close') + '</button></div>' +
            '<div data-sug class="sv-sug"></div></div><div class="grid" data-res></div>' +
            '<div class="morebar"><button class="btn ghost" data-more style="display:none">Carregar mais</button></div>';
        const input = $('input', root), clr = $('.x', root), sug = $('[data-sug]', root);
        const res = $('[data-res]', root), more = $('[data-more]', root);
        input.value = ctx.query || '';
        let timer = 0;

        const suggestions = () => {
            sug.innerHTML = '';
            res.innerHTML = '';
            more.style.display = 'none';
            const recent = AF.searches.list();
            if (recent.length) {
                sug.innerHTML = '<h4>Buscas recentes</h4><div class="wrap"></div>';
                recent.forEach(q => {
                    const b = el('button', 'chip', esc(q));
                    b.onclick = () => { input.value = q; run(true); };
                    $('.wrap', sug).appendChild(b);
                });
            }
            fetchCat('/anime/home?page=1').then(d => {
                if (gen !== cur() || input.value.trim()) return;
                const top = (d.trending || []).slice(0, 8).map(AF.showOf);
                if (!top.length) return;
                const box = el('div', '', '<h4 style="margin-top:14px">Em alta</h4><div class="wrap"></div>');
                top.forEach(s => {
                    const b = el('button', 'chip', esc(s.name));
                    b.onclick = () => AF.openAnimeByCard(AF.cardFrom(s));
                    $('.wrap', box).appendChild(b);
                });
                sug.appendChild(box);
            }).catch(() => { });
        };

        const run = async (save, append) => {
            const q = input.value.trim();
            ctx.query = q;
            clr.hidden = !q;
            if (q.length < 2) { ctx.page = 1; suggestions(); return; }
            sug.innerHTML = '';
            if (!append) { ctx.page = 1; res.innerHTML = '<div class="hint">Buscando…</div>'; }
            more.style.display = 'none';
            let data;
            try { data = await AF.apiGet('/anime/search?q=' + encodeURIComponent(q) + '&page=' + ctx.page + '&limit=30'); }
            catch (e) {
                if (gen !== cur() || input.value.trim() !== q) return;
                res.innerHTML = '';
                res.appendChild(errorBox(e, () => run(false, append)));
                return;
            }
            if (gen !== cur() || input.value.trim() !== q) return;
            if (save) AF.searches.add(q);
            const items = data.results || [];
            if (!items.length && !append) {
                res.innerHTML = '<div class="hint">Nada encontrado para “' + esc(q) + '”.<br>' +
                    '<small>Tente o nome em inglês ou em romaji (ex.: “Shingeki no Kyojin”).</small></div>';
                return;
            }
            renderInto(res, items, append);
            more.style.display = data.hasNextPage ? '' : 'none';
        };

        input.oninput = () => { clearTimeout(timer); clr.hidden = !input.value; timer = setTimeout(() => run(false), 380); };
        input.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(timer); input.blur(); run(true); } };
        clr.onclick = () => { input.value = ''; run(false); input.focus(); };
        more.onclick = () => { ctx.page++; run(false, true); };
        if (ctx.query) run(false); else suggestions();
        if (!ctx.query) setTimeout(() => input.focus(), 120);
    }

    /* ── Filmes e séries ───────────────────────────────────────────────────── */
    ICO.film = '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M16 5v14M4 10h4M16 10h4M4 14h4M16 14h4"/>';

    function titleCard(item, onOpen) {
        const card = el('div', 'card');
        const badges = [];
        if (item.score) badges.push('<span class="bg sc">★ ' + esc(item.score) + '</span>');
        if (item.kind === 'archive') badges.push('<span class="bg dub">GRÁTIS</span>');
        card.innerHTML =
            '<div class="cw"><img loading="lazy" alt=""><div class="badges">' + badges.join('') + '</div></div>' +
            '<div class="ci"><div class="ct">' + esc(item.title) + '</div><div class="cm">' + esc(item.year || '') + '</div></div>';
        const img = $('img', card);
        img.src = item.thumbnail || AF.NO_IMG;
        img.onerror = () => { img.onerror = null; img.src = AF.NO_IMG; };
        card.onclick = () => onOpen(item);
        return card;
    }

    function fillGrid(grid, items, onOpen, append) {
        if (!append) grid.innerHTML = '';
        if (!items.length && !append) { grid.innerHTML = '<div class="hint">Nada encontrado.</div>'; return; }
        items.forEach(i => grid.appendChild(titleCard(i, onOpen)));
    }

    function paintMovies(frame, root, gen, cur) {
        const ctx = frame.ctx;
        ctx.mv = ctx.mv || 'movie';
        root.innerHTML = '<div class="page-h"><h2>Filmes e séries</h2></div>' +
            '<div class="seg"><button data-m="movie">Filmes</button><button data-m="tv">Séries</button><button data-m="free">Grátis</button></div>' +
            '<div data-body></div>';
        const body = $('[data-body]', root);
        const draw = () => {
            AF.$$('.seg button', root).forEach(b => b.classList.toggle('on', b.dataset.m === ctx.mv));
            body.innerHTML = '';
            if (ctx.mv === 'free') paintFree(body, gen, cur);
            else paintTmdb(body, ctx.mv, gen, cur);
        };
        AF.$$('.seg button', root).forEach(b => b.onclick = () => { ctx.mv = b.dataset.m; draw(); });
        (AF._cfgP || Promise.resolve()).then(() => { if (gen === cur()) draw(); });
    }

    function searchBox(placeholder, onQuery) {
        const box = el('div', 'sv', '<div class="sv-bar">' + AF.icon('search') +
            '<input type="search" placeholder="' + esc(placeholder) + '" autocomplete="off" aria-label="Buscar"></div>');
        let t = 0;
        $('input', box).oninput = e => { clearTimeout(t); const v = e.target.value.trim(); t = setTimeout(() => onQuery(v), 400); };
        return box;
    }

    function paintTmdb(body, kind, gen, cur) {
        if (!AF.features.tmdb) {
            body.innerHTML = '<div class="hint">O catálogo de filmes e séries precisa de uma chave grátis do TMDB no servidor.<br>' +
                '<small>themoviedb.org → Configurações → API → copie a chave e defina <b>TMDB_KEY</b> no Render. Enquanto isso, a aba <b>Grátis</b> já funciona.</small></div>';
            return;
        }
        const results = el('div', 'grid');
        const rails = el('div');
        body.appendChild(searchBox(kind === 'tv' ? 'Buscar série' : 'Buscar filme', async q => {
            if (q.length < 2) { results.innerHTML = ''; rails.style.display = ''; return; }
            rails.style.display = 'none';
            results.innerHTML = '<div class="hint">Buscando…</div>';
            try { fillGrid(results, (await AF.apiGet('/movies/search?kind=' + kind + '&q=' + encodeURIComponent(q))).results || [], AF.openTitle); }
            catch (e) { results.innerHTML = ''; results.appendChild(errorBox(e, () => { })); }
        }));
        body.appendChild(results);
        body.appendChild(rails);
        [['trending', 'Em alta'], ['popular', 'Populares'], ['top', 'Mais bem avaliados']].forEach(([which, title]) => {
            const sec = el('section', 'rail', '<div class="rail-h"><h3>' + esc(title) + '</h3></div><div class="rail-row">' + '<div class="skel"></div>'.repeat(4) + '</div>');
            rails.appendChild(sec);
            fetchCat('/movies/list?which=' + which + '&kind=' + kind).then(d => {
                if (gen !== cur()) return;
                const row = $('.rail-row', sec);
                row.innerHTML = '';
                (d.results || []).forEach(i => row.appendChild(titleCard(i, AF.openTitle)));
                if (!row.children.length) sec.remove();
            }).catch(e => { if (gen === cur()) { sec.innerHTML = ''; sec.appendChild(errorBox(e, () => { })); } });
        });
    }

    function paintFree(body, gen, cur) {
        body.appendChild(el('div', 'hint', 'Filmes de domínio público do Internet Archive — liberados para assistir de graça.'));
        const grid = el('div', 'grid');
        const more = el('div', 'morebar', '<button class="btn ghost" style="display:none">Carregar mais</button>');
        let page = 1, q = '';
        const load = async (append) => {
            if (!append) grid.innerHTML = '<div class="hint">Carregando…</div>';
            try {
                const d = await AF.apiGet('/movies/free?page=' + page + '&q=' + encodeURIComponent(q));
                if (gen !== cur()) return;
                fillGrid(grid, d.results || [], AF.openTitle, append);
                $('button', more).style.display = (d.results || []).length >= 30 ? '' : 'none';
            } catch (e) { if (gen === cur()) { grid.innerHTML = ''; grid.appendChild(errorBox(e, () => load(append))); } }
        };
        body.appendChild(searchBox('Buscar filme clássico', v => { q = v.length >= 2 ? v : ''; page = 1; load(false); }));
        body.appendChild(grid);
        body.appendChild(more);
        $('button', more).onclick = () => { page++; load(true); };
        load(false);
    }

    /* toca um filme do Internet Archive no mesmo player dos episódios */
    AF.playArchive = (item) => {
        const id = String(item.id || '').replace(/^ia:/, '');
        AF.openPlayer({
            animeId: 'ia:' + id, animeName: item.title || item.name || id, single: true,
            streamBase: '/movies/stream/', poster: item.thumbnail || item.thumb || '',
            eps: [{ number: '1', epId: '1', name: item.title || id }], tt: 'sub',
        }, 0);
    };

    /* trailer dentro do app (YouTube, sem sair da tela) */
    AF.playTrailer = (videoId) => {
        const box = el('div', 'trailer', '<button class="ib" aria-label="fechar">' + AF.icon('close') + '</button>' +
            '<iframe allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen ' +
            'src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId) + '?autoplay=1&playsinline=1&rel=0"></iframe>');
        $('button', box).onclick = () => box.remove();
        document.body.appendChild(box);
    };

    AF.trailerFor = async (query) => {
        try {
            const d = await AF.apiGet('/api/trailer?q=' + encodeURIComponent(query));
            AF.playTrailer(d.videoId);
        } catch (e) { AF.toast('Trailer não encontrado', 3000); }
    };

    AF.openTitle = async (item) => {
        if (item.kind === 'archive') {
            return AF.openSheet({
                title: item.title, sub: [item.year, 'domínio público'].filter(Boolean).join(' · '),
                items: [
                    item.overview ? { label: item.overview } : null,
                    { label: 'Assistir agora', run: () => setTimeout(() => AF.playArchive(item), 200) },
                ].filter(Boolean),
            });
        }
        let d = item;
        try { d = Object.assign({}, item, await AF.apiGet('/movies/detail/' + item.kind + '/' + item.id)); }
        catch (e) { AF.toast('Não consegui carregar os detalhes', 3000); }
        const w = d.watch || {}, items = [];
        const meta = [d.year, d.kind === 'tv' ? (d.seasons ? d.seasons + ' temporada(s)' : 'Série') : (d.runtime ? d.runtime + ' min' : 'Filme'),
            d.score ? '★ ' + d.score : ''].filter(Boolean).join(' · ');
        if (d.overview) items.push({ label: d.overview });
        if (d.genres && d.genres.length) items.push({ head: d.genres.join(' · ') });
        if (w.stream && w.stream.length) items.push({ head: 'Para assistir no Brasil: ' + w.stream.join(', ') });
        else if ((w.rent && w.rent.length) || (w.buy && w.buy.length)) items.push({ head: 'Aluguel ou compra: ' + (w.rent || []).concat(w.buy || []).filter((x, i, a) => a.indexOf(x) === i).slice(0, 5).join(', ') });
        else items.push({ head: 'Não achei onde assistir legalmente no Brasil agora.' });
        if (d.trailer) items.push({ label: 'Ver trailer', hint: 'toca aqui mesmo', run: () => { setTimeout(() => AF.playTrailer(d.trailer), 220); } });
        if (w.link) items.push({ label: 'Ver todas as opções para assistir', run: () => { window.open(w.link, '_blank'); return 'keep'; } });
        const fid = d.kind + ':' + d.id;
        items.push({
            label: AF.favs.has(fid) ? 'Tirar da minha lista' : 'Adicionar à minha lista',
            run: () => { AF.favs.toggle({ _id: fid, name: d.title, thumbnail: d.thumbnail, tmdb: true }); return 'lista atualizada'; },
        });
        AF.openSheet({ title: d.title, sub: meta, items });
    };

    /* ── Minha lista (favoritos + fila) e Histórico ────────────────────────── */
    function paintList(frame, root) {
        const ctx = frame.ctx;
        root.innerHTML = '<div class="page-h"><h2>Minha lista</h2></div>' +
            '<div class="seg"><button data-t="favs">Favoritos</button><button data-t="queue">Assistir depois</button></div>' +
            '<div data-body class="listbody"></div>';
        const body = $('[data-body]', root);
        const draw = () => {
            AF.$$('.seg button', root).forEach(b => b.classList.toggle('on', b.dataset.t === ctx.listTab));
            body.innerHTML = '';
            renderSpecial(ctx.listTab, body, frame);
        };
        AF.$$('.seg button', root).forEach(b => b.onclick = () => { ctx.listTab = b.dataset.t; draw(); });
        draw();
    }

    function paintHistory(frame, root) {
        root.innerHTML = '<div class="page-h"><h2>Histórico</h2></div><div data-body class="listbody"></div>';
        renderSpecial('history', $('[data-body]', root), frame);
    }

    function renderInto(grid, items, append) {
        if (!append) grid.innerHTML = '';
        if (!items.length) {
            if (!append) grid.innerHTML = '<div class="hint">Nada por aqui.</div>';
            else AF.toast('não veio mais nada dessa página');
            return;
        }
        const frag = document.createDocumentFragment();
        items.forEach(show => frag.appendChild(cardNode(AF.showOf(show))));
        grid.appendChild(frag);
    }

    function cardNode(show) {
        const node = AF.cardFrom(show);
        const score = Number(show.score) ? Number(show.score).toFixed(1) : '';
        const card = el('div', 'card');
        const hist = AF.hist.lastOf(show._id);
        const badges = [];
        if (show.dubcount) badges.push('<span class="bg dub">DUB</span>');
        if (show.subcount) badges.push('<span class="bg">LEG</span>');
        if (!badges.length) badges.push('<span class="bg">' + esc(show.type || 'TV') + '</span>');
        if (score) badges.push('<span class="bg sc">★ ' + esc(score) + '</span>');
        card.innerHTML =
            '<div class="cw"><img loading="lazy" alt="">' +
            '<div class="badges">' + badges.join('') + '</div>' +
            (hist ? '<span class="cont">▶ ' + esc(hist.epNum || hist.ep) + '</span>' : '') + '</div>' +
            '<div class="ci"><div class="ct">' + esc(node.name || 'Sem título') + '</div>' +
            '<div class="cm">' + esc(show.duration || '') + (show.epcount ? (show.duration ? ' · ' : '') + esc(show.epcount) + ' eps' : '') + '</div></div>';
        const img = $('img', card);
        img.src = show.thumbnail || AF.NO_IMG;
        img.onerror = () => { img.onerror = null; img.src = AF.NO_IMG; };
        card.onclick = () => AF.openAnimeByCard(node);
        const menu = e => {
            e.preventDefault();
            AF.openSheet({
                title: node.name,
                items: [
                    { label: 'Abrir ficha', run: () => AF.openAnimeByCard(node) },
                    { label: 'Assistir agora', hint: 'pula a ficha', run: () => AF.openAnimeByCard(node, { playEp: node.epNum || '1' }) },
                    { label: AF.favs.has(node._id) ? 'Tirar da minha lista' : 'Adicionar à minha lista',
                      run: () => { AF.favs.toggle({ _id: node._id, name: node.name, thumbnail: node.thumbnail }); AF.toast('lista atualizada'); } },
                ],
            });
        };
        card.oncontextmenu = menu;
        /* toque longo no celular (o WebView não dispara contextmenu em todo aparelho) */
        let lp = 0;
        card.addEventListener('touchstart', () => { lp = setTimeout(() => { lp = -1; menu({ preventDefault() { } }); }, 520); }, { passive: true });
        ['touchend', 'touchmove', 'touchcancel'].forEach(t => card.addEventListener(t, () => { if (lp > 0) clearTimeout(lp); }, { passive: true }));
        card.addEventListener('click', e => { if (lp === -1) { e.stopImmediatePropagation(); lp = 0; } }, true);
        return card;
    }

    function drawContinue(host, frame) {
        if (!host) return;
        const rows = AF.hist.recent(10).filter(h => h.d > 30 && !h.done);
        if (!rows.length) { host.innerHTML = ''; return; }
        host.innerHTML = '<section class="rail"><div class="rail-h"><h3>Continuar assistindo</h3></div><div class="rail-row"></div></section>';
        const row = $('.rail-row', host);
        rows.forEach(h => {
            const b = el('button', 'cont-card');
            const pct = AF.progressPct(h);
            b.innerHTML =
                '<img loading="lazy" alt="">' +
                '<div class="cc-i"><b>Ep ' + esc(h.epNum || h.ep) + '</b><span>' + esc(h.anime || h.animeId) + '</span>' +
                '<small>' + AF.clock(h.t) + ' / ' + AF.clock(h.d) + '</small></div>' +
                '<div class="cc-bar"><i style="width:' + pct + '%"></i></div>';
            const img = $('img', b);
            img.src = h.thumb || AF.NO_IMG;
            img.onerror = () => { img.onerror = null; img.src = AF.NO_IMG; };
            b.onclick = () => AF.openAnimeByCard({
                _id: h.animeId, name: h.anime, thumbnail: h.thumb, epNum: h.epNum || h.ep,
            }, { playEp: h.epNum || h.ep });
            b.oncontextmenu = e => {
                e.preventDefault();
                AF.openSheet({
                    title: 'Tirar do histórico?',
                    items: [{ label: 'Esquecer ' + (h.anime || h.animeId), run: () => { AF.hist.drop(h.animeId, h.epNum || h.ep); frame.paint(); } },
                    { label: 'Cancelar', run: () => { } }],
                });
            };
            row.appendChild(b);
        });
    }

    function renderSpecial(kind, grid, frame) {
        const again = () => { grid.innerHTML = ''; renderSpecial(kind, grid, frame); };
        if (kind === 'history') {
            const rows = AF.hist.recent(40);
            if (!rows.length) { grid.innerHTML = '<div class="hint">Nada assistido ainda. Quando você começar um episódio, ele aparece aqui.</div>'; return; }
            rows.forEach(h => grid.appendChild(rowNode({
                img: h.thumb, title: h.anime || h.animeId, sub: 'Ep ' + (h.epNum || h.ep) + ' · ' + AF.clock(h.t) + ' assistidos',
                pct: AF.progressPct(h),
                on: () => AF.openAnimeByCard({ _id: h.animeId, name: h.anime, thumbnail: h.thumb }, { playEp: h.epNum || h.ep }),
                off: () => { AF.hist.drop(h.animeId, h.epNum || h.ep); again(); },
            })));
            grid.appendChild(clearNode('Limpar histórico', () => { AF.hist.clear(); again(); }));
        } else if (kind === 'favs') {
            if (!AF.favs.list.length) { grid.innerHTML = '<div class="hint">Sua lista está vazia. Toque em “Minha lista” no destaque ou na ficha de um anime.</div>'; return; }
            AF.favs.list.forEach(f => grid.appendChild(rowNode({
                img: f.thumbnail, title: f.name, sub: 'na sua lista',
                on: () => AF.openAnimeByCard(f),
                off: () => { AF.favs.toggle(f); again(); },
            })));
        } else {
            if (!AF.queue.items.length) { grid.innerHTML = '<div class="hint">Nada na fila. Use “Depois” na ficha de um anime.</div>'; return; }
            AF.queue.items.forEach((q, i) => grid.appendChild(rowNode({
                img: q.thumb, title: (q.anime || q.animeId) + ' · Ep ' + q.ep,
                sub: ttLabel(q.tt),
                on: () => { AF.queue.remove(i); AF.openAnimeByCard(q, { playEp: q.ep }); },
                off: () => { AF.queue.remove(i); again(); },
            })));
            grid.appendChild(clearNode('Esvaziar fila', () => { AF.queue.clear(); again(); }));
        }
    }

    function ttLabel(tt) { return (AF.AUDIO[tt] || AF.AUDIO.sub).label; }

    function rowNode(o) {
        const n = el('div', 'lrow');
        n.innerHTML =
            '<img loading="lazy" alt="">' +
            '<div class="lr-i"><b>' + esc(o.title) + '</b><span>' + esc(o.sub || '') + '</span></div>' +
            (o.pct ? '<div class="lr-bar"><i style="width:' + o.pct + '%"></i></div>' : '') +
            '<button class="ib del" title="remover" aria-label="remover">' + AF.icon('close') + '</button>';
        const img = $('img', n);
        img.src = o.img || AF.NO_IMG;
        img.onerror = () => { img.onerror = null; img.src = AF.NO_IMG; };
        n.onclick = o.on;
        $('.del', n).onclick = e => { e.stopPropagation(); o.off && o.off(); };
        return n;
    }

    function clearNode(label, run) {
        const n = el('div', 'lrow clear');
        n.innerHTML = '<span class="lr-i"><b>' + esc(label) + '</b></span><button class="btn ghost">limpar</button>';
        $('button', n).onclick = run;
        n.onclick = e => { if (e.target.tagName !== 'BUTTON') run(); };
        return n;
    }

    /* ── view: ficha do anime ──────────────────────────────────────────────── */
    async function renderAnime(frame) {
        const ctx = frame.ctx;
        const card = ctx.card || { _id: ctx.animeId };
        ctx.animeId = ctx.animeId || card._id;

        frame.node.innerHTML =
            '<div class="anime">' +
            '<div class="hero"><div class="hero-bg"></div>' +
            '<div class="hero-in">' +
            '<img class="poster" alt="">' +
            '<div class="hh">' +
            '<div class="hh-top"><button class="ib back" title="voltar">←</button>' +
            '<b class="tabname">' + esc(card.name || ctx.animeId) + '</b><span class="grow"></span></div>' +
            '<h2 data-name></h2>' +
            '<div class="ticks" data-ticks></div>' +
            '<div class="acts">' +
            '<button class="btn primary" data-act="play">' + AF.icon('play') + ' Assistir</button>' +
            '<button class="btn" data-act="resume">Continuar</button>' +
            '<button class="btn" data-act="fav">♡</button>' +
            '<button class="btn" data-act="later">Depois</button>' +
            (AF.features.youtube ? '<button class="btn" data-act="trailer">Trailer</button>' : '') +
            '<button class="btn ghost" data-act="refresh" title="recarregar" aria-label="recarregar">↻</button>' +
            '</div>' +
            '<div class="audio-pick" data-audio></div>' +
            '<p class="syno" data-syno></p>' +
            '</div></div></div>' +
            '<div data-resume></div>' +
            '<div class="epbar">' +
            '<input type="search" placeholder="filtrar por número…" data-filter>' +
            '<button class="chip on" data-sort="asc">↑</button>' +
            '<button class="chip" data-sort="desc">↓</button>' +
            '<button class="chip" data-only="all">tudo</button>' +
            '<button class="chip" data-only="todo">a ver</button>' +
            '<button class="chip" data-only="done">vistos</button>' +
            '<span class="grow"></span><span class="mut" data-count></span>' +
            '</div>' +
            '<div class="epgrid" data-eps><div class="hint">Carregando episódios…</div></div>' +
            '</div>';

        const poster = $('.poster', frame.node);
        const bg = $('.hero-bg', frame.node);
        poster.src = card.thumbnail || AF.NO_IMG;
        poster.onerror = () => { poster.onerror = null; poster.src = AF.NO_IMG; };
        if (card.thumbnail) bg.style.backgroundImage = 'url("' + AF.proxyUrl(card.thumbnail, '') + '")';
        $('[data-name]', frame.node).textContent = card.name || ctx.animeId;
        $('.back', frame.node).onclick = () => nav.back();

        const act = {
            play: () => AF.playFrom(frame, ctx.epNum || nextEp(ctx)),
            resume: () => {
                const h = AF.hist.lastOf(ctx.animeId);
                if (!h) { AF.toast('nada assistido ainda'); return; }
                AF.playFrom(frame, h.epNum || h.ep, h.tt);
            },
            fav: btn => {
                const on = AF.favs.toggle({ _id: ctx.animeId, name: ctx.name || card.name, thumbnail: ctx.poster || card.thumbnail });
                btn.textContent = on ? '♥' : '♡';
                btn.classList.toggle('on', on);
                AF.toast(on ? 'nos favoritos' : 'tiramos dos favoritos');
            },
            later: () => {
                const ep = ctx.epNum || nextEp(ctx);
                const ok = AF.queue.add({ animeId: ctx.animeId, anime: ctx.name || card.name,
                    thumb: ctx.poster || card.thumbnail, ep: String(ep), tt: AF.cfg.data.tt });
                AF.toast(ok ? 'Ep ' + ep + ' na fila de depois' : 'já estava na fila');
            },
            trailer: () => AF.trailerFor((ctx.name || (ctx.card && ctx.card.name) || '') + ' anime'),
            refresh: () => { ctx.eps = null; loadEpisodes(frame, true); loadDetails(frame); },
        };
        AF.$$('[data-act]', frame.node).forEach(b => {
            b.onclick = () => act[b.dataset.act](b);
        });

        const filter = $('[data-filter]', frame.node);
        filter.oninput = () => { ctx.filter = filter.value.trim(); paintEps(frame); };
        AF.$$('[data-sort]', frame.node).forEach(b => b.onclick = () => {
            ctx.sort = b.dataset.sort;
            AF.$$('[data-sort]', frame.node).forEach(x => x.classList.toggle('on', x === b));
            paintEps(frame);
        });
        AF.$$('[data-only]', frame.node).forEach(b => b.onclick = () => {
            ctx.only = b.dataset.only;
            AF.$$('[data-only]', frame.node).forEach(x => x.classList.toggle('on', x === b));
            paintEps(frame);
        });
        ctx.sort = ctx.sort || 'asc';
        ctx.only = ctx.only || 'all';

        paintAudioPick(frame);
        await loadEpisodes(frame);
        loadDetails(frame);
        loadAudios(frame);
    }

    /* escolha de áudio da ficha: vale para "Assistir" e para os episódios tocados daqui */
    function paintAudioPick(frame) {
        const ctx = frame.ctx;
        const host = $('[data-audio]', frame.node);
        if (!host) return;
        const want = ctx.tt || AF.cfg.data.tt;
        host.innerHTML = '<span class="mut">Áudio</span>';
        ['dub-pt', 'sub-pt', 'sub', 'dub'].forEach(k => {
            const avail = ctx.audios ? ctx.audios[k] : null;
            const b = el('button', 'chip sm' + (want === k ? ' on' : '') + (avail === false ? ' off' : ''), esc(AF.AUDIO[k].label));
            b.title = AF.AUDIO[k].hint;
            b.onclick = () => {
                ctx.tt = k;
                AF.cfg.set({ tt: k });
                if (avail === false) AF.toast('Não achei “' + AF.AUDIO[k].label + '” para este anime. Vou tentar mesmo assim.', 4200);
                paintAudioPick(frame);
            };
            host.appendChild(b);
        });
    }

    async function loadAudios(frame) {
        const ctx = frame.ctx;
        const first = (ctx.eps || [])[0];
        const name = ctx.name || (ctx.card && ctx.card.name) || '';
        try {
            ctx.audios = await AF.apiGet('/anime/audios/' + encodeURIComponent(ctx.animeId) +
                '?ep=' + encodeURIComponent(first ? first.number : '1') + '&title=' + encodeURIComponent(name));
            paintAudioPick(frame);
        } catch (e) { /* sem a lista, todos os áudios ficam clicáveis */ }
    }

    /* card "continuar em mm:ss" da ficha, bem acima da lista de episódios */
    function drawResumeBar(frame) {
        const ctx = frame.ctx;
        const host = $('[data-resume]', frame.node);
        if (!host) return;
        const h = AF.hist.lastOf(ctx.animeId);
        if (!h || h.done || !(h.t > 20)) { host.innerHTML = ''; return; }
        const ep = h.epNum || h.ep;
        host.innerHTML =
            '<div class="resumebar">' +
            '<div class="rb-i"><b>▶ Continuar do Ep ' + esc(String(ep)) + '</b>' +
            '<span>' + AF.clock(h.t) + ' de ' + AF.clock(h.d) + ' assistidos</span></div>' +
            '<button class="btn primary" data-act="rb-play">Retomar</button>' +
            '<button class="btn ghost" data-act="rb-from">Do início</button>' +
            '</div>';
        AF.$('[data-act="rb-play"]', host).onclick = () => AF.playFrom(frame, ep, h.tt);
        AF.$('[data-act="rb-from"]', host).onclick = () => {
            AF.hist.drop(ctx.animeId, String(ep));
            AF.playFrom(frame, ep, h.tt);
        };
    }

    function nextEp(ctx) {
        const h = AF.hist.lastOf(ctx.animeId);
        if (h) {
            if (!h.done && h.t < (h.d || 0) - 60) return h.epNum || h.ep;
            const n = parseFloat(h.epNum || h.ep);
            if (!isNaN(n)) return String(Math.floor(n) + 1);
        }
        const todo = (ctx.eps || []).find(e => !AF.hist.get(ctx.animeId, String(e.number)));
        return todo ? String(todo.number) : '';
    }

    async function loadEpisodes(frame, force) {
        const ctx = frame.ctx;
        if (ctx.eps && ctx.eps.length && !force) { paintEps(frame); return true; }
        const host = $('[data-eps]', frame.node);
        host.innerHTML = '<div class="hint">Carregando episódios…</div>';
        try {
            const d = await AF.apiGet('/anime/episodes/' + encodeURIComponent(ctx.animeId), force ? { noCache: true } : {});
            ctx.eps = d.episodes || [];
            paintEps(frame);
            drawResumeBar(frame);
            if (ctx.autoPlay) { const ep = ctx.autoPlay; ctx.autoPlay = ''; AF.playFrom(frame, ep); }
            else if (ctx.pending) { const p = ctx.pending; ctx.pending = ''; AF.playFrom(frame, p, ctx.pendingTt); }
            return true;
        } catch (e) {
            host.innerHTML = '<div class="hint bad">Episódios indisponíveis: ' + esc(e.message) +
                '<br><button class="btn ghost" style="margin-top:8px">tentar de novo</button></div>';
            $('button', host).onclick = () => loadEpisodes(frame, true);
            return false;
        }
    }

    async function loadDetails(frame) {
        const ctx = frame.ctx;
        try {
            const d = await AF.apiGet('/anime/details/' + encodeURIComponent(ctx.animeId));
            ctx.name = d.name || ctx.card.name;
            ctx.poster = d.image || ctx.card.thumbnail;
            ctx.overview = d.overview || d.description || '';
            frame.title = ctx.name;
            $('.tabname', frame.node).textContent = ctx.name;
            $('[data-name]', frame.node).textContent = ctx.name;
            if (ctx.poster) {
                $('.poster', frame.node).src = ctx.poster;
                $('.hero-bg', frame.node).style.backgroundImage = 'url("' + AF.proxyUrl(ctx.poster, '') + '")';
            }
            const syn = $('[data-syno]', frame.node);
            syn.textContent = ctx.overview;
            syn.onclick = () => syn.classList.toggle('open');
            const ticks = $('[data-ticks]', frame.node);
            ticks.innerHTML = '';
            (d.ticks || []).slice(0, 8).forEach(t => ticks.appendChild(el('span', 'tk', esc(t))));
            if (d.score) ticks.insertBefore(el('span', 'tk sc', '★ ' + esc(d.score)), ticks.firstChild);
            if (AF.favs.has(ctx.animeId)) {
                const f = $('[data-act="fav"]', frame.node);
                f.textContent = '♥'; f.classList.add('on');
            }
            nav.repaint();
        } catch (e) { /* ficha é extra: a lista de episódios já basta */ }
    }

    function paintEps(frame) {
        const ctx = frame.ctx;
        const host = $('[data-eps]', frame.node);
        const count = $('[data-count]', frame.node);
        if (!ctx.eps) return;
        let list = ctx.eps.slice();
        list.sort((a, b) => AF.epNumber(a) - AF.epNumber(b));
        if (ctx.sort === 'desc') list.reverse();
        const f = (ctx.filter || '').trim();
        if (f) list = list.filter(e => String(e.number || '').includes(f));
        if (ctx.only === 'todo') list = list.filter(e => { const h = AF.hist.get(ctx.animeId, String(e.number)); return !h || (!h.done && h.d - h.t < 45); });
        if (ctx.only === 'done') list = list.filter(e => { const h = AF.hist.get(ctx.animeId, String(e.number)); return h && h.done; });

        count.textContent = list.length + ' / ' + ctx.eps.length;
        host.innerHTML = '';
        if (!list.length) { host.innerHTML = '<div class="hint">Nenhum episódio com esse filtro.</div>'; return; }
        const frag = document.createDocumentFragment();
        list.forEach(e => frag.appendChild(epNode(frame, e)));
        host.appendChild(frag);
    }

    function epNode(frame, e) {
        const ctx = frame.ctx;
        const num = String(e.number || AF.epNumber(e));
        const h = AF.hist.get(ctx.animeId, num);
        const pct = AF.progressPct(h);
        const b = el('button', 'ep' + (h && h.done ? ' done' : pct ? ' prog' : ''));
        b.innerHTML =
            '<b>' + esc(num) + '</b>' +
            (e.name ? '<i>' + esc(e.name.slice(0, 24)) + '</i>' : '') +
            (pct ? '<div class="ep-bar"><i style="width:' + pct + '%"></i></div>' : '') +
            (h && h.done ? '<span class="ep-ok">✓</span>' : '') +
            (h && !h.done && h.t > 20 ? '<span class="ep-at">' + AF.clock(h.t) + '</span>' : '');
        b.onclick = () => AF.playFrom(frame, num);
        b.oncontextmenu = ev => {
            ev.preventDefault();
            AF.openSheet({
                title: 'Episódio ' + num,
                items: [
                    { label: 'Assistir', run: () => AF.playFrom(frame, num) },
                    ...['dub-pt', 'sub-pt', 'sub', 'dub'].map(k => ({
                        label: AF.AUDIO[k].label, hint: AF.AUDIO[k].hint, run: () => AF.playFrom(frame, num, k) })),
                    { label: 'Assistir depois', run: () => {
                        AF.queue.add({ animeId: ctx.animeId, anime: ctx.name || ctx.card.name, thumb: ctx.poster, ep: num, tt: AF.cfg.data.tt });
                        AF.toast('Ep ' + num + ' na fila');
                    } },
                    { label: h && h.done ? 'Marcar como não assistido' : 'Marcar como assistido', run: () => {
                        if (h && h.done) AF.hist.drop(ctx.animeId, num);
                        else AF.hist.touch(ctx.animeId, num, { done: true, animeId: ctx.animeId, anime: ctx.name, t: 1, d: 1 });
                        paintEps(frame);
                    } },
                ],
            });
        };
        return b;
    }

    AF.nav = nav;
})(window.AF);
