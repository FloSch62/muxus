"""Build the box-drawing face terminals fall back to.

The bundled JetBrains Mono subsets stop short of Box Drawing and Block
Elements (U+2500-259F), so the DOM renderer used to take those glyphs from the
symbol font: an em wide and a different height, which shreds block art and
leaves gaps in frame lines. This takes JetBrains Mono's own glyphs for the
range, which share its cell, and pushes every edge that touches the cell
outward. Terminal rows clip their overflow, so the vertical overshoot ends
exactly at the row edge at any line height; the horizontal one only needs to
cover the antialiased seam between neighbouring cells.

    python3 -m pip install fonttools brotli
    curl -LO https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
    unzip JetBrainsMono-2.304.zip fonts/ttf/JetBrainsMono-Regular.ttf
    python3 hack/box-drawing-font.py fonts/ttf/JetBrainsMono-Regular.ttf

Writes client/src/fonts/muxus-box-drawing.woff2.
"""

import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

FAMILY = 'Muxus Box Drawing'
OUT = Path(__file__).resolve().parent.parent / 'client/src/fonts/muxus-box-drawing.woff2'
CODEPOINTS = range(0x2500, 0x25A0)
# Light, medium and dark shade are dot patterns; stretching their edge dots
# would break the pattern.
SHADES = {0x2591, 0x2592, 0x2593}
# Enough to reach the row edge at the largest line height the app allows
# (1.6 × the 1.32 em cell).
OVERSHOOT_Y = 420
# At least half a device pixel from 12.5 px up, without visibly widening art.
OVERSHOOT_X = 40


def main(source: str) -> None:
    font = TTFont(source)
    options = Options()
    options.flavor = 'woff2'
    options.layout_features = []
    options.hinting = False
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=CODEPOINTS)
    subsetter.subset(font)

    top = font['hhea'].ascent
    bottom = font['hhea'].descent
    glyf = font['glyf']
    for codepoint, name in font.getBestCmap().items():
        if codepoint in SHADES:
            continue
        glyph = glyf[name]
        if glyph.numberOfContours <= 0:
            continue
        advance = font['hmtx'][name][0]
        coords = glyph.coordinates
        for i, (x, y) in enumerate(coords):
            if x <= 0:
                x -= OVERSHOOT_X
            elif x >= advance:
                x += OVERSHOOT_X
            if y <= bottom:
                y -= OVERSHOOT_Y
            elif y >= top:
                y += OVERSHOOT_Y
            coords[i] = (x, y)
        glyph.recalcBounds(glyf)

    name = font['name']
    for record in list(name.names):
        if record.nameID in (1, 16):
            record.string = FAMILY
        elif record.nameID == 4:
            record.string = FAMILY
        elif record.nameID == 6:
            record.string = FAMILY.replace(' ', '') + '-Regular'
        elif record.nameID == 3:
            record.string = f'{FAMILY}; derived from JetBrains Mono 2.304'

    OUT.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = 'woff2'
    font.save(OUT)
    print(f'{OUT} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(f'usage: {sys.argv[0]} JetBrainsMono-Regular.ttf')
    main(sys.argv[1])
