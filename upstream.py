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


# ── API "aniwatch-api-v1-0" (formato antigo: /api/episode, /api/server, /api/src-server) ──
# Padrão: a instância pública do README que você passou. É de plano grátis (dorme e
# demora ~30 s para acordar) e pode estar fora do ar: o app só a usa como plano B.
# LEGACY_API=off desliga; LEGACY_API=https://sua-instancia troca o endereço.
LEGACY = os.environ.get("LEGACY_API", "https://aniwatch-api-v1-0.onrender.com").strip().rstrip("/")
LEGACY_REFERER = os.environ.get("LEGACY_REFERER", "https://megacloud.tv/")


def legacy_enabled() -> bool:
    return bool(LEGACY) and LEGACY.lower() != "off"


async def _lget(client, path: str):
    r = await client.get(LEGACY + path, timeout=45)      # 1ª chamada pode acordar o servidor
    r.raise_for_status()
    return r.json()


async def legacy_streams(client: httpx.AsyncClient, show_id: str, episode: str, trans: str) -> tuple:
    """(fontes, log) pelo formato antigo. trans: 'sub' ou 'dub'."""
    if not legacy_enabled():
        return [], []
    log = []
    host = LEGACY.split("//")[-1]
    try:
        eps = (await _lget(client, f"/api/episode/{show_id}")).get("episodetown") or []
        want = re.sub(r"\.0+$", "", str(episode).strip())
        ep = next((e for e in eps if str(e.get("order")) == want), None)
        if not ep:
            return [], [f"legacy {host}: ep {episode} não existe ({len(eps)} eps)"]
        ep_param = str(ep.get("epId", "")).split("?", 1)[-1]          # "ep=3661"
        servers = (await _lget(client, f"/api/server/{ep_param}")).get(trans) or []
        if not servers:
            return [], [f"legacy {host}: ep {episode} sem '{trans}'"]
    except Exception as e:                  # noqa: BLE001
        return [], [f"legacy {host}: {type(e).__name__} {str(e)[:80]}"]

    out = []
    # megacloud costuma ser o que tem HLS; os outros são plano C
    servers.sort(key=lambda s: 0 if "mega" in str(s.get("server", "")).lower() else 1)
    for s in servers[:4]:
        try:
            d = await _lget(client, f"/api/src-server/{s.get('srcId')}")
        except Exception as e:              # noqa: BLE001
            log.append(f"legacy {s.get('server')}: {type(e).__name__} {str(e)[:60]}")
            continue
        for block in d.get("serverSrc") or []:
            for f in block.get("rest") or []:
                url = f.get("file")
                if not url:
                    continue
                hls = f.get("type") == "hls" or ".m3u8" in url
                out.append({
                    "provider": "aniwatch-legacy", "server": str(s.get("server", "legacy")),
                    "host": re.sub(r"^https?://", "", url).split("/")[0], "translationType": trans,
                    "referer": LEGACY_REFERER, "embed": block.get("serverlinkAni") or "", "poster": "",
                    "skip": {}, "subs": [], "url": url, "quality": "auto" if hls else "", "pixels": 0,
                    "type": "hls" if hls else "mp4",
                })
        if out:
            break
    if not out:
        log.append(f"legacy {host}: nenhum servidor devolveu vídeo")
    return out, log
