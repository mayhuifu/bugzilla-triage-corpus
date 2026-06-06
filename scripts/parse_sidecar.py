"""Phase B (v0.5.6) parse sidecar — Docling DOCX → ordered element-stream JSON.

02-parse.ts shells out to this Python subprocess (mirrors embed_sidecar.py) and
consumes the JSON, keeping the proven leaf-clause splitting logic in TS while
swapping the extractor underneath (mammoth → Docling).

Emits a flat reading-order element stream so the TS side can rebuild clauses by
clause-number depth exactly as today:
  - heading  {level, text, clauseNo, title}
  - text     {label, text}
  - table    {rows: string[][], nrows, ncols, caption}   (clean cells)
  - figure   {mediaFilename, caption}                      (PNG; caption paired
                                                            by reading order ±3)

CONVERSION CACHE (optional, env DOCLING_CACHE_DIR): Docling's convert() is the
slow step. When DOCLING_CACHE_DIR is set we cache the resulting element stream +
the captioned-figure media per DOCX part, keyed by (filename, size, mtime,
prefix, CACHE_VERSION). A re-parse (e.g. after tweaking 02-parse's clause logic)
then SKIPS Docling entirely. Bump CACHE_VERSION when this script's extraction
changes. With the env unset the behaviour is byte-identical to no caching.

Run inside the docling venv:  python -u parse_sidecar.py <docx> <media_out_dir> [prefix]
"""
import sys, json, re, os, hashlib, shutil
# NOTE: `docling` (which pulls torch) is imported lazily in the cache-MISS path
# only — a cache hit never imports it, making re-parses near-instant.

path = sys.argv[1]
mediadir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/docling-media"
# Media filename prefix — 02-parse.ts passes "<spec>-p<partIdx>" so image
# filenames are unique across the parts of a multi-part spec.
prefix = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(path).split("__")[0].replace(".docx", "")
os.makedirs(mediadir, exist_ok=True)

CLAUSE_RE = re.compile(r"^\s*(\d+(?:\.\d+)*[A-Za-z]?)\s+(.+)", re.S)
FIG_RE = re.compile(r"^\s*Figure\s+[\w.\-]+\s*[:.]?", re.I)
TBL_RE = re.compile(r"^\s*Table\s+[\w.\-]+\s*[:.]?", re.I)

# ── Conversion cache (skips the slow Docling convert on re-parse) ──────
CACHE_VERSION = "1"
CACHE_DIR = os.environ.get("DOCLING_CACHE_DIR", "").strip()

def cache_entry():
    st = os.stat(path)
    key = hashlib.sha256(
        f"{os.path.basename(path)}|{st.st_size}|{int(st.st_mtime)}|{prefix}|{CACHE_VERSION}".encode()
    ).hexdigest()[:16]
    return os.path.join(CACHE_DIR, key)

def emit(elements):
    if os.environ.get("SIDECAR_SUMMARY"):
        heads = [e for e in elements if e["kind"] == "heading"]
        tables = [e for e in elements if e["kind"] == "table"]
        figs = [e for e in elements if e["kind"] == "figure"]
        print(f"[sidecar] elements={len(elements)} headings={len(heads)} "
              f"numbered={sum(1 for h in heads if h.get('clauseNo'))} tables={len(tables)} "
              f"tables_with_caption={sum(1 for t in tables if t.get('caption'))} "
              f"figures={len(figs)} figures_with_caption={sum(1 for f in figs if f.get('caption'))}",
              file=sys.stderr)
    json.dump(elements, sys.stdout, ensure_ascii=False)

# CACHE HIT — restore element stream + captioned-figure media, skip Docling.
if CACHE_DIR:
    entry = cache_entry()
    cjson = os.path.join(entry, "elements.json")
    if os.path.exists(cjson):
        with open(cjson, encoding="utf-8") as fh:
            elements = json.load(fh)
        cmedia = os.path.join(entry, "media")
        if os.path.isdir(cmedia):
            for fn in os.listdir(cmedia):
                shutil.copyfile(os.path.join(cmedia, fn), os.path.join(mediadir, fn))
        if os.environ.get("SIDECAR_SUMMARY"):
            print(f"[sidecar] CACHE HIT {os.path.basename(path)} (skipped Docling convert)", file=sys.stderr)
        emit(elements)
        sys.exit(0)

# ── Docling conversion (the slow path) ────────────────────────────────
from docling.document_converter import DocumentConverter  # lazy: only on cache miss
conv = DocumentConverter()
doc = conv.convert(path).document

elements = []
img_n = 0
for item, _level in doc.iterate_items():
    cls = type(item).__name__
    label = str(getattr(item, "label", "") or "")
    if cls in ("SectionHeaderItem", "TitleItem"):
        txt = (item.text or "").strip()
        m = CLAUSE_RE.match(txt)
        elements.append({
            "kind": "heading",
            "level": int(getattr(item, "level", 1) or 1),
            "text": txt,
            "clauseNo": m.group(1) if m else None,
            "title": m.group(2).strip() if m else txt,
        })
    elif cls in ("TextItem", "ListItem", "CodeItem", "FormulaItem"):
        txt = (item.text or "").strip()
        if txt:
            elements.append({"kind": "text", "label": label, "text": txt})
    elif cls == "TableItem":
        try:
            grid = item.data.grid
            rows = [[(c.text or "").strip() for c in row] for row in grid]
        except Exception:
            rows = []
        elements.append({"kind": "table", "rows": rows,
                         "nrows": len(rows), "ncols": len(rows[0]) if rows else 0,
                         "caption": None})
    elif cls == "PictureItem":
        fn = None
        try:
            img = item.get_image(doc)
            if img is not None:
                fn = f"{prefix}-image-{img_n}.png"
                img.save(os.path.join(mediadir, fn))
                img_n += 1
        except Exception as e:
            fn = f"(extract-failed: {e})"
        elements.append({"kind": "figure", "mediaFilename": fn, "caption": None})

# Caption pairing: 3GPP puts the "Figure N:" / "Table N:" caption paragraph
# adjacent to the object. Figures: image-before-caption → look AHEAD then behind
# (±3). Tables: caption PRECEDES the table → look BEHIND then ahead (±3).
def pair(kind, regex, order):
    for i, el in enumerate(elements):
        if el["kind"] != kind:
            continue
        for j in order(i):
            if j < 0 or j >= len(elements):
                continue
            e = elements[j]
            if e["kind"] == "text" and not e.get("_claimed") and regex.match(e["text"]):
                el["caption"] = e["text"]
                e["_claimed"] = True
                break

pair("figure", FIG_RE, lambda i: list(range(i + 1, i + 4)) + list(range(i - 1, i - 4, -1)))
pair("table", TBL_RE, lambda i: list(range(i - 1, i - 4, -1)) + list(range(i + 1, i + 4)))

# CACHE SAVE — element stream + only the captioned-figure media (uncaptioned
# images are always dropped by 02-parse, so no need to cache them).
if CACHE_DIR:
    entry = cache_entry()
    os.makedirs(os.path.join(entry, "media"), exist_ok=True)
    with open(os.path.join(entry, "elements.json"), "w", encoding="utf-8") as fh:
        json.dump(elements, fh, ensure_ascii=False)
    for el in elements:
        if el.get("kind") == "figure" and el.get("caption") and el.get("mediaFilename"):
            src = os.path.join(mediadir, el["mediaFilename"])
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(entry, "media", el["mediaFilename"]))

emit(elements)
