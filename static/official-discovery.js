/* Busca metadados e encaminha para catálogos licenciados; não reproduz nem coleta vídeos. */
(() => {
    'use strict';

    const SERVICES = [
        { name: 'Crunchyroll', url: q => `https://www.crunchyroll.com/search?q=${encodeURIComponent(q)}` },
        { name: 'Netflix', url: q => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
        { name: 'Prime Video', url: q => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(q)}` },
        { name: 'Disney+', url: q => `https://www.disneyplus.com/search?q=${encodeURIComponent(q)}` },
    ];
    const GRAPHQL = 'https://graphql.anilist.co';
    const ANILIST_QUERY = `query ($search: String) {
      Page(page: 1, perPage: 8) {
        media(search: $search, type: ANIME, isAdult: false) {
          id siteUrl title { romaji english native } coverImage { large } description(asHtml: false)
          seasonYear averageScore episodes format genres
          externalLinks { site url type }
        }
      }
    }`;

    const node = (tag, cls, text) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text != null) el.textContent = text;
        return el;
    };

    async function searchAniList(term, signal) {
        const res = await fetch(GRAPHQL, {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: term } }),
        });
        if (!res.ok) throw new Error(`AniList respondeu HTTP ${res.status}`);
        const body = await res.json();
        if (body.errors?.length) throw new Error('AniList não conseguiu completar a busca.');
        return body.data?.Page?.media || [];
    }

    async function searchJikan(term, signal) {
        const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(term)}&limit=8&sfw=true`;
        const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Jikan respondeu HTTP ${res.status}`);
        const body = await res.json();
        return (body.data || []).map(item => ({
            id: item.mal_id,
            siteUrl: item.url,
            title: { romaji: item.title, english: item.title_english, native: item.title_japanese },
            coverImage: { large: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '' },
            description: item.synopsis || '',
            seasonYear: item.year || item.aired?.prop?.from?.year,
            averageScore: item.score ? Math.round(item.score * 10) : null,
            episodes: item.episodes,
            format: item.type,
            genres: (item.genres || []).map(g => g.name),
            externalLinks: [],
        }));
    }

    async function searchKitsu(term, signal) {
        const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(term)}&page[limit]=8`;
        const res = await fetch(url, { signal, headers: { Accept: 'application/vnd.api+json' } });
        if (!res.ok) throw new Error(`Kitsu respondeu HTTP ${res.status}`);
        const body = await res.json();
        return (body.data || []).map(item => {
            const a = item.attributes || {};
            return {
                id: item.id,
                siteUrl: a.slug ? `https://kitsu.io/anime/${encodeURIComponent(a.slug)}` : 'https://kitsu.io/anime',
                title: { romaji: a.titles?.en_jp || a.canonicalTitle, english: a.titles?.en || a.canonicalTitle, native: a.titles?.ja_jp },
                coverImage: { large: a.posterImage?.large || a.posterImage?.original || '' },
                description: a.synopsis || '',
                seasonYear: a.startDate ? Number(a.startDate.slice(0, 4)) : null,
                averageScore: a.averageRating ? Math.round(Number(a.averageRating)) : null,
                episodes: a.episodeCount,
                format: a.subtype,
                genres: [],
                externalLinks: [],
            };
        });
    }

    function serviceLink(label, href) {
        try {
            const parsed = new URL(href);
            if (parsed.protocol !== 'https:') return null;
        } catch (_) { return null; }
        const a = node('a', 'od-link', label);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        return a;
    }

    function makeCard(item, term) {
        const card = node('article', 'od-card');
        const title = item.title?.english || item.title?.romaji || item.title?.native || 'Anime sem título';
        const image = node('img', 'od-cover');
        image.loading = 'lazy';
        image.alt = `Capa de ${title}`;
        image.src = item.coverImage?.large || '';
        image.onerror = () => { image.hidden = true; };
        card.appendChild(image);

        const info = node('div', 'od-info');
        info.appendChild(node('h3', '', title));
        const meta = [item.seasonYear, item.format, item.episodes ? `${item.episodes} episódios` : '',
            item.averageScore ? `Nota ${item.averageScore}%` : ''].filter(Boolean).join(' · ');
        if (meta) info.appendChild(node('p', 'od-meta', meta));
        if (item.description) {
            const desc = node('p', 'od-description');
            desc.textContent = item.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            info.appendChild(desc);
        }
        if (item.genres?.length) info.appendChild(node('p', 'od-meta', item.genres.slice(0, 5).join(' · ')));

        const links = node('div', 'od-links');
        const streaming = (item.externalLinks || []).filter(link => link.type === 'STREAMING' && link.url);
        streaming.slice(0, 4).forEach(link => {
            const a = serviceLink(link.site || 'Serviço oficial', link.url);
            if (a) links.appendChild(a);
        });
        SERVICES.forEach(service => {
            const a = serviceLink(`Buscar no ${service.name}`, service.url(title || term));
            if (a) links.appendChild(a);
        });
        const details = serviceLink('Ver ficha no AniList', item.siteUrl || `https://anilist.co/search/anime?search=${encodeURIComponent(title)}`);
        if (details) links.appendChild(details);
        info.appendChild(links);
        card.appendChild(info);
        return card;
    }

    function buildWidget() {
        const section = node('section', 'official-discovery');
        section.id = 'official-discovery';
        section.setAttribute('aria-labelledby', 'od-title');
        const heading = node('h2', '', 'Descubra onde assistir legalmente');
        heading.id = 'od-title';
        section.appendChild(heading);
        section.appendChild(node('p', 'od-intro', 'Pesquise informações do anime e abra os catálogos oficiais. A disponibilidade e a dublagem PT-BR variam por título e região; confirme diretamente no serviço.'));

        const form = node('form', 'od-form');
        const input = node('input');
        input.type = 'search';
        input.name = 'anime';
        input.placeholder = 'Ex.: Jujutsu Kaisen';
        input.setAttribute('aria-label', 'Buscar anime em catálogos oficiais');
        input.maxLength = 100;
        input.required = true;
        const button = node('button', 'od-submit', 'Buscar');
        button.type = 'submit';
        form.append(input, button);
        section.appendChild(form);
        const status = node('p', 'od-status', 'Metadados de AniList, com Jikan e Kitsu como alternativas.');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        section.appendChild(status);
        const results = node('div', 'od-results');
        section.appendChild(results);

        let controller;
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const term = input.value.trim();
            if (!term) return;
            controller?.abort();
            controller = new AbortController();
            button.disabled = true;
            status.textContent = 'Buscando informações…';
            results.replaceChildren();
            const providers = [['AniList', searchAniList], ['Jikan', searchJikan], ['Kitsu', searchKitsu]];
            try {
                let items = [];
                const failures = [];
                for (const [name, search] of providers) {
                    try {
                        items = await search(term, controller.signal);
                        if (items.length) break;
                    } catch (err) {
                        if (err.name === 'AbortError') return;
                        failures.push(name);
                    }
                }
                if (!items.length) {
                    status.textContent = failures.length === providers.length
                        ? 'As APIs de catálogo estão indisponíveis. Tente novamente mais tarde.'
                        : 'Nenhum resultado encontrado. Tente o título em inglês ou japonês.';
                    return;
                }
                items.forEach(item => results.appendChild(makeCard(item, term)));
                status.textContent = 'Links levam a serviços oficiais. Eles não garantem disponibilidade no seu país nem confirmam que o título tenha dublagem.';
            } catch (err) {
                if (err.name !== 'AbortError') status.textContent = 'Não foi possível consultar os catálogos agora. Tente novamente mais tarde.';
            } finally {
                button.disabled = false;
            }
        });
        return section;
    }

    function attachWidgets() {
        document.querySelectorAll('.home').forEach(home => {
            if (!home.querySelector('.official-discovery')) home.prepend(buildWidget());
        });
    }

    const observer = new MutationObserver(attachWidgets);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    attachWidgets();
})();
