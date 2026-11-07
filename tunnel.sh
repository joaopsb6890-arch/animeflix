#!/data/data/com.termux/files/usr/bin/bash
# Abre um túnel Cloudflare para a API local, criando uma URL pública que qualquer
# celular consegue alcançar — é isso que falta para o APK funcionar para outras
# pessoas hoje, já que 127.0.0.1 aponta para o próprio aparelho.
#
# A URL de quick tunnel é EFÊMERA: muda a cada execução. Cole a URL impressa na
# tela "Configurar servidor" do app (ou no navegador) depois de rodar isto.
set -euo pipefail

PORT="${PORT:-8000}"
LOCAL="http://127.0.0.1:${PORT}"
# $TMPDIR pode ser /tmp, que no Termux não é gravável; ~/scratch sempre existe.
LOG="$HOME/scratch/animeflix-tunnel.log"
mkdir -p "$(dirname "$LOG")"

command -v cloudflared >/dev/null || {
  echo "ERRO: falta 'cloudflared' (pkg install cloudflared)"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LOCAL/" || echo 000)
[ "$code" = 200 ] || {
  echo "ERRO: a API não respondeu em $LOCAL (HTTP $code)."
  echo "      Abra outro terminal e rode:  cd ~/AllManga.to-API && .venv/bin/python main.py"
  exit 1; }

# cloudflared escreve a URL no stderr; sem este pipe o túnel não teria stdin.
: > "$LOG"
cloudflared tunnel --no-autoupdate --url "$LOCAL" 2>&1 | tee "$LOG" &
CLOUD=$!
trap 'kill "$CLOUD" 2>/dev/null || true' EXIT INT TERM

echo ">> aguardando o Cloudflare criar o túnel..."
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  kill -0 "$CLOUD" 2>/dev/null || { echo "ERRO: cloudflared morreu; veja $LOG"; exit 1; }
  sleep 1
done
[ -n "$URL" ] || { echo "ERRO: a URL não apareceu em 60s. Deixe rodando e releia $LOG"; exit 1; }

sleep 3   # o primeiro pedido costuma falhar antes do roteamento propagar
echo
echo "════════════════════════════════════════════════════════════"
echo " URL pública (muda a cada execução deste script):"
echo "   $URL"
echo
echo " No celular dos amigos: instale o APK, abra e cole esta tela"
echo " em \"Configurar servidor\". Deixe este terminal ligado."
echo "════════════════════════════════════════════════════════════"
echo
echo ">> Ctrl-C encerra o túnel."
wait "$CLOUD"
