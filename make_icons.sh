#!/data/data/com.termux/files/usr/bin/bash
# Desenha o ícone do AnimeFlix a partir de static/icons/animeflix.svg — fonte única
# da arte. Rasteriza os PNGs servidos pelo app e os mipmaps do launcher legado
# (API < 26, que não conhece <adaptive-icon>). Os XML de apk/res são commitados.
set -euo pipefail
cd "$(dirname "$0")"

SVG=static/icons/animeflix.svg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
command -v rsvg-convert >/dev/null || { echo "ERRO: pkg install librsvg"; exit 1; }

# maskable: cantos retos, porque o launcher recorta a forma e um canto
# transparente viraria buraco no ícone.
sed 's/rx="112"/rx="0"/' "$SVG" > "$TMP/maskable.svg"

png() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

for s in 48 72 96 144 192 512; do
    png "$SVG" "$s" "static/icons/icon-$s.png"
done
for s in 192 512; do
    png "$TMP/maskable.svg" "$s" "static/icons/maskable-$s.png"
done

# ic_launcher fica com a arte arredondada (launcher antigo mostra o PNG cru);
# ic_launcher_round usa a arte cheia, que o launcher recorta em círculo.
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    dir="apk/res/mipmap-${d%%:*}"; sz="${d##*:}"
    mkdir -p "$dir"
    png "$SVG" "$sz" "$dir/ic_launcher.png"
    png "$TMP/maskable.svg" "$sz" "$dir/ic_launcher_round.png"
done

echo ">> ícone: static/icons/*.png + apk/res/mipmap-*/ic_launcher{,_round}.png"
