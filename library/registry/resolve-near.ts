/* Neighbors for the bench's ghost suggestions (Minecraft recipe-book ghosts).
   For every mintable non-prediction row: the five most similar other rows by
   description overlap — Wikipedia short description + first sentence (or the
   CoinGecko blurb for coins), plus name and sub-bin — scored TF-IDF-style so
   "technology company" doesn't bind everything to everything. Baked here at
   build time so the browser never processes text: at placement the mock does a
   dictionary lookup and renders ghosts in the same frame. Predictions get no
   `near` — their neighbors are the other legs of the same event, which the
   registry already encodes in `ev`. Writes `near: [ticker,…]` into
   registry.json, then runs sync-js.ts. */
const dir = new URL(".", import.meta.url).pathname;
const reg = JSON.parse(await Bun.file(dir + "registry.json").text());
const STOP = new Set("a an the of and or in on for to by with from as at is are was were be been its it this that these those which who whose company inc corp corporation ltd plc co holdings holding group american multinational headquartered based founded operates provides services service products product one two three world global international united states us u.s. new york california texas also known formerly largest major public traded listed stock token tokenized share shares etf fund trust index exchange other".split(/\s+/));
const tok = (s: string) => (s||"").toLowerCase().replace(/[^a-z0-9 ]+/g," ").split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)&&!/^\d+$/.test(w)).map(w=>w.replace(/(ies)$/,"y").replace(/(s|es)$/,""));
const first = (s: string) => (s||"").split(/(?<=\.)\s/)[0]||"";
type Row = any;
const pool: Row[] = reg.assets.filter((a: Row)=>(a.status==="mintable"||a.status==="weight-capped")&&a.cls!=="predictions");
const byT = new Map<string, Row[]>();
for (const a of pool) (byT.get(a.t) ?? byT.set(a.t, []).get(a.t)!).push(a);
const docs = [...byT.entries()].map(([t, rows]) => {
  const a = rows.find(r=>r.wiki) || rows.find(r=>r.about) || rows[0];
  const text = [a.n, a.sub, a.wiki?.d, first(a.wiki?.x), first(a.about)].join(" ");
  const bag = new Map<string, number>();
  for (const w of tok(text)) bag.set(w, (bag.get(w)||0)+1);
  return { t, cls: a.cls, sub: a.sub, bag, vol: Math.max(...rows.map(r=>r.vol||0)) };
});
const df = new Map<string, number>();
for (const d of docs) for (const w of d.bag.keys()) df.set(w, (df.get(w)||0)+1);
const N = docs.length, idf = (w: string) => Math.log(1 + N/(df.get(w)||1));
const vec = docs.map(d => { const v = new Map<string, number>(); let n = 0; for (const [w,c] of d.bag) { const x = (1+Math.log(c))*idf(w); v.set(w,x); n += x*x; } return { v, n: Math.sqrt(n)||1 }; });
const sim = (i: number, j: number) => { let s = 0; const [a,b] = vec[i].v.size<vec[j].v.size?[vec[i],vec[j]]:[vec[j],vec[i]]; for (const [w,x] of a.v) { const y = b.v.get(w); if (y) s += x*y; } return s/(vec[i].n*vec[j].n); };
const near = new Map<string, string[]>();
let withAny = 0;
for (let i=0;i<N;i++) {
  const c: [number, number][] = [];
  for (let j=0;j<N;j++) if (j!==i) { const s = sim(i,j); if (s>=0.12) c.push([j,s]); }
  c.sort((x,y)=>y[1]-x[1]||docs[y[0]].vol-docs[x[0]].vol);
  const picks = c.slice(0,5).map(([j])=>docs[j].t);
  if (picks.length) withAny++;
  near.set(docs[i].t, picks);
}
for (const a of reg.assets) { if (a.cls==="predictions") { delete a.near; continue; } const n = near.get(a.t); if (n&&n.length) a.near = n; else delete a.near; }
await Bun.write(dir + "registry.json", JSON.stringify(reg));
console.log(`near: ${withAny}/${N} tickers got neighbors`);
for (const t of ["NVDA","GLD","XOM","KO","BTC","CL","HOOD","LLY"]) console.log(t.padEnd(5), (near.get(t)||[]).join(" "));
await Bun.$`bun ${dir}sync-js.ts`;
