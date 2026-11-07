"""subdl.com — busca e extração de legendas em PT-BR.

A API só responde com uma chave (variável de ambiente SUBDL_KEY, nunca no
código). Sem ela este módulo é chamado de nada: as rotas devolvem 501.

Dois detalhes do subdl que definem o desenho:

* O download vem como **.zip**, não como texto. O parser de legenda do app
  (AF.parseCues) entende SRT/VTT, então o arquivo é aberto aqui no servidor e
  a rota devolve texto puro — o player nunca vê um compactado.
* A chave não vai ao navegador. O frontend recebe `/subs/file?f=<token>`, um
  token opaco; a chave fica neste lado.

Não foi possível validar os nomes exatos dos parâmetros contra a API real
(precisa da chave do usuário). `_params()` e LANGS são os dois únicos lugares
a ajustar se o primeiro `GET /subs/search` real vier vazio por motivo de filtro.
"""
import io
import os
import re
import time
import zipfile
from urllib.parse import quote, urlparse

import httpx

API = "https://api.subdl.com/api/v1/subtitles"
DL_HOST = "dl.subdl.com"
MAX_ARCHIVE = 4 * 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024
# Ordem importa: o formato do filtro de idioma é a coisa mais provável de
# divergir da documentação, então tentamos um, depois o outro, depois nenhum.
LANGS = ("BR_PT", "pt-BR", "PT")
TOKEN_RE = re.compile(r"^[0-9]+(-[0-9]+)?\.zip$")
TEXT_EXT = (".srt", ".vtt")

_cache = {}


class NoKey(Exception):
    """SUBDL_KEY não está definida — a rota traduz para 501."""


class BadKey(Exception):
    """A API respondeu 403: a chave existe, mas foi recusada."""


def have_key() -> bool:
    return bool((os.environ.get("SUBDL_KEY") or "").strip())


def _key() -> str:
    key = (os.environ.get("SUBDL_KEY") or "").strip()
    if not key:
        raise NoKey()
    return key


def _ttl_set(key: str, value) -> None:
    now = time.time()
    for old in [k for k, (e, _) in _cache.items() if e < now]:
        _cache.pop(old, None)
    if len(_cache) > 128:
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]), None)
    _cache[key] = (now + 3600, value)


# ── busca ─────────────────────────────────────────────────────────────────────
def _params(q: str, ep, season, lang) -> dict:
    p = {"type": "tv", "film_name": q, "subs_per_page": "25", "api_key": _key()}
    if ep not in (None, ""):
        p["episode_number"] = str(ep)
    if season not in (None, ""):
        p["season_number"] = str(season)
    if lang:
        p["languages"] = lang
    return p


def _headers(key: str) -> dict:
    # As duas formas de autenticação convivem: a documentação e as reproduções
    # públicas usam `api_key` na query, e o header APIKEY é o que evita o log.
    return {"APIKEY": key, "Accept": "application/json", "Referer": "https://subdl.com/"}


def _is_pt(item: dict) -> bool:
    short = str(item.get("lang_short") or "").lower()
    long = str(item.get("lang") or "").lower()
    return short.startswith("pt") or "portuguese" in long or "brasileiro" in long


def _file_ref(item: dict) -> str:
    """Extrai o nome do arquivo .zip de qualquer uma das formas que a API já usou."""
    for field in ("subtitles", "files"):
        arr = item.get(field)
        if isinstance(arr, list):
            for entry in arr:
                if not isinstance(entry, dict):
                    continue
                for url_key in ("url", "link", "file"):
                    u = entry.get(url_key)
                    if isinstance(u, str) and u.strip():
                        return u.strip()
    for url_key in ("url", "link"):
        u = item.get(url_key)
        if isinstance(u, str) and u.lower().endswith(".zip"):
            return u.strip()
    return ""


def _token_from(url: str) -> str:
    """Só aceita o nome do arquivo no host esperado — nada de URL arbitrária."""
    path = urlparse(url).path
    if not path:
        return ""
    return path.rsplit("/", 1)[-1]


def _lower(item: dict) -> dict | None:
    token = _token_from(_file_ref(item))
    if not token or not TOKEN_RE.match(token):
        return None
    name = str(item.get("name") or "").strip()
    ep = item.get("episodes") or item.get("episode")
    if isinstance(ep, list):
        ep = ep[0] if ep else ""
    release = str(item.get("release") or "").strip()
    bits = [b for b in (name, ("Ep " + str(ep)) if ep not in (None, "") else "",
                        release, "PT-BR") if b]
    label = " · ".join(bits) or "legenda PT-BR"
    flag = []
    if item.get("machine_translated"):
        flag.append("máquina")
    if item.get("hi"):
        flag.append("def auditivos")
    if flag:
        label += " (" + ", ".join(flag) + ")"
    return {
        "label": label,
        "lang": "pt-BR",
        "url": "/subs/file?f=" + quote(token, safe=""),
        "token": token,
        "downloads": item.get("downloads") or 0,
        "stars": item.get("stars") or 0,
        "default": bool(item.get("default")),
        "machine_translated": bool(item.get("machine_translated")),
    }


async def _query(client: httpx.AsyncClient, q: str, ep, season, lang):
    r = await client.get(API, params=_params(q, ep, season, lang), headers=_headers(_key()))
    if r.status_code in (401, 403):
        raise BadKey()
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and data.get("status") is False:
        raise BadKey()
    items = data.get("results") if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


async def search(client: httpx.AsyncClient, q: str, ep=None, season=None) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    cached = _cache.get(("s", q.lower(), str(ep), str(season)))
    if cached and cached[0] > time.time():
        return cached[1]

    out: list[dict] = {}
    for lang in LANGS:
        for item in await _query(client, q, ep, season, lang):
            if isinstance(item, dict):
                low = _lower(item)
                if low:
                    out.setdefault(low["token"], low)
        if out:
            break

    if not out:
        # Sem filtro de idioma: a busca por título pode ter ignorado o nosso
        # formato de `languages`, então filtramos aqui pelo que a resposta diz.
        for item in await _query(client, q, ep, season, None):
            if isinstance(item, dict) and _is_pt(item):
                low = _lower(item)
                if low:
                    out.setdefault(low["token"], low)

    # Legenda "default" da API primeiro, depois as mais baixadas: é o critério
    # que o usuário usaria num site desses.
    ranked = sorted(out.values(), key=lambda r: (not r["default"], -int(r["downloads"] or 0)))
    _ttl_set(("s", q.lower(), str(ep), str(season)), ranked)
    return ranked


# ── download + desempacotamento ───────────────────────────────────────────────
def _pick(archive: zipfile.ZipFile) -> bytes:
    best = None
    for info in archive.infolist():
        if info.is_dir():
            continue
        name = info.filename.rsplit("/", 1)[-1].lower()
        if not name.endswith(TEXT_EXT):
            continue
        if info.file_size > MAX_TEXT:
            continue
        # prefere o que bate com o idioma no nome; .vtt antes de .srt (já vem pronto)
        rank = (0 if name.endswith(".vtt") else 1, 0 if "pt" in name or "por" in name else 1)
        if best is None or rank < best[0]:
            best = (rank, info)
    if best is None:
        raise LookupError("o arquivo não contém legenda .srt/.vtt")
    return archive.read(best[1])


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


async def subtitle_text(client: httpx.AsyncClient, token: str) -> str:
    if not TOKEN_RE.match(token or ""):
        raise ValueError("token de legenda inválido")
    cached = _cache.get(("f", token))
    if cached and cached[0] > time.time():
        return cached[1]
    key = _key()
    url = "https://" + DL_HOST + "/subtitle/" + quote(token, safe="") + "?api_key=" + quote(key, safe="")
    r = await client.get(url, headers={"Accept": "*/*"})
    if r.status_code in (401, 402, 403):
        # 402 apareceu em junho/2026 quando o subdl passou a exigir plano pago
        # para download; voltou atrás, mas o texto aqui deixa isso claro.
        if r.status_code == 402:
            raise LookupError("o subdl exigiu plano pago para baixar esta legenda")
        raise BadKey()
    r.raise_for_status()
    blob = r.content[:MAX_ARCHIVE]
    try:
        text = _decode(_pick(zipfile.ZipFile(io.BytesIO(blob))))
    except zipfile.BadZipFile:
        # algumas faixas vêm como texto puro apesar do nome .zip
        text = _decode(blob)
    if not text.strip():
        raise LookupError("legenda vazia")
    _ttl_set(("f", token), text)
    return text
