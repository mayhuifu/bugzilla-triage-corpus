// ─────────────────────────────────────────────────────────────────
// chunking.ts — shared clause→chunk splitter.
//
// Long clauses (38.306 §4.2.7.7 is 35k chars) are hostile to BOTH
// retrieval modalities at whole-clause granularity: one diluted
// dense vector, and a BM25 length-normalization penalty no weighting
// can undo. Both embed.ts (chunk_vec) and 03-index.ts (chunk_fts)
// therefore work on the same deterministic chunk windows; retrieval
// scores chunks and max-pools per clause.
//
// Determinism matters: embed.ts chunks at embed time, 03-index.ts
// re-chunks the same clauses at index time — same inputs must yield
// the same windows (chunk ids are `<clauseId>::c<n>`).
// ─────────────────────────────────────────────────────────────────

export const CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? "1600");
export const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? "200");

export interface ChunkableClause {
  id: string;
  title?: string;
  text?: string;
}

/** Split clause text into overlapping windows on paragraph/sentence
 *  boundaries where possible. Every clause yields ≥ 1 chunk; each
 *  chunk text is prefixed with the clause title (label-rich context
 *  for the encoder, mild natural title boost for chunk BM25). */
export function chunkClause(c: ChunkableClause): Array<{ id: string; text: string }> {
  const label = c.title ? `${c.title}\n` : "";
  const body = c.text ?? "";
  if (label.length + body.length <= CHUNK_CHARS) {
    return [{ id: `${c.id}::c0`, text: `${label}${body}` }];
  }
  const budget = Math.max(400, CHUNK_CHARS - label.length);
  const chunks: Array<{ id: string; text: string }> = [];
  let start = 0, n = 0;
  while (start < body.length) {
    let end = Math.min(start + budget, body.length);
    if (end < body.length) {
      // prefer to cut on a paragraph, else sentence, else hard cut
      const para = body.lastIndexOf("\n", end);
      const sent = body.lastIndexOf(". ", end);
      const cut = Math.max(para, sent);
      if (cut > start + budget / 2) end = cut + 1;
    }
    chunks.push({ id: `${c.id}::c${n}`, text: `${label}${body.slice(start, end)}` });
    n++;
    if (end >= body.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}
