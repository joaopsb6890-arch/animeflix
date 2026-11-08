"""Filmes e séries.

* Catálogo (TMDB — API oficial e gratuita, https://www.themoviedb.org/settings/api):
  em alta, populares, busca, sinopse, trailer e ONDE ASSISTIR legalmente no Brasil
  (Netflix, Prime, etc.). Ative com TMDB_KEY (chave v3) ou TMDB_TOKEN (token v4).
* Filmes grátis de domínio público (Internet Archive): tocam direto no app.

O app NÃO liga fontes de streaming sem licença para filmes e séries.
"""
import os
import re
import time
from urllib.parse import quote

import httpx

TMDB = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p"
KEY = os.environ.get("TMDB_KEY", "").strip()
TOKEN = os.environ.get("TMDB_TOKEN", "").strip()
ARCHIVE = "https://archive.org"
_cache = {}


def have_tmdb() -> bool:
    return bool(KEY or TOKEN)


async def _cached(key, ttl, make):
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    val = await make()
    if len(_cache) > 600:
        _cache.clear()
    _cache[key] = (time.time() + ttl, val)
    return val


async def _tmdb(client: httpx.AsyncClient, path: str, **params):
    if not have_tmdb():
        raise LookupError("catálogo desativado: defina TMDB_KEY no servidor")
    params.setdefault("language", "pt-BR")
    headers = {"Authorization": "Bearer " + TOKEN} if TOKEN else {}
    if KEY and not TOKEN:
        params["api_key"] = KEY
    r = await client.get(TMDB + path, params=params, headers=headers, timeout=15)
    r.raise_for_status()
    return r.json()


def _item(x: dict, kind: str) -> dict:
    kind = x.get("media_type") if x.get("media_type") in ("movie", "tv") else kind
    date = x.get("release_date") or x.get("first_air_date") or ""
    return {
        "id": x.get("id"), "kind": kind,
        "title": x.get("title") or x.get("name") or "",
        "year": date[:4], "overview": x.get("overview") or "",
        "thumbnail": f"{IMG}/w342{x['poster_path']}" if x.get("poster_path") else "",
        "backdrop": f"{IMG}/w780{x['backdrop_path']}" if x.get("backdrop_path") else "",
        "score": round(float(x.get("vote_average") or 0), 1),
    }


def _kind(kind: str) -> str:
    return "tv" if kind == "tv" else "movie"


async def listing(client, which: str, kind: str, page: int = 1) -> list:
    kind = _kind(kind)
    path = f"/trending/{kind}/week" if which == "trending" else f"/{kind}/{'top_rated' if which == 'top' else 'popular'}"
    d = await _cached((path, page), 900, lambda: _tmdb(client, path, page=page))
    return [_item(x, kind) for x in d.get("results", []) if x.get("poster_path")]


async def search(client, q: str, kind: str, page: int = 1) -> list:
    kind = _kind(kind)
    d = await _tmdb(client, f"/search/{kind}", query=q, page=page, include_adult="false")
    return [_item(x, kind) for x in d.get("results", []) if x.get("poster_path")]


async def detail(client, kind: str, tmdb_id: int) -> dict:
    kind = _kind(kind)

    async def make():
        d = await _tmdb(client, f"/{kind}/{int(tmdb_id)}", append_to_response="videos,watch/providers",
                        include_video_language="pt,en,null")
        base = _item(d, kind)
        base["genres"] = [g["name"] for g in d.get("genres", [])]
        base["runtime"] = d.get("runtime") or (d.get("episode_run_time") or [0])[0]
        base["seasons"] = d.get("number_of_seasons")
        vids = [v for v in (d.get("videos") or {}).get("results", []) if v.get("site") == "YouTube"]
        vids.sort(key=lambda v: (v.get("type") != "Trailer", v.get("iso_639_1") != "pt"))
        base["trailer"] = vids[0]["key"] if vids else ""
        br = ((d.get("watch/providers") or {}).get("results") or {}).get("BR") or {}
        base["watch"] = {
            "link": br.get("link", ""),
            "stream": [p["provider_name"] for p in br.get("flatrate", [])],
            "rent": [p["provider_name"] for p in br.get("rent", [])],
            "buy": [p["provider_name"] for p in br.get("buy", [])],
        }
        return base
    return await _cached(("detail", kind, tmdb_id), 3600, make)


# ── Internet Archive: filmes de domínio público ────────────────────────────────
def _arch_item(x: dict) -> dict:
    ident = x.get("identifier", "")
    return {"id": ident, "kind": "archive", "title": x.get("title") or ident,
            "year": str(x.get("year") or "")[:4], "overview": re.sub(r"<[^>]+>", " ", str(x.get("description") or ""))[:400]
            if not isinstance(x.get("description"), list) else "",
            "thumbnail": f"{ARCHIVE}/services/img/{quote(ident)}", "score": 0}


async def free_list(client, q: str = "", page: int = 1) -> list:
    query = "collection:feature_films AND mediatype:movies"
    if q:
        query += f" AND title:({re.sub(r'[^\w\s]', ' ', q)})"

    async def make():
        r = await client.get(ARCHIVE + "/advancedsearch.php", timeout=20, params={
            "q": query, "fl[]": ["identifier", "title", "year", "description"],
            "sort[]": "downloads desc", "rows": 36, "page": page, "output": "json"})
        r.raise_for_status()
        return [_arch_item(x) for x in r.json().get("response", {}).get("docs", [])]
    return await _cached(("free", query, page), 1800, make)


async def free_stream(client, ident: str) -> list:
    if not re.fullmatch(r"[A-Za-z0-9._\-]{2,120}", ident):
        raise LookupError("identificador inválido")
    r = await client.get(f"{ARCHIVE}/metadata/{quote(ident)}", timeout=20)
    r.raise_for_status()
    files = r.json().get("files", [])
    vids = [f for f in files if str(f.get("name", "")).lower().endswith((".mp4", ".m4v", ".webm", ".ogv"))]
    if not vids:
        raise LookupError("este filme não tem arquivo de vídeo reproduzível")
    # prefere H.264/MP4 (toca em qualquer aparelho) e, entre eles, um tamanho razoável
    vids.sort(key=lambda f: (0 if str(f["name"]).lower().endswith((".mp4", ".m4v")) else 1,
                             0 if "h.264" in str(f.get("format", "")).lower() else 1,
                             abs(int(f.get("size") or 0) - 700_000_000)))
    subs = []
    for f in files:
        n = str(f.get("name", ""))
        if n.lower().endswith((".srt", ".vtt")):
            lang = "pt-BR" if re.search(r"(^|[._\-])(pt|por|br)([._\-]|$)", n, re.I) else "en" if re.search(r"(^|[._\-])en", n, re.I) else "und"
            subs.append({"lang": lang, "label": n, "url": f"{ARCHIVE}/download/{quote(ident)}/{quote(n)}"})
    out = []
    for f in vids[:3]:
        name = f["name"]
        out.append({
            "provider": "archive", "server": "Internet Archive", "host": "archive.org",
            "translationType": "sub", "referer": "", "embed": f"{ARCHIVE}/details/{quote(ident)}",
            "poster": f"{ARCHIVE}/services/img/{quote(ident)}", "skip": {}, "subs": subs,
            "url": f"{ARCHIVE}/download/{quote(ident)}/{quote(name)}", "quality": str(f.get("format", "")),
            "pixels": 0, "type": "mp4", "direct": True,
        })
    return out
