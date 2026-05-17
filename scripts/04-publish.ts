// ─────────────────────────────────────────────────────────────────
// 04-publish.ts — gzip corpus.sqlite, compute sha256, write a
// manifest.json, create a tagged GitHub Release with all three as
// assets via the `gh` CLI.
//
// Usage:
//   tsx scripts/04-publish.ts --tag rel17-v1 [--draft]
//
// Pre-reqs:
//   - `gh auth status` shows you're logged in
//   - this repo's git remote is the corpus repo on GitHub
//   - out/corpus.sqlite exists (run `npm run build` first)
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "out");
const SQLITE_PATH = path.join(OUT_DIR, "corpus.sqlite");

const log = (...args: unknown[]) => console.log("[publish]", ...args);

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  return v && !v.startsWith("--") ? v : "";
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function gzipFile(src: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const inStream = fsSync.createReadStream(src);
    const outStream = fsSync.createWriteStream(dest);
    const gz = zlib.createGzip({ level: 9 });
    inStream.on("error", reject);
    outStream.on("error", reject);
    inStream.pipe(gz).pipe(outStream).on("finish", () => resolve());
  });
}

async function sha256File(p: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fsSync.createReadStream(p)
      .on("data", c => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function gh(args: string[], opts: { stdin?: string } = {}): string {
  log(`gh ${args.join(" ")}`);
  const r = spawnSync("gh", args, {
    cwd: REPO_ROOT,
    input: opts.stdin,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`gh failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

async function main() {
  const tag = getArg("--tag");
  if (!tag) {
    console.error("usage: tsx scripts/04-publish.ts --tag <tag> [--draft]");
    console.error("       e.g. --tag rel17-v1");
    process.exit(1);
  }
  if (!/^rel\d+-v\d+$/i.test(tag)) {
    console.error(`tag '${tag}' doesn't match expected pattern relNN-vN (e.g. rel17-v1)`);
    process.exit(1);
  }
  const draft = hasFlag("--draft");

  if (!fsSync.existsSync(SQLITE_PATH)) {
    console.error(`out/corpus.sqlite is missing. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const dateStamp = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const baseName = `3gpp-corpus-${tag}-${dateStamp}`;
  const gzPath = path.join(OUT_DIR, `${baseName}.sqlite.gz`);
  const shaPath = path.join(OUT_DIR, `${baseName}.sha256`);
  const manifestPath = path.join(OUT_DIR, `${baseName}.manifest.json`);

  // ── 1. Gzip ───────────────────────────────────────────────────
  log("gzipping corpus.sqlite (level 9)…");
  await gzipFile(SQLITE_PATH, gzPath);
  const sqliteStat = await fs.stat(SQLITE_PATH);
  const gzStat = await fs.stat(gzPath);
  log(`  ${(sqliteStat.size / 1024 / 1024).toFixed(1)} MB → ${(gzStat.size / 1024 / 1024).toFixed(1)} MB (${((1 - gzStat.size / sqliteStat.size) * 100).toFixed(1)}% compression)`);

  // ── 2. sha256 ─────────────────────────────────────────────────
  log("computing sha256 (of the .sqlite.gz)…");
  const gzSha = await sha256File(gzPath);
  await fs.writeFile(shaPath, `${gzSha}  ${path.basename(gzPath)}\n`);
  log(`  ${gzSha}`);

  // ── 3. Manifest ───────────────────────────────────────────────
  // The desktop app reads this to know what URL to fetch + how to verify.
  // URL is the predictable GH Releases download path; gh fills in the
  // exact one at release-upload time, but the pattern is fixed.
  const ghRepo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const downloadUrl = `https://github.com/${ghRepo}/releases/download/${tag}/${path.basename(gzPath)}`;
  const manifest = {
    schemaVersion: 1,
    release: "Rel-17",
    tag,
    builtAt: new Date().toISOString(),
    artifact: {
      filename: path.basename(gzPath),
      url: downloadUrl,
      sizeBytesGzipped: gzStat.size,
      sizeBytesUncompressed: sqliteStat.size,
      sha256: gzSha,
    },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  log(`wrote ${manifestPath}`);

  // ── 4. Release ────────────────────────────────────────────────
  // Idempotent — if the tag already exists, gh release create errors;
  // upload to existing instead.
  const existing = spawnSync("gh", ["release", "view", tag], { cwd: REPO_ROOT, encoding: "utf8" });
  if (existing.status === 0) {
    log(`release ${tag} already exists; uploading assets with --clobber`);
    gh(["release", "upload", tag, gzPath, shaPath, manifestPath, "--clobber"]);
  } else {
    const notes = `Auto-generated Rel-17 NR + LTE 3GPP corpus.\n\n` +
                  `* Artifact: \`${path.basename(gzPath)}\` (${(gzStat.size / 1024 / 1024).toFixed(1)} MB gzipped, ${(sqliteStat.size / 1024 / 1024).toFixed(1)} MB uncompressed)\n` +
                  `* Schema: \`schemaVersion=1\` — \`clauses\` + \`clauses_fts\` (FTS5 BM25)\n` +
                  `* SHA-256: \`${gzSha}\`\n\n` +
                  `Consumed by [bugzilla-triage-desktop](https://github.com/${ghRepo.split("/")[0]}/bugzilla-triage-desktop). ` +
                  `See the manifest for the verification fields the desktop app expects.\n`;
    const args = [
      "release", "create", tag,
      gzPath, shaPath, manifestPath,
      "--title", `3GPP Rel-17 corpus · ${tag}`,
      "--notes", notes,
    ];
    if (draft) args.push("--draft");
    gh(args);
  }

  log("");
  log(`✓ published ${tag}`);
  log(`  download URL: ${downloadUrl}`);
  log(`  manifest:    ${manifest.artifact.url.replace(/\.sqlite\.gz$/, ".manifest.json")}`);
}

await main();
