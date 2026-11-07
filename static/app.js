/* AnimeFlix — inicialização: folha de ações, ajuda, ajustes e o "voltar" do app. */
(function (AF) {
    const el = AF.el, esc = AF.esc, $ = AF.$;

    /* ── folha de ações (bottom sheet) ───────────────────────────────────────
       AF.openSheet({ title, items, sub, onClose })
       item = { label | html, hint, run(value), input: 'texto'|true, default, danger }
       run que devolve 'keep' re-renderiza a folha em vez de fechar.            */
    let sheetHost = null, sheetOpts = null, sheetFocusBefore = null;

    AF.openSheet = (opts) => {
        closeSheet();
        sheetOpts = opts || {};
        sheetFocusBefore = document.activeElement;

        sheetHost = el('div', 'sheet-wrap');
        const back = el('div', 'sheet-back');
        const sheet = el('div', 'sheet');
        sheet.innerHTML = '<div class="sheet-grip"></div>' +
            '<div class="sheet-h"><div><b>' + esc(opts.title || '') + '</b>' +
            (opts.sub ? '<span class="mut">' + esc(opts.sub) + '</span>' : '') +
            '</div><button class="ib sheet-x" title="fechar">✕</button></div>' +
            '<div class="sheet-b"></div>';
        sheetHost.appendChild(back);
        sheetHost.appendChild(sheet);
        document.body.appendChild(sheetHost);
        back.onclick = () => closeSheet();
        $('.sheet-x', sheet).onclick = () => closeSheet();
        requestAnimationFrame(() => sheetHost.classList.add('on'));

        paintSheet();
        document.addEventListener('keydown', sheetKey, true);
        return closeSheet;
    };

    function paintSheet() {
        const body = $('.sheet-b', sheetHost);
        body.innerHTML = '';
        const items = typeof sheetOpts.items === 'function' ? sheetOpts.items() : (sheetOpts.items || []);
        if (!items.length) body.appendChild(el('div', 'hint', 'nada por aqui'));
        items.forEach(it => {
            if (it == null) return;
            if (it.head) { body.appendChild(el('div', 'sh-head', esc(it.head))); return; }
            if (it.sep) { body.appendChild(el('div', 'sh-sep')); return; }
            const b = el('button', 'sh-item' + (it.danger ? ' bad' : ''));
            b.innerHTML = '<span class="sh-l">' + (it.label ? esc(it.label) : (it.html || '')) + '</span>' +
                (it.hint ? '<span class="sh-h">' + esc(it.hint) + '</span>' : '');
            if (it.input != null) {
                const inp = el('input', 'sh-in');
                inp.type = it.type || 'text';
                inp.value = typeof it.input === 'string' ? it.input : (it.default || '');
                inp.placeholder = it.placeholder || 'valor…';
                b.appendChild(inp);
                const go = () => fire(it, inp.value.trim());
                inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
                b.onclick = () => (it.run ? go() : b.querySelector('input').focus());
                setTimeout(() => inp.focus(), 60);
            } else if (it.toggle) {
                const sw = el('i', 'sh-sw' + (it.value ? ' on' : ''));
                b.insertBefore(sw, b.firstChild);
                b.classList.toggle('on', !!it.value);
                b.onclick = () => fire(it, !it.value);
            } else if (it.choices) {
                const row = el('div', 'sh-choices');
                it.choices.forEach(c => {
                    const cb = el('button', 'chip sm' + (c.on ? ' on' : ''), esc(c.label));
                    cb.onclick = () => fire(c, c.value);
                    row.appendChild(cb);
                });
                b.className = 'sh-static';
                b.innerHTML = '<span class="sh-l">' + (it.label ? esc(it.label) : (it.html || '')) + '</span>';
                b.appendChild(row);
            } else {
                b.onclick = () => fire(it);
            }
            body.appendChild(b);
        });
    }

    function fire(it, value) {
        if (!it.run) return;
        let out;
        try { out = it.run(value); }
        catch (e) { AF.toast('erro: ' + e.message); return; }
        if (out === 'keep' || out === true) { paintSheet(); return; }
        closeSheet();
        if (out && typeof out === 'string') AF.toast(out);
    }

    function sheetKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
    }

    function closeSheet() {
        if (!sheetHost) return;
        document.removeEventListener('keydown', sheetKey, true);
        const h = sheetHost, opts = sheetOpts;
        sheetHost = null; sheetOpts = null;
        h.classList.remove('on');
        setTimeout(() => h.remove(), 240);
        if (sheetFocusBefore && sheetFocusBefore.focus) { try { sheetFocusBefore.focus(); } catch (e) {} }
        sheetFocusBefore = null;
        if (opts && opts.onClose) opts.onClose();
        const f = AF.nav.active();
        if (f && f.kind === 'player' && f.player) f.player.showUI(2600);
    }
    AF.closeSheet = closeSheet;
    AF.sheetOpen = () => !!sheetHost;

    /* ── ajuda ─────────────────────────────────────────────────────────────── */
    const KEYS = [
        ['espaço / k', 'play · pausa'],
        ['j / l', '− passo · + passo'],
        ['← / →', '−5 s · +5 s'],
        ['↑ / ↓', 'volume ±5%'],
        ['0–9', 'pular para 0–90% do episódio'],
        ['m', 'mudo'],
        [', / .', 'velocidade − · +'],
        ['f', 'tela cheia'],
        ['t', 'modo cinema'],
        ['a', 'áudio: dublado · legendado'],
        ['c', 'legendas'],
        ['n / p', 'próximo · anterior'],
        ['z', 'loop A–B'],
        ['b', 'picture-in-picture'],
        ['s', 'estatísticas'],
        ['i', 'informações da fonte'],
        ['esc', 'fecha menus'],
        ['?', 'esta lista'],
    ];

    AF.showHelp = () => AF.openSheet({
        title: 'Atalhos e gestos',
        sub: 'tocar 1× mostra os controles · 2× na lateral avança · segurar acelera',
        items: [
            { head: 'teclado (funciona com Bluetooth)' },
            { html: KEYS.map(k => '<div class="kb"><kbd>' + esc(k[0]) + '</kbd><span>' + esc(k[1]) + '</span></div>').join('') },
            { sep: true },
            { head: 'gestos na tela' },
            { html: '<div class="kb"><kbd>swipe ↕ direita</kbd><span>volume</span></div>' +
                '<div class="kb"><kbd>swipe ↕ esquerda</kbd><span>brilho (escurecer)</span></div>' +
                '<div class="kb"><kbd>swipe ↔</kbd><span>procura com prévia</span></div>' +
                '<div class="kb"><kbd>segurar</kbd><span>acelera enquanto dedos tocam</span></div>' +
                '<div class="kb"><kbd>2× ⇢</kbd><span>+pulo curto · 2× ⇠ volta</span></div>' },
        ],
    });

    /* ── ajustes ──────────────────────────────────────────────────────────── */
    const yn = v => !!v;
    const tog = (label, key, hint) => ({
        label: label, hint: hint, toggle: true, value: yn(AF.cfg.data[key]),
        run: (nv) => { AF.cfg.set({ [key]: nv }); return 'keep'; },
    });
    const chooser = (label, key, list, hint) => ({
        label: label, hint: hint,
        choices: list.map(c => ({ label: c.label, on: AF.cfg.data[key] === c.value, value: c.value,
            run: () => { AF.cfg.set({ [key]: c.value }); return 'keep'; } })),
    });

    AF.openSettings = () => AF.openSheet({
        title: 'Ajustes',
        sub: 'tudo é salvo neste aparelho',
        items: () => {
            const d = AF.cfg.data;
            return [
                { head: 'reprodução' },
                chooser('Áudio preferido', 'tt', ['dub-pt', 'sub-pt', 'sub', 'dub'].map(k => ({ label: AF.AUDIO[k].label, value: k })),
                    'se não existir para o episódio, o app tenta o próximo da lista'),
                tog('Buscar legenda em português sozinho', 'autoPtSub', 'quando o vídeo vier sem legenda PT-BR'),
                chooser('Proporção da imagem', 'fit', [
                    { label: 'conter', value: 'contain' }, { label: 'preencher', value: 'cover' },
                    { label: 'esticar', value: 'fill' }]),
                { label: 'Pulo dos botões ±', hint: 'segundos', type: 'number', input: String(d.seekStep),
                    run: v => { const n = parseInt(v, 10); if (n > 0 && n < 600) AF.cfg.set({ seekStep: n }); return 'keep'; } },
                { label: 'Velocidade ao segurar', type: 'number', input: String(d.longPressRate),
                    run: v => { const n = parseFloat(v); if (n > 0.5 && n <= 8) AF.cfg.set({ longPressRate: n }); return 'keep'; } },
                { label: 'Ocultar controles', hint: 'ms parado', type: 'number', input: String(d.uiHide),
                    run: v => { const n = parseInt(v, 10); if (n >= 800) AF.cfg.set({ uiHide: n }); return 'keep'; } },
                { label: 'Volume padrão', hint: '0 a 100', type: 'number', input: String(Math.round(d.volume * 100)),
                    run: v => { const n = AF.clamp(parseInt(v, 10) || 100, 0, 100); AF.cfg.set({ volume: n / 100 }); return 'keep'; } },
                tog('Avançar sozinho para o próximo', 'autoNext'),
                tog('Perguntar onde parei', 'resumePrompt'),
                tog('Pular abertura automaticamente', 'autoSkipIntro', 'quando o servidor marcar o intro'),
                tog('Pular encerramento', 'autoSkipOutro'),
                tog('Gestos na tela', 'gestures'),
                { sep: true },
                { head: 'interface' },
                { label: 'Escurecer o vídeo', hint: '15 a 100 %', type: 'number', input: String(d.dim),
                    run: v => { const n = AF.clamp(parseInt(v, 10) || 100, 15, 100); AF.cfg.set({ dim: n }); return 'keep'; } },
                { label: 'Voltar ao início', hint: 'fecha ficha e player abertos',
                    run: () => { AF.nav.goTab('home'); return 'de volta ao início'; } },
                { sep: true },
                { head: 'legenda padrão' },
                { label: 'Tamanho', hint: '%', type: 'number', input: String(d.sub.size),
                    run: v => { const n = AF.clamp(parseInt(v, 10) || 100, 50, 300); AF.cfg.setSub({ size: n }); return 'keep'; } },
                { label: 'Altura', hint: '% do quadro', type: 'number', input: String(d.sub.pos),
                    run: v => { const n = AF.clamp(parseInt(v, 10) || 72, 5, 95); AF.cfg.setSub({ pos: n }); return 'keep'; } },
                { label: 'Atraso', hint: 'ms', type: 'number', input: String(d.sub.delay),
                    run: v => { const n = AF.clamp(parseInt(v, 10) || 0, -5000, 5000); AF.cfg.setSub({ delay: n }); return 'keep'; } },
                { label: 'Caixa atrás do texto', toggle: true, value: !!d.sub.box,
                    hint: 'sem caixa a legenda fica limpa', run: nv => { AF.cfg.setSub({ box: nv }); return 'keep'; } },
                { label: 'Contorno do texto', toggle: true, value: !!d.sub.outline,
                    run: nv => { AF.cfg.setSub({ outline: nv }); return 'keep'; } },
                { sep: true },
                { head: 'dados locais' },
                { label: 'Limpar histórico', danger: true, hint: AF.hist ? Object.keys(AF.hist.all).length + ' itens' : '',
                    run: () => { AF.hist.clear(); AF.toast('histórico limpo'); } },
                { label: 'Esvaziar a fila', danger: true, hint: AF.queue.items.length + ' itens',
                    run: () => { AF.queue.clear(); AF.toast('fila esvaziada'); } },
                { label: 'Esquecer os favoritos', danger: true, hint: AF.favs.list.length + ' itens',
                    run: () => { AF.favs.list = []; AF.favs.save(); AF.toast('favoritos removidos'); } },
                { label: 'Restaurar ajustes de fábrica', danger: true,
                    run: () => { AF.cfg.reset(); AF.toast('ajustes restaurados'); return 'keep'; } },
            ];
        },
    });

    /* ── botão "voltar" do Android ─────────────────────────────────────────── */
    let armed = false, exitHint = 0;

    function arm() {
        try { history.pushState({ afback: 1 }, ''); armed = true; } catch (e) { armed = false; }
    }

    function uiBack() {
        if (AF.sheetOpen()) { closeSheet(); return true; }
        const f = AF.nav.active();
        if (!f) return false;

        if (f.kind === 'player' && f.player) {
            const p = f.player;
            if (p.menu && p.menu.classList.contains('on')) { p.closeMenu(); return true; }
            if (p.side && p.side.classList.contains('on')) { p.closeMenu(); return true; }
            if (p.root && p.frame.node.classList.contains('theater')) { p.act('theater'); return true; }
            if (!p.v.paused) { p.act('play'); return true; }
            return AF.nav.back();
        }
        if (f.kind === 'anime') {
            const syno = $('.syno.open', f.node);
            if (syno) { syno.classList.remove('open'); return true; }
            return AF.nav.back();
        }
        /* base da pilha: volta ao início antes de pensar em sair */
        if (f.kind === 'home' && (f.ctx.tab !== 'home' || f.ctx.cat)) {
            AF.nav.goTab('home');
            return true;
        }
        return false;
    }

    window.addEventListener('popstate', () => {
        armed = false;
        if (uiBack()) { arm(); return; }
        const now = Date.now();
        if (now - exitHint < 2200) return;      /* segunda prensa: sai de verdade */
        exitHint = now;
        arm();
        AF.toast('Voltar de novo para sair', 2000);
    });

    /* ── "Mais": tudo que não cabe na barra de baixo ───────────────────────── */
    let installEvt = null;
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });

    AF.openMore = () => AF.openSheet({
        title: 'Mais',
        items: () => [
            { label: 'Ajustes', hint: 'áudio, legenda e player', run: () => { setTimeout(AF.openSettings, 260); } },
            { label: 'Idioma e dublagem', hint: AF.AUDIO[AF.cfg.data.tt].label, run: () => { setTimeout(AF.askLanguage, 260); } },
            { label: 'Atalhos e gestos', run: () => { setTimeout(AF.showHelp, 260); } },
            installEvt ? { label: 'Instalar o app', hint: 'ícone na tela inicial, abre sem barra do navegador',
                run: () => { installEvt.prompt(); installEvt = null; } } : null,
            { label: 'Compartilhar o AnimeFlix', hint: location.origin,
                run: () => {
                    if (navigator.share) navigator.share({ title: 'AnimeFlix', text: 'Anime dublado e legendado em português', url: location.origin }).catch(() => { });
                    else if (navigator.clipboard) navigator.clipboard.writeText(location.origin).then(() => AF.toast('Link copiado'));
                } },
        ].filter(Boolean),
    });

    /* primeira abertura: pergunta como a pessoa prefere assistir (vira o áudio padrão) */
    AF.askLanguage = (first) => AF.openSheet({
        title: first ? 'Como você prefere assistir?' : 'Idioma e dublagem',
        sub: 'dá para mudar a qualquer hora, em cada episódio',
        items: [
            { html: '<div class="ob-opt"><b>Dublado em português</b><span>dublagem brasileira, quando existir</span></div>',
                run: () => { AF.cfg.set({ tt: 'dub-pt', onboarded: true }); return 'Áudio: dublado PT-BR'; } },
            { html: '<div class="ob-opt"><b>Legendado em português</b><span>legenda PT-BR já no vídeo</span></div>',
                run: () => { AF.cfg.set({ tt: 'sub-pt', onboarded: true }); return 'Áudio: legendado PT-BR'; } },
            { html: '<div class="ob-opt"><b>Áudio original com legenda</b><span>a legenda em português é buscada sozinha</span></div>',
                run: () => { AF.cfg.set({ tt: 'sub', onboarded: true, autoPtSub: true }); return 'Áudio: original com legenda'; } },
        ],
        onClose: () => { if (first) AF.cfg.set({ onboarded: true }); },
    });

    /* ── boot ──────────────────────────────────────────────────────────────── */
    function boot() {
        AF.nav.init();

        AF.loadConfig();
        if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
            navigator.serviceWorker.register('/sw.js').catch(() => { });
        }

        document.addEventListener('keydown', e => {
            const tag = (document.activeElement || {}).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const k = (e.key || '').toLowerCase();
            if (k === '?' || k === 'h' && e.shiftKey) { e.preventDefault(); AF.showHelp(); }
            else if (k === 'escape' && AF.sheetOpen()) { closeSheet(); }
            else if (k === '/') {
                const f = AF.nav.active();
                if (f && f.kind === 'home') { e.preventDefault(); AF.nav.goTab('search'); }
            }
        });

        arm();
        AF.$$('[data-shell]').forEach(n => n.classList.add('in'));
        if (!AF.cfg.data.onboarded) setTimeout(() => AF.askLanguage(true), 700);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})(window.AF);
