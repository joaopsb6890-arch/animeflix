"""AnimeFlix — API + frontend, pronto para rodar num servidor público.

Fontes de episódio: /anime/stream resolve todos os servidores do anime e devolve
uma lista ordenada (HLS primeiro, maior qualidade antes). O /proxy existe porque
essas fontes exigem Referer e não têm CORS: sem ele o player não reproduz nada.

Uso público — o que mudou em relação à versão local:
* /proxy só aceita URLs ASSINADAS pelo próprio servidor (HMAC). Antes qualquer
  pessoa podia usar o servidor como proxy aberto; agora só passa o que a API
  mesma entregou (vídeo, legenda, pôster e os segmentos reescritos do .m3u8).
* limite de requisições por IP e de streams simultâneos (não derruba o servidor).
* bloqueio de hosts privados também por DNS (SSRF), não só por IP literal.
* gzip, cache de estáticos e cache-bust automático dos scripts.
* HOST/PORT lidos do ambiente: em nuvem ouve em 0.0.0.0 na porta do provedor.
"""
import asyncio
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlparse, urljoin, quote

import httpx
from fastapi import FastAPI, Request, Query, Path, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.middleware.gzip import GZipMiddleware

import hianime
import movies
import ptbr
import subs
import titles
import upstream

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DEFAULT_REF = hianime.BASE
VALID_TRANS = {"sub", "dub", "sub-pt", "dub-pt"}
PT_TRANS = {"sub-pt", "dub-pt"}

# Segredo das assinaturas do /proxy. Defina PROXY_SECRET em produção: sem ele um
# valor aleatório nasce a cada boot e os links já entregues deixam de valer.
SECRET = (os.environ.get("PROXY_SECRET") or secrets.token_hex(32)).encode()
TRUST_PROXY = os.environ.get("TRUST_PROXY", "1") != "0"
PROXY_MAX = int(os.environ.get("PROXY_MAX", "60"))        # streams simultâneos
RATES = {                                                   # (pedidos, por 60 s) por IP
    "api": int(os.environ.get("RATE_API", "120")),
    "proxy": int(os.environ.get("RATE_PROXY", "2400")),
    "subs": int(os.environ.get("RATE_SUBS", "40")),
}

_client: Optional[httpx.AsyncClient] = None


async def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            headers=hianime.BASE_HEADERS,
            timeout=httpx.Timeout(20.0, read=90.0),
            follow_redirects=True,
        )
    return _client


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()


# ── assinatura das URLs do /proxy ─────────────────────────────────────────────
def _sig(url: str, ref: str) -> str:
    return hmac.new(SECRET, (url + "\n" + ref).encode(), hashlib.sha256).hexdigest()[:24]


def psign(url: str, ref: str = "") -> str:
    """URL de origem → caminho /proxy assinado (relativo: vale em qualquer domínio)."""
    if not url or url.startswith("/proxy?"):
        return url
    return "/proxy?url=" + quote(url, safe="") + "&ref=" + quote(ref, safe="") + "&sig=" + _sig(url, ref)


def _sign_source(src: dict) -> dict:
    """Cópia da fonte com url, legendas e pôster já passando pelo proxy assinado."""
    ref = src.get("referer") or ""
    out = dict(src)
    out["url"] = src["url"] if src.get("direct") else psign(src.get("url", ""), ref)
    if src.get("poster"):
        out["poster"] = psign(src["poster"], ref)
    out["subs"] = [dict(t, url=psign(t.get("url", ""), ref)) for t in src.get("subs") or [] if t.get("url")]
    return out


# ── limite de uso por IP (janela fixa de 60 s, em memória) ────────────────────
class RateLimit:
    """ASGI puro (não BaseHTTPMiddleware): não atrapalha o streaming do /proxy."""

    def __init__(self, app):
        self.app = app
        self.hits = {}

    @staticmethod
    def _kind(path: str) -> Optional[str]:
        if path.startswith("/proxy"):
            return "proxy"
        if path.startswith("/subs"):
            return "subs"
        if path.startswith("/anime") or path.startswith("/api"):
            return "api"
        return None

    def _ip(self, scope) -> str:
        if TRUST_PROXY:
            for k, v in scope.get("headers", []):
                if k in (b"cf-connecting-ip", b"fly-client-ip", b"x-real-ip"):
                    return v.decode()[:64]
                if k == b"x-forwarded-for":
                    return v.decode().split(",")[0].strip()[:64]
        return (scope.get("client") or ("?", 0))[0]

    async def __call__(self, scope, receive, send):
        kind = self._kind(scope.get("path", "")) if scope["type"] == "http" else None
        if kind:
            now = int(time.time() // 60)
            key = (self._ip(scope), kind)
            win, n = self.hits.get(key, (now, 0))
            if win != now:
                win, n = now, 0
            n += 1
            self.hits[key] = (win, n)
            if len(self.hits) > 20000:
                self.hits = {k: v for k, v in self.hits.items() if v[0] == now}
            if n > RATES[kind]:
                body = b'{"detail":"Muitas requisi\xc3\xa7\xc3\xb5es. Espere um minuto."}'
                await send({"type": "http.response.start", "status": 429, "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"retry-after", b"30"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


class SmartGzip:
    """gzip em tudo, menos no /proxy (vídeo já é comprimido e vira lixo no gzip)."""

    def __init__(self, app):
        self.app = app
        self.gz = GZipMiddleware(app, minimum_size=700)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not scope["path"].startswith("/proxy"):
            return await self.gz(scope, receive, send)
        return await self.app(scope, receive, send)


class CachedStatic(StaticFiles):
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        if r.status_code == 200:
            r.headers["Cache-Control"] = "public, max-age=3600"
        return r


app = FastAPI(title="AnimeFlix API", version="4.0.0", lifespan=lifespan,
              docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])
os.makedirs(STATIC, exist_ok=True)
app.add_middleware(RateLimit)
app.add_middleware(SmartGzip)
app.mount("/static", CachedStatic(directory=STATIC), name="static")


def _fail(err: Exception) -> HTTPException:
    if isinstance(err, HTTPException):
        return err
    if isinstance(err, LookupError):
        return HTTPException(404, str(err))
    return HTTPException(502, f"{type(err).__name__}: {str(err)[:200]}")


def _card(item: dict) -> dict:
    """Adiciona os aliases que o frontend já entende (formato AllAnime)."""
    out = dict(item)
    out["englishName"] = out.get("name") or ""
    if out.get("thumbnail") and not out["thumbnail"].startswith("http"):
        out["thumbnail"] = urljoin(DEFAULT_REF + "/", out["thumbnail"])
    out.setdefault("description", out.get("overview", ""))
    out["node"] = dict(out)
    return out


# ── catálogo ──────────────────────────────────────────────────────────────────
@app.get("/anime/home")
async def home(page: int = Query(1, ge=1), translationType: str = Query("sub")):
    try:
        data = await hianime.home(await get_client(), page)
    except Exception as e:
        raise _fail(e)
    return {
        "trending": [_card(i) for i in data["trending"]],
        "recent": [_card(i) for i in data["recent"]],
        "page": page,
    }


@app.get("/anime/search")
async def search(q: str = Query(...), page: int = Query(1, ge=1),
                 limit: int = Query(24, ge=1, le=50)):
    if not q.strip():
        raise HTTPException(400, "q vazio")
    try:
        items = await hianime.search(await get_client(), q.strip(), page)
    except Exception as e:
        raise _fail(e)
    return {"results": [_card(i) for i in items[:limit]], "page": page,
            "limit": limit, "hasNextPage": len(items) > limit}


@app.get("/anime/browse")
async def browse(path: str = Query("most-popular"), page: int = Query(1, ge=1)):
    clean = re.sub(r"[^a-z0-9_\-/?=&]", "", path.lower())
    if not clean or clean.startswith("//"):
        raise HTTPException(400, "path inválido")
    try:
        items = await hianime.browse(await get_client(), clean, page)
    except Exception as e:
        raise _fail(e)
    return {"results": [_card(i) for i in items], "page": page}


@app.get("/anime/genres")
async def genres():
    try:
        return {"genres": await hianime.genres(await get_client())}
    except Exception as e:
        raise _fail(e)


@app.get("/anime/details/{show_id}")
async def details(show_id: str = Path(...)):
    try:
        return await hianime.details(await get_client(), show_id)
    except Exception as e:
        raise _fail(e)


@app.get("/anime/episodes/{show_id}")
async def episodes(show_id: str = Path(...)):
    try:
        eps = await hianime.episodes(await get_client(), show_id)
    except Exception as e:
        raise _fail(e)
    return {"showId": show_id, "total": len(eps), "episodes": eps}


@app.get("/anime/servers/{show_id}")
async def servers(show_id: str = Path(...), ep: str = Query(...)):
    """Servidores disponíveis de um episódio, para o seletor do app."""
    try:
        eps = await hianime.episodes(await get_client(), show_id)
        target = hianime.find_episode(eps, ep)
        if not target:
            raise HTTPException(404, f"episódio {ep} não encontrado")
        srvs = await hianime.servers(await get_client(), target["epId"])
    except HTTPException:
        raise
    except Exception as e:
        raise _fail(e)
    return {"showId": show_id, "episode": ep, "epId": target["epId"],
            "servers": [{"type": s["type"], "name": s["name"], "serverId": s["serverId"]}
                        for s in srvs]}


# ── streams ───────────────────────────────────────────────────────────────────
async def _en_sources(client, show_id: str, ep: str, trans: str, server: str = ""):
    """sub/dub do hianime; se o scraper interno falhar, tenta as APIs reservas do GitHub."""
    sources, log = await hianime.streams(client, show_id, ep, trans, server)
    if sources:
        return sources, log
    try:
        if upstream.enabled():                              # aniwatch-api (v2) próprio
            eps = await hianime.episodes(client, show_id)
            target = hianime.find_episode(eps, ep)
            if target:
                more, ulog = await upstream.streams(client, show_id, target["epId"], trans)
                sources, log = more, log + ulog
        if not sources:                                     # API pública do README (formato antigo)
            more, ulog = await upstream.legacy_streams(client, show_id, ep, trans)
            sources, log = more, log + ulog
    except Exception as e:                                  # noqa: BLE001 — reserva nunca derruba o player
        log.append(f"reserva: {type(e).__name__} {str(e)[:80]}")
    return sources, log


@app.get("/anime/stream/{show_id}")
async def stream(show_id: str = Path(...), ep: str = Query(...),
                 translationType: str = Query("sub"), server: str = Query(""),
                 title: str = Query("", max_length=200)):
    """Fontes de um episódio. sub/dub vêm do hianime; sub-pt/dub-pt do provedor PT-BR."""
    trans = translationType if translationType in VALID_TRANS else "sub"
    try:
        client = await get_client()
        if trans in PT_TRANS:
            sources, log = await ptbr.streams(client, show_id, ep, trans == "dub-pt", title)
        else:
            sources, log = await _en_sources(client, show_id, ep, trans, server)
    except Exception as e:
        raise _fail(e)
    return {"showId": show_id, "episode": ep, "translationType": trans,
            "server": server, "sources": [_sign_source(x) for x in sources], "log": log}


@app.get("/anime/diagnose/{show_id}")
async def diagnose(show_id: str = Path(...), ep: str = Query("1"),
                   tt: str = Query("dub-pt"), title: str = Query("", max_length=200)):
    """Passo a passo de por que um áudio não aparece. Abra no navegador e me mande o resultado."""
    if tt not in VALID_TRANS:
        raise HTTPException(400, "tt inválido")
    client = await get_client()
    out = {"showId": show_id, "ep": ep, "tt": tt, "upstream": upstream.enabled(),
           "ptbrBase": ptbr.BASE, "trace": []}
    try:
        if tt in PT_TRANS:
            sources, log = await ptbr.streams(client, show_id, ep, tt == "dub-pt", title, out["trace"])
        else:
            sources, log = await _en_sources(client, show_id, ep, tt, "")
        out["log"] = log
        out["sources"] = [{"server": x["server"], "type": x["type"], "quality": x["quality"],
                           "host": x["host"]} for x in sources]
    except Exception as e:                  # noqa: BLE001
        out["erro"] = f"{type(e).__name__}: {str(e)[:200]}"
    return out


@app.get("/anime/audios/{show_id}")
async def audios(show_id: str = Path(...), ep: str = Query("1"),
                 title: str = Query("", max_length=200)):
    """Quais áudios existem (sub, dub, sub-pt, dub-pt): o menu esconde o que não há."""
    client = await get_client()

    async def hi():
        eps = await hianime.episodes(client, show_id)
        target = hianime.find_episode(eps, ep) or (eps[0] if eps else None)
        types = {s["type"] for s in await hianime.servers(client, target["epId"])} if target else set()
        return {"sub": "sub" in types, "dub": "dub" in types}

    hi_r, pt_r = await asyncio.gather(hi(), ptbr.available(client, show_id, title),
                                      return_exceptions=True)
    out = {"sub": True, "dub": False, "sub-pt": False, "dub-pt": False}
    if isinstance(hi_r, dict):
        out.update(hi_r)
    if isinstance(pt_r, dict):
        out.update(pt_r)
    return out


@app.get("/api/config")
async def config():
    """O que este servidor oferece — o app usa para esconder o que não funciona."""
    return {"name": "AnimeFlix", "version": app.version,
            "features": {"subdl": subs.have_key(), "ptbr": True, "tmdb": movies.have_tmdb(),
                         "youtube": movies.have_youtube(),
                         "upstream": upstream.enabled() or upstream.legacy_enabled()}}


# ── filmes e séries ───────────────────────────────────────────────────────────
@app.get("/api/trailer")
async def trailer(q: str = Query(..., min_length=2, max_length=120)):
    try:
        return {"videoId": await movies.youtube_trailer(await get_client(), q)}
    except Exception as e:
        raise _fail(e)


@app.get("/movies/list")
async def movies_list(which: str = Query("trending", pattern="^(trending|popular|top)$"),
                      kind: str = Query("movie", pattern="^(movie|tv)$"), page: int = Query(1, ge=1, le=20)):
    try:
        return {"results": await movies.listing(await get_client(), which, kind, page)}
    except Exception as e:
        raise _fail(e)


@app.get("/movies/search")
async def movies_search(q: str = Query(..., min_length=2, max_length=100),
                        kind: str = Query("movie", pattern="^(movie|tv)$"), page: int = Query(1, ge=1, le=20)):
    try:
        return {"results": await movies.search(await get_client(), q, kind, page)}
    except Exception as e:
        raise _fail(e)


@app.get("/movies/detail/{kind}/{tmdb_id}")
async def movies_detail(kind: str = Path(..., pattern="^(movie|tv)$"), tmdb_id: int = Path(..., ge=1)):
    try:
        return await movies.detail(await get_client(), kind, tmdb_id)
    except Exception as e:
        raise _fail(e)


@app.get("/movies/free")
async def movies_free(q: str = Query("", max_length=100), page: int = Query(1, ge=1, le=30)):
    try:
        return {"results": await movies.free_list(await get_client(), q.strip(), page)}
    except Exception as e:
        raise _fail(e)


@app.get("/movies/stream/{ident}")
async def movies_stream(ident: str = Path(...), ep: str = Query("1"), translationType: str = Query("sub"),
                        title: str = Query("", max_length=200), server: str = Query("")):
    """Mesmo formato de /anime/stream, para o player tocar filmes de domínio público."""
    try:
        sources = await movies.free_stream(await get_client(), ident)
    except Exception as e:
        raise _fail(e)
    return {"showId": ident, "episode": "1", "translationType": "sub", "server": "",
            "sources": [_sign_source(x) for x in sources], "log": []}


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True}


# ── legendas PT-BR (subdl.com) ────────────────────────────────────────────────
@app.get("/subs/search")
async def subs_search(q: str = Query(...), ep: str = Query(""), season: str = Query("")):
    """Busca legendas em português. 501 sem SUBDL_KEY, lista vazia sem match."""
    if not q.strip():
        raise HTTPException(400, "q vazio")
    try:
        results = await subs.search(await get_client(), q.strip(), ep.strip(), season.strip())
    except subs.NoKey:
        raise HTTPException(501, "legendas PT-BR exigem a variável SUBDL_KEY "
                                 "(chave grátis de subdl.com) no servidor")
    except subs.BadKey:
        raise HTTPException(501, "a chave do subdl foi recusada — confira SUBDL_KEY")
    except Exception as e:
        raise _fail(e)
    return {"query": q, "episode": ep, "results": results}


@app.get("/subs/file")
async def subs_file(f: str = Query(...)):
    """Desempacota o .zip do subdl e devolve texto puro (SRT ou VTT).

    O token é o nome do arquivo, validado por regex em subs.py: nada de URL
    arbitrária sendo buscada por aqui, e a chave nunca chega ao navegador.
    """
    try:
        text = await subs.subtitle_text(await get_client(), f)
    except ValueError:
        raise HTTPException(400, "token de legenda inválido")
    except subs.NoKey:
        raise HTTPException(501, "legendas PT-BR exigem a variável SUBDL_KEY")
    except subs.BadKey:
        raise HTTPException(501, "a chave do subdl foi recusada — confira SUBDL_KEY")
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise _fail(e)
    head = text.lstrip()[:8].upper()
    media = "text/vtt; charset=utf-8" if head.startswith("WEBVTT") else "text/plain; charset=utf-8"
    return Response(text, media_type=media)


# ── proxy de vídeo (Referer + CORS + HLS) ─────────────────────────────────────
_dns_ok = {}


def _ip_ok(ip) -> bool:
    return ip.is_global and not ip.is_multicast


async def _check_proxy_url(url: str):
    """http(s) para host público. Resolve o DNS: um nome que aponta para 10.x ou
    127.x (SSRF) é recusado como se fosse o IP literal."""
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https") or not host or host in ("localhost", "0.0.0.0"):
        raise HTTPException(400, "URL inválida")
    try:
        if not _ip_ok(ipaddress.ip_address(host)):
            raise HTTPException(400, "URL inválida")
        return
    except ValueError:
        pass
    hit = _dns_ok.get(host)
    if hit and hit > time.time():
        return
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None)
    except OSError:
        raise HTTPException(502, "host não resolve")
    if not infos or not all(_ip_ok(ipaddress.ip_address(i[4][0])) for i in infos):
        raise HTTPException(400, "URL inválida")
    if len(_dns_ok) > 2000:
        _dns_ok.clear()
    _dns_ok[host] = time.time() + 300


def _rewrite_m3u8(text: str, base: str, ref: str) -> str:
    def prox(u: str) -> str:
        return psign(urljoin(base, u), ref)

    out = []
    for line in text.splitlines():
        st = line.strip()
        if not st:
            out.append(line)
        elif st.startswith("#EXT-X-STREAM-INF") or (st.startswith("#") and "URI=" not in st):
            out.append(line)
        elif st.startswith("#"):
            out.append(re.sub(r'URI="([^"]+)"', lambda m: 'URI="' + prox(m.group(1)) + '"', line))
        else:
            out.append(prox(st))
    return "\n".join(out) + "\n"


_active = 0


def _release():
    global _active
    _active = max(0, _active - 1)


@app.api_route("/proxy", methods=["GET", "HEAD"])
async def proxy_video(request: Request, url: str = Query(...), ref: str = Query(""),
                      sig: str = Query("")):
    global _active
    if not hmac.compare_digest(sig.encode(), _sig(url, ref).encode()):
        raise HTTPException(403, "link do proxy inválido ou expirado — recarregue o episódio")
    await _check_proxy_url(url)
    ref_raw = ref
    ref = (ref or DEFAULT_REF).rstrip("/")
    headers = {
        "Referer": ref + "/",
        "Origin": ref,
        "User-Agent": hianime.UA,
        "Accept-Encoding": "identity",
    }
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]

    if _active >= PROXY_MAX:
        raise HTTPException(503, "servidor cheio, tente de novo em instantes",
                            headers={"Retry-After": "5"})
    _active += 1
    handed_off = False
    try:
        client = await get_client()
        try:
            r = await client.send(client.build_request(request.method, url, headers=headers), stream=True)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Falha ao buscar o vídeo: {type(e).__name__}")

        if r.status_code >= 400:
            body = (await r.aread())[:200]
            await r.aclose()
            raise HTTPException(r.status_code, f"Origem recusou ({r.status_code}): {body!r}")

        ctype = r.headers.get("Content-Type", "")
        if ".m3u8" in urlparse(url).path or "mpegurl" in ctype.lower():
            text = (await r.aread()).decode("utf-8", "replace")
            await r.aclose()
            return Response(_rewrite_m3u8(text, url, ref_raw),
                            media_type="application/vnd.apple.mpegurl",
                            headers={"Cache-Control": "no-store"})

        out = {"Accept-Ranges": "bytes", "Content-Type": ctype or "video/mp4"}
        for h in ("Content-Range", "Content-Length"):
            if h in r.headers:
                out[h] = r.headers[h]

        async def close():
            await r.aclose()
            _release()

        handed_off = True
        return StreamingResponse(r.aiter_raw(), status_code=r.status_code, headers=out,
                                 background=BackgroundTask(close))
    finally:
        if not handed_off:
            _release()


# ── frontend ──────────────────────────────────────────────────────────────────
_index_cache = {"key": None, "html": ""}


def _static_version() -> str:
    newest = 0
    for name in os.listdir(STATIC):
        if name.endswith((".js", ".css")):
            newest = max(newest, int(os.path.getmtime(os.path.join(STATIC, name))))
    return str(newest)


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def frontend():
    """index.html com ?v=<data do arquivo> nos scripts: quem atualiza o servidor
    não deixa ninguém preso numa versão antiga em cache."""
    path = os.path.join(HERE, "index.html")
    if not os.path.exists(path):
        return HTMLResponse("<h1>Erro: index.html não encontrado</h1>", status_code=500)
    key = (os.path.getmtime(path), _static_version())
    if _index_cache["key"] != key:
        with open(path, encoding="utf-8") as f:
            html = f.read()
        html = re.sub(r'(/static/[\w\-./]+\.(?:js|css))(?=")', lambda m: m.group(1) + "?v=" + key[1], html)
        _index_cache.update(key=key, html=html)
    return HTMLResponse(_index_cache["html"], headers={"Cache-Control": "no-cache"})


# Os PNGs saem de make_icons.sh (fonte única: static/icons/animeflix.svg). Um SVG de
# emoji no manifest fazia o Android instalar um quadrado com emoji — por isso a lista
# explícita de tamanhos, com "maskable" separado de "any".
_MANIFEST_ICONS = [
    {"src": "/static/icons/animeflix.svg", "sizes": "any", "type": "image/svg+xml",
     "purpose": "any"},
] + [
    {"src": f"/static/icons/icon-{n}.png", "sizes": f"{n}x{n}", "type": "image/png",
     "purpose": "any"} for n in (48, 72, 96, 144, 192, 512)
] + [
    {"src": f"/static/icons/maskable-{n}.png", "sizes": f"{n}x{n}", "type": "image/png",
     "purpose": "maskable"} for n in (192, 512)
]


@app.get("/manifest.json", include_in_schema=False)
async def manifest():
    return JSONResponse({
        "name": "AnimeFlix", "short_name": "AnimeFlix", "start_url": "/",
        "display": "standalone", "background_color": "#0b0a10", "theme_color": "#0b0a10",
        "lang": "pt-BR", "description": "Assista anime online, dublado e legendado em português.",
        "icons": _MANIFEST_ICONS,
    })


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return Response("self.addEventListener('fetch',()=>{});", media_type="application/javascript")


if __name__ == "__main__":
    import uvicorn
    # Em nuvem o provedor define PORT: aí o servidor precisa ouvir em 0.0.0.0.
    default_host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    uvicorn.run("main:app", host=os.environ.get("HOST", default_host),
                port=int(os.environ.get("PORT", 8000)), reload=False,
                proxy_headers=True, forwarded_allow_ips="*")
