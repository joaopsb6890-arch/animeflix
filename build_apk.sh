#!/data/data/com.termux/files/usr/bin/bash
# Compila o AnimeFlix.apk no Termux com a mesma cadeia do chatapp:
# javac -> d8 -> aapt -> zip -> zipalign -> apksigner (v1+v2+v3).
# ~/chatapp fornece android.jar/d8.jar/apksigner.jar e NUNCA é alterado.
set -euo pipefail
cd "$(dirname "$0")/apk"

# Endereço público do servidor (ex.: https://animeflix.onrender.com). Obrigatório.
: "${APP_URL:?defina APP_URL, ex.: APP_URL=https://animeflix.onrender.com ./build_apk.sh}"
case "$APP_URL" in https://*|http://*) ;; *) echo "ERRO: APP_URL precisa começar com https://"; exit 1;; esac
APP_URL="${APP_URL%/}/"
sed -i "s#String URL = \"[^\"]*\"#String URL = \"$APP_URL\"#" src/com/animeflix/MainActivity.java
echo ">> servidor do app: $APP_URL"

TOOLS="$HOME/chatapp"
KS_FILE="animeflix.jks"
KS_ALIAS="animeflix"
OUT_ALIGNED="bin/app.aligned.apk"
OUT_SIGNED="bin/animeflix.apk"

for t in java javac keytool aapt zipalign zip; do
  command -v "$t" >/dev/null || { echo "ERRO: falta '$t' no PATH (pkg install aapt openjdk-17 zipalign)"; exit 1; }
done
for j in android.jar d8.jar apksigner.jar; do
  [ -r "$TOOLS/$j" ] || { echo "ERRO: $TOOLS/$j não encontrado/legível"; exit 1; }
done

# versionCode novo a cada build: instalador recusa APK com chave nova e número repetido.
VC=$(sed -n 's/.*android:versionCode="\([0-9]*\)".*/\1/p' AndroidManifest.xml | head -1)
[ -n "$VC" ] || { echo "ERRO: android:versionCode ausente no AndroidManifest.xml"; exit 1; }
VN=$((VC + 1))
sed -i "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$VN\"/" AndroidManifest.xml
echo ">> versionCode: $VC -> $VN"

rm -rf obj bin classes.dex
mkdir -p obj bin

# Ícone: arte única em static/icons/animeflix.svg. O repositório não guarda binário.
bash ../make_icons.sh

echo ">> javac"
javac --release 8 -parameters -cp "$TOOLS/android.jar" -d obj \
      $(find src -name '*.java')

echo ">> d8 (classes.dex)"
java -cp "$TOOLS/d8.jar" com.android.tools.r8.D8 \
     --lib "$TOOLS/android.jar" --min-api 24 --release --output . \
     $(find obj -name '*.class')

echo ">> aapt + dex"
aapt package -f -M AndroidManifest.xml -S res -I "$TOOLS/android.jar" -F bin/app.apk
zip -j bin/app.apk classes.dex >/dev/null

# Alinha ANTES de assinar: zipalign depois da assinatura quebra v2/v3.
echo ">> zipalign"
zipalign -f -p 4 bin/app.apk "$OUT_ALIGNED"

# Senha do keystore NUNCA em texto puro: env ANIME_KS_PASS ou digitação oculta.
if [ -z "${ANIME_KS_PASS:-}" ] && [ ! -t 0 ]; then
  echo "ERRO: defina ANIME_KS_PASS antes de rodar (sem terminal interativo)."
  exit 1
fi
ensure_pass() {
  if [ -z "${ANIME_KS_PASS:-}" ]; then
    printf 'Senha do keystore (%s): ' "$KS_FILE"
    read -rs ANIME_KS_PASS; echo
    export ANIME_KS_PASS
  fi
  export ANIME_KEY_PASS="${ANIME_KEY_PASS:-$ANIME_KS_PASS}"
}

if [ ! -f "$KS_FILE" ]; then
  ensure_pass
  echo ">> criando keystore novo: $KS_FILE"
  keytool -genkeypair -keystore "$KS_FILE" -alias "$KS_ALIAS" \
          -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=AnimeFlix" \
          -storetype PKCS12 -storepass:env ANIME_KS_PASS -keypass:env ANIME_KEY_PASS
fi

ensure_pass
echo ">> apksigner (v1+v2+v3)"
java -jar "$TOOLS/apksigner.jar" sign \
  --ks "$KS_FILE" --ks-key-alias "$KS_ALIAS" --ks-type PKCS12 \
  --ks-pass env:ANIME_KS_PASS --key-pass env:ANIME_KEY_PASS \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT_SIGNED" "$OUT_ALIGNED"

java -jar "$TOOLS/apksigner.jar" verify --print-certs "$OUT_SIGNED" | head -4
zipalign -c -p 4 "$OUT_SIGNED" >/dev/null && echo ">> zipalign -c: OK"

cp "$OUT_SIGNED" ../AnimeFlix.apk
echo ">> Pronto: $(cd .. && pwd)/AnimeFlix.apk"
if [ -d "$HOME/storage/downloads" ]; then
  cp "$OUT_SIGNED" "$HOME/storage/downloads/animeflix.apk"
  echo ">> Copiado para ~/storage/downloads/animeflix.apk"
else
  echo ">> (~/storage/downloads não existe; rode termux-setup-storage para instalar pelo navegador)"
fi
echo ">> O app abre $APP_URL — não precisa de Termux rodando."
