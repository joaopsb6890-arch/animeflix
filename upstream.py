"""Fonte reserva: uma instância do aniwatch-api (projeto open source no GitHub).

    https://github.com/ghoshRitesh12/aniwatch-api

Ela já resolve os servidores do hianime (inclusive os que criptografam a lista de
fontes), então serve de plano B quando o scraper interno falha, sobretudo para
dublagem em inglês. Você hospeda a sua (Docker/Render/Vercel, o README do projeto
mostra) e informa o endereço:

    ANIWATCH_API=https://minha-instancia.onrender.com[,https://outra...]

Sem a variável, este módulo não faz nada. O formato de resposta usado aqui é o
da v2 (`/api/v2/hianime/...`); `ANIWATCH_PREFIX` troca o prefixo se a sua for outra.
"""
import os
import re

import httpx

BASES = [b.strip().rstrip("/") for b in os.environ.get("ANIWATCH_API", "").split(",") if b.strip()]
PREFIX = os.environ.get("ANIWATCH_PREFIX", "/api/v2/hianime")
REFERER = os.environ.get("UPSTREAM_REFERER", "https://megacloud.blog/")
SERVERS = ("hd-1", "hd-2")


def enabled() -> bool:
    return bool(BASES)


def _lang(t: dict) -> str:
    label = str(t.get("label") or "")
    if re.search(r"portug|brazil|\bpt\b", label, re.I):
        return "pt-BR"
    return label[:2].lower() or "und"


async def streams(client: httpx.AsyncClient, show_id: str, ep_id: str, trans: str) -> tuple:
    """(fontes, log) no mesmo formato de hianime.streams()."""
    log, out = [], []
    anime_ep_id = f"{show_id}?ep={ep_id}"
    for base in BASES:
        for server in SERVERS:
            try:
                r = await client.get(base + PREFIX + "/episode/sources", timeout=20,
                                     params={"animeEpisodeId": anime_ep_id, "server": server, "category": trans})
                r.raise_for_status()
                d = r.json().get("data") or {}
            except Exception as e:          # noqa: BLE001
                log.append(f"upstream {base.split('//')[-1]}/{server}: {type(e).__name__} {str(e)[:60]}")
                continue
            subs = [{"lang": _lang(t), "label": t.get("label") or "", "url": t.get("file") or t.get("url") or "",
                     "default": bool(t.get("default"))}
                    for t in d.get("tracks") or [] if t.get("kind", "captions") in ("captions", "subtitles")
                    and (t.get("file") or t.get("url"))]
            skip = {"intro": d.get("intro") or {}, "outro": d.get("outro") or {}}
            for src in d.get("sources") or []:
                url = src.get("url")
                if not url:
                    continue
                hls = src.get("type") == "hls" or ".m3u8" in url
                out.append({
                    "provider": "aniwatch-api", "server": f"upstream {server}", "host": re.sub(r"^https?://", "", url).split("/")[0],
                    "translationType": trans, "referer": REFERER, "embed": "", "poster": "", "skip": skip,
                    "subs": subs, "url": url, "quality": "auto" if hls else "", "pixels": 0,
                    "type": "hls" if hls else "mp4",
                })
            if out:
                return out, log
    if not out and BASES:
        log.append("upstream: nenhuma instância devolveu fonte")
    return out, log
