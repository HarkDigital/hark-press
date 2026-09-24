# Hark Press — concept site

*The studio as a risograph print shop.* A scroll-driven WebGL concept for
Hark Digital Design where everything on screen is **printed**: warm newsprint,
three drums of ink (fluorescent pink, signal green, black), halftone dots,
a little misregistration, bold condensed poster type.

**Live:** https://harkdigital.github.io/hark-press/

Sister concepts for comparison:
[Orbit (space)](https://harkdigital.github.io/hark-igloo/) ·
[Resonance (acoustic lab)](https://harkdigital.github.io/hark-resonance/) ·
[the 2026 site build](https://harkdigital.github.io/hark-digital-2026/).
Copy, services, portfolio and testimonials come from the 2026 site
(`Clients/Hark Digital 2026 Website/site-v2/src/data`) via `src/content.ts`.

## The print run

| # | Chapter | What happens |
|---|---------|--------------|
| 01 | **Proof** (`hero`) | On a green cutting mat, the Hark mark is a letterpress block that prints three passes — key, green, pink — sliding into register; the sheet is pulled as a poster: *Make the internet listen.* |
| 02 | **Paste-up** (`work`) | *Built to be heard.* Projects wheatpasted onto a street hoarding as riso posters; then the nine more stapled to a notice board |
| 03 | **Type Case** (`services`) | *Eleven ways to be heard.* Wood type hops out of a type case, gets inked and pulled as a proof for each service |
| 04 | **Zine** (`voices`) | *We listen. They talk.* A stapled riso zine; each testimonial is a spread, pages curl over |
| 05 | **Shredder** (`shield`) | A website page is shredded (breach), then un-shredded → *Hacked? Breathe.* → RESTORED, 24/7 |
| 06 | **Fold** (`process`) | *We listen first. Then we build.* A sheet folds step by step — Listen · Prototype · Build · Support — into a paper airplane with the stats on its wings |
| 07 | **Airmail** (`contact`) | The airplane lands on an airmail postcard stamped with the Hark mark — *Say hello.* |

## How the print look works

Chapters don't render colour — they render **ink densities**
(`R = pink, G = green, B = black, A = halftone on/off`) with the materials in
`src/print/ink.ts`. `src/core/post.ts` prints those densities onto newsprint:
one rotated halftone screen per ink, each drum slightly out of register,
overprinted multiplicatively, with ink grain and paper fibre. Chapter cuts are
an **ink flood** — the green dots swell to a solid sheet and recede.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build → dist/
```

URL params: `?nointro`, `?c=work&l=0.5`, `?p=0.4`, `?only=hero`, `?debug`.

```bash
npx vite --config vite.shots.config.ts --port 5390 --strictPort   # no-HMR server
node scripts/shot.mjs --port=5390 --frames=hero:0.3,work:0.2 --out=shots [--mobile]
```

Same engine as the other two concepts (Vite + TypeScript + Three.js r186 +
Lenis): one fixed canvas, scroll provides length, chapters get local progress
0..1, accessible linear copy for screen readers and keyboards
(`src/core/srContent.ts`), phones held sideways get a rotate card.

## Deploy

Pushes to `main` deploy to GitHub Pages (`--base=/hark-press/`, `noindex`).
