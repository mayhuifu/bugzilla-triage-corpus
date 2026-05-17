# bugzilla-triage-corpus

Offline pipeline that builds a **3GPP Release-17 NR + LTE specification corpus** consumed by [bugzilla-triage-desktop](https://github.com/mayhuifu/bugzilla-triage-desktop) for in-app spec retrieval.

This repo holds **only the build pipeline** — the corpus itself ships as a downloadable asset on this repo's GitHub Releases page. The desktop app downloads the latest `*.sqlite.gz` on first run after the user opts in via Settings → Spec Corpus.

## What the pipeline does

```
scripts/curated-specs.json     ← list of ~35 NR + LTE specs to index
        │
        ▼
01-fetch.ts                    ← directory-listing 3gpp.org/ftp/Specs/archive,
        │                       picking the LATEST h* (Rel-17) version per spec,
        │                       downloading the ZIP and unpacking the DOCX
        ▼
raw/<spec>-<version>.docx
        │
        ▼
02-parse.ts                    ← mammoth → HTML, heading-aware leaf-clause split
        │
        ▼
dist/clauses.json              ← intermediate JSON (one row per leaf clause)
        │
        ▼
03-index.ts                    ← emit corpus.sqlite with an FTS5 virtual table
        │
        ▼
out/corpus.sqlite              ← single-file BM25-searchable corpus
        │
        ▼
04-publish.ts                  ← gzip, sha256, write manifest.json, gh release upload
        │
        ▼
GitHub Releases tag `rel17-vN` ← {sqlite.gz, sha256, manifest.json}
```

## Why Release-17 only?

The downstream app (bugzilla-triage-desktop) is used for 5G RedCap + 4G LTE silicon triage. RedCap was introduced in Rel-17; Rel-17 is the production reference for nearly all of that work. The text is frozen, the clause numbering is stable, and pinning to a single release simplifies retrieval (no version drift between point releases).

Rel-18 / Rel-19 corpora will ship as separate downloadable bundles when the engineering reality demands them.

## Build it yourself

```bash
npm install
npm run build         # fetch → parse → index, takes ~10 min on broadband
npm run publish-corpus -- --tag rel17-v1   # gh release create + upload
```

`raw/`, `dist/`, and `out/` are git-ignored — only the pipeline source lives here.

## Curated specs

See `scripts/curated-specs.json`. Roughly:
- NR PHY/MAC/RRC: 38.101-1/2/3, 38.201, 38.211, 38.212, 38.213, 38.214, 38.215, 38.300, 38.321, 38.322, 38.323, 38.331
- NR test: 38.508-1, 38.521-1/2/3, 38.523-1
- LTE PHY/MAC/RRC: 36.101, 36.211, 36.212, 36.213, 36.214, 36.300, 36.321, 36.331
- LTE test: 36.508, 36.521-1/2/3, 36.523-1

## License

The pipeline code is MIT-licensed. The 3GPP specifications themselves remain copyright 3GPP / ETSI / member organizations; this repo does not redistribute them. The published corpus is a derived index (clause text excerpts for in-app reference) — see the LICENSE-CORPUS notice attached to each release asset for terms.
