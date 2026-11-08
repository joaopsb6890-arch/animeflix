"""Nomes alternativos de um anime (romaji, inglês, japonês, sinônimos).

Cada site chama o anime de um jeito ("Shingeki no Kyojin" / "Attack on Titan");
buscar só pelo nome do hianime é a causa nº 1 de "dublagem não encontrada".
O AniList tem API pública (GraphQL, sem chave): https://github.com/AniList/ApiV2-GraphQL-Docs
"""
import re
import time

import httpx

ANILIST = "https://graphql.anilist.co"
QUERY = """query($q:String){Page(perPage:3){media(search:$q,type:ANIME,sort:SEARCH_MATCH){
  title{romaji english native} synonyms}}}"""
_cache = {}


def clean(name: str) -> str:
    name = re.sub(r"\((?:tv|dub|sub|dublado|legendado)\)", " ", str(name or ""), flags=re.I)
    return re.sub(r"\s+", " ", name).strip()


def from_slug(show_id: str) -> str:
    return re.sub(r"-\d+$", "", str(show_id or "")).replace("-", " ").strip()


async def candidates(client: httpx.AsyncClient, show_id: str, name: str = "") -> list:
    """Lista de títulos, do mais provável ao menos. Nunca levanta exceção."""
    base = [clean(name), from_slug(show_id)]
    key = (show_id, name)
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    extra = []
    try:
        q = base[0] or base[1]
        r = await client.post(ANILIST, json={"query": QUERY, "variables": {"q": q}},
                              headers={"Content-Type": "application/json"}, timeout=8)
        for m in (r.json().get("data", {}).get("Page", {}).get("media") or [])[:2]:
            t = m.get("title") or {}
            extra += [t.get("romaji"), t.get("english")] + (m.get("synonyms") or [])[:3]
    except Exception:                       # noqa: BLE001 — AniList fora do ar não pode quebrar o player
        pass
    seen, out = set(), []
    for t in base + extra:
        t = clean(t)
        k = t.lower()
        if t and k not in seen and re.search(r"[A-Za-z0-9]", t):
            seen.add(k)
            out.append(t)
    out = out[:6]
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = (time.time() + 6 * 3600, out)
    return out
