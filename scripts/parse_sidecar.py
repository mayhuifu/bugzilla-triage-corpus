"""Phase B (v0.5.6) parse sidecar — Docling DOCX → ordered element-stream JSON.

WIP toward the 02-parse.ts parser swap (see PHASE-B-PARSER-DECISION.md). Mirrors
embed_sidecar.py: 02-parse.ts shells out to this Python subprocess and consumes
the JSON, keeping the proven leaf-clause splitting logic in TS while swapping the
extractor underneath (mammoth → Docling).

Emits a flat reading-order element stream so the TS side can rebuild clauses by
clause-number depth exactly as today:
  - heading  {level, text, clauseNo, title}
  - text     {label, text}
  - table    {rows: string[][], nrows, ncols}      (clean cells, not pipe-flattened)
  - figure   {mediaFilename, caption}              (PNG extracted; caption paired
                                                    via reading order, ±3 elements)

Validated on 38.215 (44 tables, clause#s preserved) and 38.304 (137×8 table;
"Figure 5.2.2-1: …" paired). Run inside the docling venv:
  python -u parse_sidecar.py <docx> <media_out_dir>

Outputs the element JSON to stdout-adjacent file and prints a summary; the
production wiring will emit JSON to stdout for 02-parse.ts to read.
"""
import sys, json, re, os
from docling.document_converter import DocumentConverter

path = sys.argv[1]
mediadir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/docling-media"
# Media filename prefix — 02-parse.ts passes "<spec>-p<partIdx>" so image
# filenames are unique across the parts of a multi-part spec.
prefix = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(path).split("__")[0].replace(".docx", "")
os.makedirs(mediadir, exist_ok=True)

CLAUSE_RE = re.compile(r"^\s*(\d+(?:\.\d+)*[A-Za-z]?)\s+(.+)", re.S)
FIG_RE = re.compile(r"^\s*Figure\s+[\w.\-]+\s*[:.]?", re.I)
TBL_RE = re.compile(r"^\s*Table\s+[\w.\-]+\s*[:.]?", re.I)

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
# adjacent to the object. Pair each figure/table with the nearest matching
# caption text element. Figures: 3GPP convention is image-before-caption, so
# look AHEAD first, then behind (±3). Tables: caption PRECEDES the table, so
# look BEHIND first, then ahead (±3).
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

if os.environ.get("SIDECAR_SUMMARY"):
    heads = [e for e in elements if e["kind"] == "heading"]
    numbered = [e for e in heads if e["clauseNo"]]
    tables = [e for e in elements if e["kind"] == "table"]
    figs = [e for e in elements if e["kind"] == "figure"]
    print(f"[sidecar] elements={len(elements)} headings={len(heads)} numbered={len(numbered)} "
          f"tables={len(tables)} tables_with_caption={sum(1 for t in tables if t.get('caption'))} "
          f"figures={len(figs)} figures_with_caption={sum(1 for f in figs if f['caption'])}", file=sys.stderr)

json.dump(elements, sys.stdout, ensure_ascii=False)
