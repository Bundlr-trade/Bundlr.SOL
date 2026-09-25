/* Nightly registry refresh for bundlr.trade on Solana (migration phase 5;
   replaces curator-studio/registry/nightly.ts, which fed the Robinhood build).

   Scope, on purpose: only the predictions board is rebuilt (`--predictions-only`,
   Kalshi's public trade API). A full `build-registry.ts` run refetches stocks
   and crypto too and stays a manual pipeline. Predictions are the rows that go
   stale nightly (resolution dates, watch-only countdowns, new events); every
   other price is live on the site.

   Steps: splice predictions into this folder's registry.json → commit it here
   and push (Bundlr-trade/Bundlr.SOL) → export-site.ts writes
   bundlr-frontend/public/registry/<build>/ from it → commit that folder on
   main → push → Amplify deploys. bundlr-sol-api reads registry.json at boot;
   the automation restarts it after a successful push.

   Commits go through the worktree Projects/bundlr-frontend-registry (branch
   main, fast-forwarded first) so a session mid-branch in Projects/bundlr-frontend
   never blocks or receives the nightly commit.

   Run: bun Projects/bundlr-solana/library/registry/nightly.ts
   Log: /dev/shm/bundlr-registry-nightly.log (also stdout). Exit 1 on any failure. */

const dir = new URL(".", import.meta.url).pathname; // bundlr-solana/library/registry/
const repo = dir + "../../";
const frontend = dir + "../../../bundlr-frontend-registry/"; // dedicated worktree on main; other sessions use Projects/bundlr-frontend
const studio = dir + "../../../bundlr/curator-studio/registry/";
const logos = dir + "../tile-assets/logos-black.json";
const logPath = "/dev/shm/bundlr-registry-nightly.log";
const log = async (line: string) => {
  const s = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(s);
  const prev = (await Bun.file(logPath).exists()) ? await Bun.file(logPath).text() : "";
  await Bun.write(logPath, (prev + s).split("\n").slice(-400).join("\n"));
};

try {
  const branch = (await Bun.$`git -C ${frontend} branch --show-current`.text()).trim();
  if (branch !== "main") throw new Error(`bundlr-frontend-registry is on '${branch}', not main — refusing to commit the registry there`);
  await Bun.$`git -C ${frontend} pull -q --ff-only origin main`;

  await log("predictions splice starting (Kalshi)");
  await Bun.$`bun ${dir}build-registry.ts --predictions-only`.quiet();
  const reg = JSON.parse(await Bun.file(dir + "registry.json").text());
  await log(`registry.json built ${reg.meta.built} · predictions ${reg.meta.counts.predictions} · total ${reg.meta.counts.total}`);

  await Bun.$`git -C ${repo} add library/registry/registry.json library/registry/registry.js`;
  if ((await Bun.$`git -C ${repo} diff --cached --name-only`.text()).trim()) {
    await Bun.$`git -C ${repo} commit -q -m ${"registry: nightly predictions refresh " + reg.meta.built}`;
    try { await Bun.$`git -C ${repo} push -q origin HEAD`.quiet(); await log("pushed registry.json to Bundlr.SOL"); }
    catch (e) { await log(`WARN: push to Bundlr.SOL failed (${(e as Error).message.split("\n")[0]}); continuing`); }
  }

  await Bun.$`bun ${studio}export-site.ts --registry ${dir}registry.json --logos ${logos} --out ${frontend}public/registry`.quiet();
  const manifest = JSON.parse(await Bun.file(frontend + "public/registry/manifest.json").text());
  await log(`exported build ${manifest.build}`);

  await Bun.$`git -C ${frontend} add -A public/registry`;
  const staged = (await Bun.$`git -C ${frontend} diff --cached --name-only`.text()).trim();
  if (!staged) {
    await log("nothing changed in public/registry; no commit");
  } else {
    await Bun.$`git -C ${frontend} commit -q -m ${"registry: nightly predictions refresh " + manifest.build}`;
    await Bun.$`git -C ${frontend} push -q origin main`;
    await log(`pushed ${(await Bun.$`git -C ${frontend} rev-parse --short HEAD`.text()).trim()} to main (Amplify deploys)`);
  }
  await log("ok");
} catch (e) {
  await log(`FAILED: ${(e as Error).message}`);
  process.exit(1);
}
