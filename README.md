# AnimeFlix

App web (e APK) para assistir anime com **dublagem e legenda em português**. Backend FastAPI, front em JS puro (sem build).

## Colocar no ar para todo mundo

**Render (grátis, mais simples)**
1. Suba esta pasta num repositório do GitHub.
2. render.com → *New → Blueprint* → escolha o repositório (usa o `render.yaml`).
3. Pronto: o endereço `https://animeflix-xxxx.onrender.com` abre no navegador de qualquer pessoa.
   No celular: menu do navegador → *Adicionar à tela inicial* (ou *Mais → Instalar o app*).

**Fly.io**: `fly launch --copy-config` e depois `fly secrets set PROXY_SECRET=$(openssl rand -hex 32)` e `fly deploy`.

**Qualquer VPS**: `docker build -t animeflix . && docker run -p 80:8080 -e PROXY_SECRET=... animeflix`.

Variáveis: `PROXY_SECRET` (obrigatória em produção), `SUBDL_KEY` (opcional, legenda PT-BR automática — chave grátis em subdl.com), `PTBR_BASE` (se o domínio do provedor PT-BR mudar), `RATE_API`, `RATE_PROXY`, `PROXY_MAX`.

> O vídeo passa pelo seu servidor. Planos grátis têm limite de banda e o plano grátis do Render dorme após inatividade (primeiro acesso demora ~30 s).

## APK apontando para o servidor público
    APP_URL=https://animeflix-xxxx.onrender.com ./build_apk.sh
O APK é só um WebView desse endereço: **não precisa mais do Termux rodando**. Mudanças no front não exigem recompilar.

## Rodar local (teste)
    pip install -r requirements.txt && python main.py     # http://127.0.0.1:8000

## Áudio e legenda
| Opção | Origem |
|---|---|
| Dublado PT-BR / Legendado PT-BR | provedor PT-BR (`ptbr.py`) |
| Original + legenda | hianime; legenda PT-BR vem do vídeo (se houver) ou do SubDL automaticamente |
| Dublado em inglês | hianime |

Se o episódio não tiver o áudio escolhido, o player desce a lista (dub PT-BR → leg. PT-BR → original → inglês) e avisa.

## Segurança do modo público
`/proxy` só aceita links **assinados pelo próprio servidor** (HMAC), bloqueia hosts privados (SSRF), limita requisições por IP e streams simultâneos.

## Se algo quebrar
Os sites de origem mudam. Ajustes ficam em `hianime.py` (catálogo/embeds) e `ptbr.py` (`_cards`, `_video_links`). A resposta de `/anime/stream/...` traz um campo `log` dizendo o que falhou.
