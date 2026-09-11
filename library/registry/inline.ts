// Inlines registry.js + tile-assets/logos-black.json into library-finder.html,
// so the mock is one self-contained file (opens from disk, no server needed).
// Run after build-registry.ts / settleable.ts / any resolver: bun library/registry/inline.ts
const root = new URL("..", import.meta.url).pathname;
const registry = await Bun.file(root + "registry/registry.js").text();
const black = await Bun.file(root + "tile-assets/logos-black.json").text();
const finderPath = root + "library-finder.html";
let html = await Bun.file(finderPath).text();
html = html.replace(
  /<!-- REGISTRY:START[\s\S]*?<!-- REGISTRY:END -->/,
  `<!-- REGISTRY:START (inlined by registry/inline.ts — do not edit by hand) -->\n<script>\n${registry}\n</script>\n<!-- REGISTRY:END -->`
).replace(
  /<!-- LOGOS:START[\s\S]*?<!-- LOGOS:END -->/,
  `<!-- LOGOS:START (inlined by registry/inline.ts from tile-assets/logos-black.json) -->\n<script>window.LOGOS=${black};</script>\n<!-- LOGOS:END -->`
);
await Bun.write(finderPath, html);
console.log(`inlined: registry ${(registry.length / 1024).toFixed(0)}KB + ${(black.length / 1024).toFixed(0)}KB logos → ${finderPath}`);
