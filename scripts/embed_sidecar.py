#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────
# embed_sidecar.py — sentence-transformers wrapper invoked by
# scripts/embed.ts. Reads JSONL records {"id": str, "text": str}
# from --in path, writes JSONL {"id": str, "embedding_b64": str}
# to --out path. Embeddings are float16, mean-pooled, L2-normalized,
# then base64-encoded so the TS layer can ship them straight into
# SQLite BLOBs without re-parsing floats.
#
# Default model: BAAI/bge-m3 (1024-dim) per SPEC.md §5 / ADR-003.
# Override with --model "<hf-id>" to swap in a smaller variant if
# the desktop ONNX size becomes a problem.
# ─────────────────────────────────────────────────────────────────

import argparse
import base64
import json
import sys
import time
from typing import Iterator, List

try:
    import numpy as np
except ImportError:
    print("[embed_sidecar] missing numpy. install: pip install numpy", file=sys.stderr)
    sys.exit(2)

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print("[embed_sidecar] missing sentence-transformers. install: "
          "pip install sentence-transformers", file=sys.stderr)
    sys.exit(2)


def iter_jsonl(path: str) -> Iterator[dict]:
    with open(path, "r", encoding="utf-8") as f:
        for ln, raw in enumerate(f, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except json.JSONDecodeError as e:
                print(f"[embed_sidecar] {path}:{ln}: malformed JSONL: {e}",
                      file=sys.stderr)
                sys.exit(3)


def batch(items: List[dict], n: int) -> Iterator[List[dict]]:
    for i in range(0, len(items), n):
        yield items[i:i + n]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True,
                    help="JSONL input: {\"id\": str, \"text\": str}")
    ap.add_argument("--out", dest="out_path", required=True,
                    help="JSONL output: {\"id\": str, \"embedding_b64\": str}")
    ap.add_argument("--model", default="BAAI/bge-m3",
                    help="HuggingFace model id (default: BAAI/bge-m3)")
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--device", default=None,
                    help="cpu | cuda | mps. Default: model picks.")
    ap.add_argument("--max-seq-length", type=int, default=512,
                    help="Truncate longer texts to this many tokens.")
    args = ap.parse_args()

    print(f"[embed_sidecar] loading {args.model} …", file=sys.stderr)
    t0 = time.time()
    model = SentenceTransformer(args.model, device=args.device)
    model.max_seq_length = args.max_seq_length
    print(f"[embed_sidecar] loaded in {time.time() - t0:.1f}s; "
          f"dim={model.get_sentence_embedding_dimension()}", file=sys.stderr)

    records = list(iter_jsonl(args.in_path))
    if not records:
        print("[embed_sidecar] no input records", file=sys.stderr)
        return 0

    print(f"[embed_sidecar] embedding {len(records)} record(s) "
          f"in batches of {args.batch_size}", file=sys.stderr)

    written = 0
    with open(args.out_path, "w", encoding="utf-8") as out:
        for chunk in batch(records, args.batch_size):
            texts = [r.get("text", "") for r in chunk]
            ids = [r["id"] for r in chunk]
            vecs = model.encode(
                texts,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            # bge-m3 returns float32; downcast to float16 for storage.
            vecs16 = vecs.astype(np.float16)
            for rid, v in zip(ids, vecs16):
                b64 = base64.b64encode(v.tobytes()).decode("ascii")
                out.write(json.dumps({"id": rid, "embedding_b64": b64}) + "\n")
                written += 1
            print(f"[embed_sidecar]   {written}/{len(records)}", file=sys.stderr)

    print(f"[embed_sidecar] wrote {written} embedding(s) → {args.out_path}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
