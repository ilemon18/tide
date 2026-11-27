#!/usr/bin/env python3
"""Build intrinsic oblique faces for xterm's public fontFamily API.

Development-only dependency: fonttools[woff]. Regenerate checked-in assets, never at runtime.
Outlines/variation deltas/anchors are sheared; advance widths, cmap and OpenType features stay intact.
Derived families are renamed; originals and licenses are recorded in SOURCE.json.
"""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import json
from fontTools.ttLib import TTFont
from fontTools.misc.roundTools import otRound
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "src/assets/fonts"
OUT = FONTS / "terminal-oblique"
SHEAR = 0.20
SOURCES = [
    ("JetBrainsMono-Variable.ttf", "A", "", "public/licenses/JetBrainsMono-OFL.txt"),
    ("FiraCode-Regular.woff2", "B", "Regular", "public/licenses/FiraCode-OFL.txt"),
    ("FiraCode-Bold.woff2", "B", "Bold", "public/licenses/FiraCode-OFL.txt"),
    ("IBMPlexMono-Regular.woff2", "C", "Regular", "public/licenses/IBMPlexMono-OFL.txt"),
    ("IBMPlexMono-Bold.woff2", "C", "Bold", "public/licenses/IBMPlexMono-OFL.txt"),
    ("SourceCodePro-Regular.woff2", "D", "Regular", "public/licenses/SourceCodePro-OFL.txt"),
    ("SourceCodePro-Bold.woff2", "D", "Bold", "public/licenses/SourceCodePro-OFL.txt"),
]

def shear_pair(pair):
    return (otRound(pair[0] + SHEAR * otRound(pair[1])), otRound(pair[1]))

def transform_anchors(value, seen):
    if id(value) in seen:
        return
    seen.add(id(value))
    if hasattr(value, "XCoordinate") and hasattr(value, "YCoordinate"):
        value.XCoordinate = otRound(value.XCoordinate + SHEAR * value.YCoordinate)
    if isinstance(value, (list, tuple)):
        for item in value:
            transform_anchors(item, seen)
    elif hasattr(value, "__dict__"):
        for item in vars(value).values():
            transform_anchors(item, seen)

def build(source, letter, style, license_path):
    origin = FONTS / source
    font = TTFont(origin, recalcTimestamp=False)
    advances = {name: metrics[0] for name, metrics in font["hmtx"].metrics.items()}
    cmap = deepcopy(font.getBestCmap())
    family = f"Tide Terminal Oblique {letter}"
    prefix = f"TideTerminal{letter}Oblique"
    originals = [font["name"].getDebugName(1) or "", (font["name"].getDebugName(6) or "").split("-")[0]]
    glyphs = font["glyf"]
    # Expand sparse variation deltas against original coordinates before transforming.
    if "gvar" in font:
        for name, variations in font["gvar"].variations.items():
            coords, controls = glyphs._getCoordinatesAndControls(name, font["hmtx"].metrics)
            for variation in variations:
                variation.calcInferredDeltas(coords, controls.endPts)
    # Hinting was authored for upright outlines; remove it from the derived faces.
    glyphs.removeHinting()
    for table in ("fpgm", "prep", "cvt ", "hdmx", "VDMX", "LTSH"):
        if table in font:
            del font[table]
    for name in font.getGlyphOrder():
        glyph = glyphs[name]
        if glyph.isComposite():
            for component in glyph.components:
                if hasattr(component, "x"):
                    component.x, component.y = shear_pair((component.x, component.y))
                if hasattr(component, "transform"):
                    (a, b), (c, d) = component.transform
                    component.transform = [[a + SHEAR * b, b], [c + SHEAR * d - SHEAR * a - SHEAR * SHEAR * b, d - SHEAR * b]]
        elif glyph.numberOfContours > 0:
            glyph.coordinates[:] = [shear_pair(point) for point in glyph.coordinates]
    if "gvar" in font:
        for variations in font["gvar"].variations.values():
            for variation in variations:
                variation.coordinates = [None if point is None else shear_pair(point) for point in variation.coordinates]
    for name in font.getGlyphOrder():
        glyphs[name].recalcBounds(glyphs)
        width, bearing = font["hmtx"].metrics[name]
        font["hmtx"].metrics[name] = (width, getattr(glyphs[name], "xMin", bearing))
    if "GPOS" in font:
        transform_anchors(font["GPOS"].table, set())
    for record in font["name"].names:
        if record.nameID in (0, 13, 14):
            continue
        text = record.toUnicode()
        if record.nameID in (1, 16, 21):
            text = family
        elif record.nameID in (3, 4, 6, 18, 25):
            text = prefix + ("-" + style if style else "")
        else:
            for original in originals:
                if original:
                    text = text.replace(original, prefix)
        record.string = text.encode(record.getEncoding(), errors="replace")
    font["post"].italicAngle = -11.31
    font.flavor = "woff2"
    target = OUT / (f"TideTerminal{letter}-Oblique" + ("-" + style if style else "") + ".woff2")
    font.save(target)
    verified = TTFont(target)
    assert verified.getBestCmap() == cmap
    assert {name: metrics[0] for name, metrics in verified["hmtx"].metrics.items()} == advances
    assert verified["name"].getDebugName(1) == family
    assert ("fvar" in verified) == ("fvar" in font)
    if "fvar" in verified:
        for weight in (100, 400, 700, 800):
            original_instance = instantiateVariableFont(TTFont(origin), {"wght": weight}, inplace=False)
            derived_instance = instantiateVariableFont(TTFont(target), {"wght": weight}, inplace=False)
            assert {name: metrics[0] for name, metrics in original_instance["hmtx"].metrics.items()} == {name: metrics[0] for name, metrics in derived_instance["hmtx"].metrics.items()}
    return {"source": str(origin.relative_to(ROOT)), "sourceSha256": sha256(origin.read_bytes()).hexdigest(),
            "asset": str(target.relative_to(ROOT)), "sha256": sha256(target.read_bytes()).hexdigest(),
            "family": family, "license": license_path}

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    records = [build(*entry) for entry in SOURCES]
    (OUT / "SOURCE.json").write_text(json.dumps({"generator": "scripts/generate-terminal-oblique.py", "shear": SHEAR, "faces": records}, indent=2) + "\n")
    print(f"Generated {len(records)} oblique faces with unchanged advances and cmap")
