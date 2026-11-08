"""Provedor em português (animefire): dublado e legendado PT-BR.

Por que existe: o hianime só tem dublagem em inglês e quase nunca legenda em
português. O animefire publica as duas coisas em PT-BR, como dois "animes"
separados:

    /animes/<slug>-todos-os-episodios            → legendado (legenda queimada)
    /animes/<slug>-dublado-todos-os-episodios    → dublado

Fluxo: título → busca → melhor slug (dublado ou legendado) → página do episódio
→ endpoint /video/<slug>/<n> (JSON com as qualidades).

ATENÇÃO: foi escrito sem acesso à rede do site, a partir do formato conhecido
dele. Se o site mudar, os únicos lugares a ajustar são `_cards()` (busca) e
`_video_links()` (links do vídeo). Falhas viram linhas no `log` da API, nunca
erro 500. O domínio muda de tempos em tempos: use PTBR_BASE para trocar sem
mexer no código.
"""
import asyncio
import difflib
import json
import os
import re
import time
import unicodedata
from urllib.parse import quote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

BASES = [b.strip().rstrip("/") for b in os.environ.get(
    "PTBR_BASE", "https://animefire.plus,https://animefire.io,https://animefire.net").split(",") if b.strip()]
BASE = BASES[0]                  # o que respondeu por último fica primeiro (ver _get)
UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5"}
MATCH_MIN = 0.62          # nota mínima (0–1) para aceitar um resultado da busca
TTL = 1800


class _Cache:
    def __init__(self, ttl=TTL, cap=400):
        self.ttl, self.cap, self.d = ttl, cap, {}

    def get(self, k):
        hit = self.d.get(k)
        if not hit:
            return None
        if hit[0] < time.time():
            self.d.pop(k, None)
            return None
        return hit[1]

    def set(self, k, v):
        if len(self.d) >= self.cap:
            self.d.pop(min(self.d, key=lambda x: self.d[x][0]), None)
        self.d[k] = (time.time() + self.ttl, v)


_slugs = _Cache(6 * 3600)
_videos = _Cache(600)        # os links do vídeo expiram: cache curto


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    text = re.sub(r"\b(dublado|legendado|todos os episodios|season|temporada|\d+(st|nd|rd|th))\b", " ", text.lower())
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _score(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    ta, tb = set(a.split()), set(b.split())
    jac = len(ta & tb) / len(ta | tb) if ta | tb else 0
    return max(difflib.SequenceMatcher(None, a, b).ratio(), jac)


def title_from_slug(show_id: str) -> str:
    """'one-piece-100' (slug do hianime) → 'one piece'."""
    return re.sub(r"-\d+$", "", str(show_id or "")).replace("-", " ").strip()


async def _get(client: httpx.AsyncClient, url: str, **kw) -> httpx.Response:
    """GET que troca de domínio sozinho: `url` pode começar por qualquer BASE."""
    global BASE
    path = url
    for b in BASES:
        if url.startswith(b):
            path = url[len(b):]
            break
    last = None
    for b in [BASE] + [x for x in BASES if x != BASE]:
        try:
            hdr = {**HEADERS, "Referer": b + "/", **kw.get("headers", {})}
            r = await client.get(b + path, headers=hdr,
                                 **{k: v for k, v in kw.items() if k != "headers"})
            r.raise_for_status()
            BASE = b
            return r
        except httpx.HTTPError as e:
            last = e
    raise last


def _cards(html: str) -> list:
    """Resultados da busca: [{slug, name, dub}]."""
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()
    for a in soup.select('a[href*="/animes/"]'):
        href = a.get("href") or ""
        m = re.search(r"/animes/([a-z0-9\-]+?)(?:-todos-os-episodios)?/?$", urlparse(href).path)
        if not m:
            continue
        slug = m.group(1)
        if slug in seen:
            continue
        name = (a.get("title") or a.get_text(" ", strip=True) or "").strip()
        if not name:
            img = a.select_one("img")
            name = (img.get("alt") if img else "") or slug.replace("-", " ")
        seen.add(slug)
        out.append({"slug": slug, "name": name,
                    "dub": slug.endswith("-dublado") or "dublado" in name.lower()})
    return out


async def find_slug(client, titles: list, dub: bool, trace: list | None = None):
    """Melhor slug para qualquer um dos títulos candidatos, ou None."""
    key = ("slug", tuple(norm(t) for t in titles), dub)
    hit = _slugs.get(key)
    if hit is not None:
        return hit or None
    best, best_score = None, 0.0
    for title in [t for t in titles if t]:
        q = re.sub(r"[^\w\s]", " ", title).strip()
        if not q:
            continue
        url = f"{BASE}/pesquisar/{quote(q.replace(' ', '-'))}"
        try:
            r = await _get(client, url)
        except httpx.HTTPError as e:
            if trace is not None:
                trace.append(f"busca {url} falhou: {type(e).__name__} {str(e)[:60]}")
            continue
        found_cards = _cards(r.text)
        if trace is not None:
            trace.append(f"busca '{q}': {len(found_cards)} resultados ({sum(1 for c in found_cards if c['dub'] == dub)} {'dublados' if dub else 'legendados'})")
        for card in found_cards:
            if card["dub"] != dub:
                continue
            score = max(_score(title, card["name"]), _score(title, card["slug"].replace("-", " ")))
            if score > best_score:
                best, best_score = card, score
        if best_score >= 0.9:
            break
    found = best["slug"] if best and best_score >= MATCH_MIN else ""
    _slugs.set(key, found)
    return found or None


def _video_links(payload) -> list:
    """JSON de /video/<slug>/<n> → [(url, rótulo)]. Aceita as formas já vistas."""
    rows = []
    if isinstance(payload, dict):
        data = payload.get("data") or payload.get("sources") or payload.get("videos") or []
    else:
        data = payload or []
    for it in data if isinstance(data, list) else []:
        if isinstance(it, dict):
            url = it.get("src") or it.get("file") or it.get("url")
            if url:
                rows.append((str(url).replace("\\/", "/"), str(it.get("label") or it.get("res") or "")))
        elif isinstance(it, str) and it.startswith("http"):
            rows.append((it, ""))
    return rows


def _pixels(label: str) -> int:
    m = re.search(r"(\d{3,4})", label or "")
    return int(m.group(1)) if m else 0


async def episode_sources(client, slug: str, ep: str, dub: bool) -> list:
    ep = re.sub(r"\.0+$", "", str(ep).strip())
    if not re.fullmatch(r"\d+", ep):
        raise LookupError(f"o provedor PT-BR só tem episódios inteiros (pedido: {ep})")
    key = (slug, ep)
    hit = _videos.get(key)
    if hit is None:
        page = f"{BASE}/animes/{slug}/{ep}"
        ref = {"Referer": f"{BASE}/animes/{slug}-todos-os-episodios"}
        links = []
        try:
            r = await _get(client, f"{BASE}/video/{slug}/{ep}",
                           headers={**ref, "X-Requested-With": "XMLHttpRequest"})
            links = _video_links(r.json())
        except (httpx.HTTPError, json.JSONDecodeError, ValueError):
            pass
        if not links:                       # plano B: o link está na página do episódio
            r = await _get(client, page, headers=ref)
            soup = BeautifulSoup(r.text, "html.parser")
            node = soup.select_one("[data-video-src]")
            if node:
                try:
                    r2 = await _get(client, urljoin(page, node["data-video-src"]), headers={"Referer": page})
                    links = _video_links(r2.json())
                except (httpx.HTTPError, json.JSONDecodeError, ValueError):
                    pass
            if not links:
                links = [(m.group(1).replace("\\/", "/"), "") for m in
                         re.finditer(r'(https?://[^"\'\s]+\.(?:mp4|m3u8)[^"\'\s]*)', r.text)]
        _videos.set(key, links)
        hit = links
    if not hit:
        raise LookupError("o provedor PT-BR não devolveu vídeo para este episódio")
    out = []
    for url, label in hit:
        hls = ".m3u8" in url
        out.append({
            "provider": "animefire", "server": "PT-BR " + ("dublado" if dub else "legendado"),
            "host": urlparse(url).netloc, "translationType": "dub-pt" if dub else "sub-pt",
            "referer": BASE + "/", "embed": f"{BASE}/animes/{slug}/{ep}", "poster": "", "skip": {},
            "subs": [], "url": url, "quality": label or ("auto" if hls else ""),
            "pixels": _pixels(label), "type": "hls" if hls else "mp4",
        })
    out.sort(key=lambda s: -s["pixels"])
    return out


async def streams(client, show_id: str, episode: str, dub: bool, title: str = "",
                  trace: list | None = None) -> tuple:
    """(fontes, log) — mesma forma de hianime.streams()."""
    import titles as _titles
    tr = trace if trace is not None else []
    names = await _titles.candidates(client, show_id, title)
    tr.append("títulos tentados: " + " | ".join(names))
    try:
        slug = await find_slug(client, names, dub, tr)
    except Exception as e:                  # noqa: BLE001 — qualquer falha vira log
        return [], [f"ptbr: busca falhou — {type(e).__name__}: {str(e)[:100]}"]
    kind = "dublado" if dub else "legendado"
    if not slug:
        return [], [f"ptbr: sem versão {kind} em PT-BR para '{names[0] if names else show_id}' (" + "; ".join(tr)[:200] + ")"]
    tr.append("slug escolhido: " + slug)
    try:
        return await episode_sources(client, slug, episode, dub), []
    except Exception as e:                  # noqa: BLE001
        return [], [f"ptbr: {slug} ep {episode} — {type(e).__name__}: {str(e)[:100]}"]


async def available(client, show_id: str, title: str = "") -> dict:
    """Quais áudios PT-BR existem para o anime (para o menu mostrar só o que há)."""
    import titles as _titles
    names = await _titles.candidates(client, show_id, title)
    dub, sub = await asyncio.gather(find_slug(client, names, True),
                                    find_slug(client, names, False),
                                    return_exceptions=True)
    return {"dub-pt": bool(dub) and not isinstance(dub, Exception),
            "sub-pt": bool(sub) and not isinstance(sub, Exception)}
