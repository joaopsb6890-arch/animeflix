"""Provedor hianime.at — catálogo, episódios e servidores de vídeo.

Único agregador que respondeu daqui nas medições: busca, lista de episódios e
HLS resolvem sem cookie. Os embeds usam ofuscação própria (o blob window.__P do
ZokoAnime é base64 + XOR), por isso a decodificação fica centralizada aqui.
"""
import asyncio
import base64
import json
import re
import time
from urllib.parse import parse_qs, quote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from Crypto.Cipher import AES

BASE = "https://hianime.at"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE + "/",
}
ZOKO_XOR_KEY = b"otaku-embed-v1"
# Chaves embutidas no app.main.js do megaplay.buzz; o blob "enc" do getSources é
# AES-256-CBC (PKCS7) em base64url e esconde o master.m3u8 do HD-1.
MEGA_KEY = b"i?LMTAx0Q6,:}50U"
MEGA_IV = b"W0;27ToaUpl_P%'c"
MAX_VARIANTS = 4


class Unsupported(Exception):
    """Servidor conhecido, mas sem decodificação implementada."""


class Cache:
    def __init__(self, ttl: float = 900.0, max_items: int = 512):
        self.ttl, self.max_items, self._d = ttl, max_items, {}

    def get(self, key):
        hit = self._d.get(key)
        if not hit:
            return None
        expires, value = hit
        if expires < time.time():
            self._d.pop(key, None)
            return None
        return value

    def set(self, key, value):
        if len(self._d) >= self.max_items:
            oldest = min(self._d, key=lambda k: self._d[k][0])
            self._d.pop(oldest, None)
        self._d[key] = (time.time() + self.ttl, value)


catalog_cache = Cache(1800)
episodes_cache = Cache(6 * 3600)
servers_cache = Cache(3600)
sources_cache = Cache(1200)


async def _text(client: httpx.AsyncClient, url: str, referer: str = "", headers: dict | None = None) -> str:
    r = await client.get(url, headers={"Referer": referer or BASE + "/", **(headers or {})})
    if r.status_code == 404:
        # 404 no hianime.at significa "não está no site", não falha de rede:
        # LookupError vira 404 na API em vez de 502.
        raise LookupError(f"não existe no hianime.at: {url}")
    r.raise_for_status()
    return r.text


async def _json_api(client, url, referer="", headers=None):
    raw = await _text(client, url, referer, headers)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        if "Just a moment" in raw or "cf-browser-verification" in raw:
            raise RuntimeError("bloqueado pela proteção anti-bot (Cloudflare)")
        raise


# ── parsing de cartões (busca, home, gênero) ──────────────────────────────────
def _int(text):
    m = re.search(r"\d+", text or "")
    return int(m.group()) if m else None


def _slug(href: str) -> str:
    path = urlparse(href or "").path.rstrip("/")
    return path.split("/")[-1] if path else ""


def _txt(el, default=""):
    return el.get_text(" ", strip=True) if el is not None else default


def _id_from_slug(slug: str):
    m = re.search(r"-(\d+)$", slug or "")
    return int(m.group(1)) if m else None


def _parse_item(el) -> dict | None:
    link = (el.select_one("a.dynamic-name") or el.select_one("h3.film-name a")
            or el.select_one("a[href]"))
    if not link:
        return None
    slug = _slug(link.get("href", ""))
    if not slug:
        return None
    item = {
        "_id": slug,
        "id": _id_from_slug(slug),
        "name": (link.get("title") or link.get_text(" ", strip=True) or "").strip(),
        "jname": (link.get("data-jname") or "").strip(),
        "thumbnail": "",
        "score": None,
        "type": "",
        "duration": "",
        "epcount": None,
        "subcount": None,
        "dubcount": None,
        "overview": "",
        "url": BASE + "/watch/" + slug,
    }
    img = el.select_one("img")
    if img:
        item["thumbnail"] = img.get("data-src") or img.get("src") or ""
    tick = el.select_one(".tick-star [data-meanscore]")
    if tick:
        item["score"] = tick.get("data-meanscore")
    item["type"] = _txt(el.select_one(".tick-pg, .tick-item.tick-quality")) or item["type"]
    item["subcount"] = _int(_txt(el.select_one(".tick-item.tick-sub")))
    item["dubcount"] = _int(_txt(el.select_one(".tick-item.tick-dub")))
    item["epcount"] = _int(_txt(el.select_one(".tick-item.tick-eps")))
    fdi = el.select(".fdi-item")
    if fdi:
        item["type"] = fdi[0].get_text(" ", strip=True)
    item["duration"] = _txt(el.select_one(".fdi-duration"))
    item["overview"] = _txt(el.select_one(".description"))[:400]
    if not item["id"]:
        m = re.search(r'data-id="(\d+)"', str(el))
        if m:
            item["id"] = int(m.group(1))
    return item


def _parse_cards(html: str) -> list:
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()
    for el in soup.select(".flw-item"):
        item = _parse_item(el)
        if item and item["_id"] not in seen:
            seen.add(item["_id"])
            out.append(item)
    return out


def _section_items(soup: BeautifulSoup, heading: str) -> list:
    for h2 in soup.select("h2.cat-heading, .block_page h2"):
        if heading not in h2.get_text(" ", strip=True).lower():
            continue
        block = h2.find_parent("div", class_="block_page") or h2.parent
        for _ in range(3):
            if block is None:
                break
            found = block.select(".flw-item")
            if found:
                return [i for i in (_parse_item(el) for el in found) if i]
            block = block.parent
    return []


# ── catálogo ──────────────────────────────────────────────────────────────────
async def search(client, q: str, page: int = 1) -> list:
    key = ("search", q.lower(), page)
    hit = catalog_cache.get(key)
    if hit is not None:
        return hit
    html = await _text(client, f"{BASE}/search?keyword={quote(q)}&page={page}")
    html = html.split('id="main-sidebar"')[0]
    items = _parse_cards(html)
    catalog_cache.set(key, items)
    return items


async def browse(client, path: str, page: int = 1) -> list:
    key = ("browse", path, page)
    hit = catalog_cache.get(key)
    if hit is not None:
        return hit
    sep = "&" if "?" in path else "?"
    html = await _text(client, f"{BASE}/{path.lstrip('/')}{sep}page={page}")
    items = _parse_cards(html)
    catalog_cache.set(key, items)
    return items


async def home(client, page: int = 1) -> dict:
    key = ("home", page)
    hit = catalog_cache.get(key)
    if hit is not None:
        return hit

    async def trending():
        try:
            html = await _text(client, f"{BASE}/home")
            items = _section_items(BeautifulSoup(html, "html.parser"), "trending")
            if items:
                return items
        except Exception:
            pass
        return await browse(client, "most-popular", page)

    recent = await browse(client, "recently-updated", page)
    result = {"trending": await trending(), "recent": recent}
    catalog_cache.set(key, result)
    return result


async def genres(client) -> list:
    hit = catalog_cache.get(("genres",))
    if hit is not None:
        return hit
    html = await _text(client, f"{BASE}/home")
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()
    for a in soup.select('a[href*="/genres/"]'):
        slug = _slug(a.get("href", ""))
        name = a.get_text(" ", strip=True)
        if slug and name and slug not in seen:
            seen.add(slug)
            out.append({"id": slug, "name": name})
    catalog_cache.set(("genres",), out)
    return out


async def details(client, slug_or_id) -> dict:
    """Ficha do anime. Aceita slug ("naruto-1335") ou id numérico ("1335").

    O site só serve /watch/<slug>: um id puro dá 404, então o slug é lido da URL
    que a própria lista de episódios devolve.
    """
    slug_or_id = str(slug_or_id)
    eps = []
    if slug_or_id.isdigit():
        eps = await episodes(client, slug_or_id)
        if not eps:
            raise LookupError(f"anime {slug_or_id} não existe no hianime.at")
        slug = _slug(eps[0].get("url", ""))
    else:
        slug = slug_or_id
    id_hint = _id_from_slug(slug)
    url = f"{BASE}/watch/{slug}"
    html = await _text(client, url)
    soup = BeautifulSoup(html, "html.parser")
    out = {"_id": slug, "id": id_hint, "url": url, "name": slug.replace("-", " ").title()}
    for prop in ("og:title", "og:image", "og:description"):
        tag = soup.find("meta", attrs={"property": prop})
        if tag:
            out[prop.split(":")[1]] = tag.get("content", "")
    out["ticks"] = [t.get_text(" ", strip=True) for t in soup.select(".tick-item")]
    block = soup.select_one(".anisc-detail")
    if block:
        out["name"] = _txt(block.select_one("h2.film-name, .film-name"), out["name"])
        out["overview"] = _txt(block.select_one(".film-description .text, .film-description"))[:800]
        score = _txt(block.select_one(".rr-mark"))
        if _float(score):
            out["score"] = _float(score)
        alias = block.select_one("a.dynamic-name")
        if alias:
            out["englishName"] = alias.get("title") or alias.get_text(" ", strip=True)
    out["episodes"] = eps if eps or not id_hint else await episodes(client, slug)
    return out


# ── episódios ─────────────────────────────────────────────────────────────────
async def episodes(client, slug_or_id) -> list:
    anime_id = slug_or_id if str(slug_or_id).isdigit() else _id_from_slug(str(slug_or_id))
    if not anime_id:
        for item in await search(client, str(slug_or_id).rsplit("-", 1)[0].replace("-", " ")):
            if item["_id"] == str(slug_or_id):
                anime_id = item["id"]
                break
    if not anime_id:
        return []
    key = ("eps", anime_id)
    hit = episodes_cache.get(key)
    if hit is not None:
        return hit
    data = await _json_api(client, f"{BASE}/api/theme/episode/list/{anime_id}")
    soup = BeautifulSoup((data or {}).get("html") or "", "html.parser")
    out = []
    for a in soup.select("a.ep-item, .ep-item"):
        eid = a.get("data-id") or ""
        num = a.get("data-number") or ""
        if not eid:
            continue
        out.append({
            "_id": f"{anime_id}-{eid}",
            "epId": int(eid),
            "episodeIdNum": _int(num),
            "number": num,
            "name": (a.get("title") or "").strip(),
            "fill": bool(a.select_one(".tick-pg")),
            "url": a.get("href", ""),
        })
    episodes_cache.set(key, out)
    return out


def _b64url(text: str) -> str:
    if not text:
        return ""
    try:
        return base64.b64decode(text + "=" * (-len(text) % 4)).decode("utf-8", "replace")
    except Exception:
        return text


async def servers(client, ep_id) -> list:
    key = ("srv", ep_id)
    hit = servers_cache.get(key)
    if hit is not None:
        return hit
    data = await _json_api(client, f"{BASE}/api/theme/episode/servers?episodeId={ep_id}")
    soup = BeautifulSoup((data or {}).get("html") or "", "html.parser")
    out = []
    for div in soup.select(".server-item"):
        url = _b64url(div.get("data-hash") or div.get("data-embed") or "")
        if not url.startswith("http"):
            continue
        out.append({
            "type": (div.get("data-type") or "sub").lower(),
            "name": div.get("data-server-name") or div.get("data-name") or "srv",
            "serverId": div.get("data-server-id"),
            "url": url,
        })
    servers_cache.set(key, out)
    return out


# ── resolução de embeds ───────────────────────────────────────────────────────
def _zoko_blob(html: str) -> dict:
    m = re.search(r'window\.__P\s*=\s*"([^"]+)"', html)
    if not m:
        return {}
    raw = base64.b64decode(m.group(1) + "=" * (-len(m.group(1)) % 4))
    out = bytes(b ^ ZOKO_XOR_KEY[i % len(ZOKO_XOR_KEY)] for i, b in enumerate(raw))
    return json.loads(out.decode("utf-8", "replace"))


def _mega_blob(blob: str) -> dict:
    """Blob "enc" do MegaPlay → dict com o master .m3u8 (AES-256-CBC, PKCS7)."""
    raw = base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4))
    pt = AES.new(MEGA_KEY.ljust(32, b"\0"), AES.MODE_CBC, MEGA_IV).decrypt(raw)
    return json.loads(pt[: -pt[-1]].decode("utf-8", "replace"))


async def _megaplay(client, embed: str, html: str) -> dict:
    """HD-1/MegaPlay: o getSources devolve o HLS cifrado + legendas e intro/outro."""
    did = re.search(r'data-id="(\d+)"', html)
    cid = re.search(r"""cid\s*:\s*['"]([^'"]+)['"]""", html)
    cidu = re.search(r"""cidu\s*:\s*['"]([^'"]+)['"]""", html)
    if not (did and cid and cidu):
        return {}
    q = parse_qs(urlparse(embed).query)
    api = urlparse(embed)
    url = f"{api.scheme}://{api.netloc}/stream/getSources?id={did.group(1)}"
    url += f"&cid={cid.group(1)}&cidu={cidu.group(1)}"
    if q.get("s"):
        url += "&s=" + quote(q["s"][0], safe="")
    data = await _json_api(client, url, referer=embed,
                           headers={"X-Requested-With": "XMLHttpRequest"})
    if not data or not data.get("enc"):
        return {}
    file = _mega_blob(data["enc"]).get("file", "")
    if not file:
        return {}
    return {
        "src": file,
        "subs": [{"lang": t.get("label", ""), "label": t.get("label", ""), "src": t.get("file", "")}
                 for t in data.get("tracks") or []
                 if t.get("kind") == "captions" and t.get("file")],
        "poster": data.get("image") or "",
        "skip": {"intro": data.get("intro") or {}, "outro": data.get("outro") or {}},
    }


async def _variants(client, referer: str, url: str) -> list:
    """Master .m3u8 → fontes por qualidade; lista vazia para vídeo direto."""
    if ".m3u8" not in url:
        return []
    try:
        body = await _text(client, url, referer)
    except Exception:
        return []
    lines = body.splitlines()
    out = []
    for i, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF"):
            continue
        res = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
        bw = re.search(r"BANDWIDTH=(\d+)", line)
        nxt = next((l for l in lines[i + 1:] if l.strip() and not l.startswith("#")), "")
        if not nxt:
            continue
        w, h = (int(res.group(1)), int(res.group(2))) if res else (0, 0)
        out.append({
            "quality": f"{h}p" if h else (str(int(bw.group(1)) // 1000) + "k" if bw else "auto"),
            "pixels": w * h,
            "url": urljoin(url, nxt.strip()),
        })
    return out[:MAX_VARIANTS]


async def resolve(client, server: dict) -> list:
    """Um servidor do hianime → zero ou mais fontes jogáveis."""
    url = server["url"]
    host = urlparse(url).netloc
    key = ("src", url)
    hit = sources_cache.get(key)
    if hit is not None:
        return hit

    referer = f"{urlparse(url).scheme}://{host}/"
    html = await _text(client, url, referer=BASE + "/")

    found = []
    if "zokoanime" in host or "window.__P" in html:
        cfg = _zoko_blob(html)
        if cfg.get("src"):
            found.append({
                "url": cfg["src"],
                "subs": [{"lang": s.get("lang", ""), "label": s.get("label", ""), "url": s.get("src", "")}
                         for s in cfg.get("subtitles") or [] if s.get("src")],
                "poster": cfg.get("poster") or "",
                "skip": cfg.get("skip") or {},
            })
    elif "megaplay" in host or "megacloud" in host:
        mega = await _megaplay(client, url, html)
        if not mega:
            raise Unsupported(f"{server['name']}: o embed não devolveu fonte (campo enc)")
        found.append({
            "url": mega["src"],
            "subs": [{"lang": s["lang"], "label": s["label"], "url": s["src"]} for s in mega["subs"]],
            "poster": mega["poster"], "skip": mega["skip"],
        })
    else:
        for m in re.finditer(r'"(?:file|src|url)"\s*:\s*"(https?://[^"]+\.(?:m3u8|mp4)[^"]*)"', html):
            found.append({"url": m.group(1).replace("\\/", "/"), "subs": [], "poster": "", "skip": {}})
        if not found:
            m = re.search(r'(https?://[^"\'\s]+\.m3u8[^"\'\s]*)', html)
            if m:
                found.append({"url": m.group(1), "subs": [], "poster": "", "skip": {}})

    out = []
    for entry in found:
        video = entry["url"]
        variants = await _variants(client, referer, video)
        base = {
            "provider": "hianime:" + server["name"],
            "server": server["name"],
            "host": host,
            "translationType": server["type"],
            "referer": referer,
            "embed": url,
            "poster": entry["poster"],
            "skip": entry["skip"],
            "subs": [{"lang": s["lang"], "label": s["label"], "url": s["url"], "default": True}
                     for s in entry["subs"]],
        }
        if variants:
            out.extend({**base, "url": v["url"], "quality": v["quality"],
                        "pixels": v["pixels"], "type": "hls"} for v in variants)
        else:
            out.append({**base, "url": video, "quality": "", "pixels": 0,
                        "type": "hls" if ".m3u8" in video else "mp4"})
    sources_cache.set(key, out)
    return out


def find_episode(eps, want) -> dict | None:
    """Episódio cujo número casa com `want` (aceita "1", "1.0" e "12-13")."""
    want = re.sub(r"\.0+$", "", str(want).strip())
    exact = next((e for e in eps if str(e.get("number") or "") == want
                  or str(e.get("number") or "").endswith("-" + want)), None)
    if exact:
        return exact
    num = _float(want)
    return next((e for e in eps if _float(e.get("number")) == num), None) if num is not None else None


async def streams(client, slug_or_id, episode, trans: str = "sub",
                  only_server: str = "") -> tuple:
    """(fontes ordenadas, log de tentativas) para um episódio."""
    log = []
    eps = await episodes(client, slug_or_id)
    if not eps:
        return [], ["hianime: sem episódios para " + str(slug_or_id)]

    ep = find_episode(eps, episode)
    if ep is None:
        return [], [f"hianime: episódio {episode} não existe nesta série ({len(eps)} disponíveis)"]

    all_srvs = await servers(client, ep["epId"])
    srvs = [s for s in all_srvs if s["type"] == trans]
    if not srvs:
        have = sorted({x["type"] for x in all_srvs})
        return [], [f"hianime: ep {episode} não tem '{trans}' (tem: {', '.join(have) or 'nenhum servidor'})"]
    if only_server:
        picked = [s for s in srvs if only_server.lower() in s["name"].lower()]
        srvs = picked or srvs

    results = await asyncio.gather(*(resolve(client, s) for s in srvs), return_exceptions=True)
    out = []
    for srv, res in zip(srvs, results):
        if isinstance(res, Unsupported):
            log.append(f"hianime:{srv['name']} — {res}")
        elif isinstance(res, Exception):
            log.append(f"hianime:{srv['name']} — {type(res).__name__}: {str(res)[:120]}")
        elif res:
            out.extend(res)
        else:
            log.append(f"hianime:{srv['name']} — sem fontes no embed")
    out.sort(key=lambda s: (0 if s["type"] == "hls" else 1, -(s.get("pixels") or 0)))
    if not out:
        log.append("hianime: nenhum servidor produziu fonte jogável")
    return out, log


def _float(text):
    m = re.search(r"\d+(?:\.\d+)?", text or "")
    return float(m.group()) if m else None
