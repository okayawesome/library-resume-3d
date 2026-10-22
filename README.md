# Anmol Bhandari — 3D Résumé Book

An interactive résumé you read like a physical book, built with **TypeScript, Three.js and Vite**. Scrolling opens the cover and turns the pages; every page is real, selectable, accessible HTML placed onto a WebGL book. Each page carries a hand-drawn **kineograph** (flip-book) drawing that animates frame by frame as you flip.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173/library-resume-3d/
npm test         # unit tests (Node 22.18+ / 23.6+, no extra dependencies)
npm run build    # type-check and production build
```

## Reading controls

- **Scroll** (wheel, trackpad, scrollbar, touch, Page Up/Down, Space, Home/End) moves through the book. Scrolling up reverses everything exactly.
- **← / →** jump to the previous/next spread (or page, on tall screens).
- The **reader bar** shows the chapter and page numbers, and has a progress rail with one stop per spread plus previous/next buttons.
- The **contents page** inside the cover, the brand link and the colophon's "Back to the cover" link all navigate within the book. Deep links such as `#experience` open the book at that page.
- **Tabbing** onto a link on a page that is not open turns the book to that page.

## How it works

```
native scroll ─► scroll.ts ─► timeline.ts ─► camera.ts (pose) ─┬─► scene.ts   WebGL book: boards, page block, spine, ribbon, light, shadow
 (only input)    progress     book state                        ├─► faces.ts   HTML pages placed in 3D with matrix3d
                 (smoothed)   per leaf                          └─► ui.ts      reader bar, intro fade, navigation
```

- **One source of truth.** The document scroll position is the only input. `timeline.ts` maps it, as a pure function, to the turn progress of every leaf. Fast scrolling, reversing, stopping mid-turn and reloading all land in a consistent state, and the mapping is unit-tested. There are no timeouts, no wheel hijacking and no competing timelines.
- **One frame loop.** A single `requestAnimationFrame` loop applies the state to the WebGL scene, the HTML pages and the UI in the same frame, and stops completely when nothing is moving.
- **Real pages on a real book.** The résumé lives once, in `index.html`, as one `<article class="face">` per page face in reading order. `faces.ts` gives each face one CSS `matrix3d` computed from the same camera as WebGL, so HTML and geometry stay aligned to the pixel. The faces sit *behind* a transparent canvas. For each visible face, `page-light-material.ts` draws a matching mesh that cuts the book open over it and darkens it by the scene's lighting, curl and shadows. Book geometry in front (the cover lifting, a turning page) hides the text behind it correctly, while the text stays selectable and clickable.
- **The book.** Hardcover boards, a page block that moves from the right stack to the left as you read, a spine that bends as the cover opens, and paper leaves that curl as they turn. A turning leaf bends from its hinge with the free edge leading. Its arc length is preserved, so page content is never stretched (`book-geometry.ts`). While a leaf is in the air its two faces are shown as clipped strips of the page so it can bend; at rest the original, interactive page is shown.
- **Kineograph drawings.** Each page has a pencil-style flip-book of 12 frames (`kino-scenes.ts`), plus a little runner doodled in the corner of every right-hand page. The frame shown depends on how far you have flipped, never on a clock (`kino.ts`). Scrolling forward flicks the frames on, scrolling back runs them backwards, and stopping holds the frame. Each drawing finishes by the point where its page is read, so a resting page shows the complete picture. Strokes are re-jittered on every frame, so even still lines "boil" like hand-drawn flip-book pages. The page-curl copies keep a single frame.
- **Camera.** It establishes on the closed cover, approaches as the book opens, and keeps a comfortable reading angle per spread, with small, restrained variations. It eases back slightly while a page is in the air (`camera.ts`).

| File | Responsibility |
| --- | --- |
| `src/scroll.ts` | Scroll controller: native scroll → progress, smoothing, scroll track size |
| `src/timeline.ts` | Chapter controller: dwell/turn segments, book state, reading positions |
| `src/book-geometry.ts` | Book model: dimensions, stacks, hinges, leaf curl, visible faces |
| `src/camera.ts` | Camera controller: layout choice, framing, poses |
| `src/scene.ts` | Book controller (WebGL): geometry, materials, lights, shadows |
| `src/faces.ts` | Book controller (HTML): page placement, curl strips, facing |
| `src/page-light-material.ts` | Shader that lights and cuts out the HTML pages |
| `src/ui.ts` | DOM transition controller: reader bar, rail, intro, keyboard, links, focus |
| `src/kino-scenes.ts` | The flip-book drawings: a sketchy SVG pen and 11 scenes, as pure functions of the frame |
| `src/kino.ts` | Kineograph controller: builds the reels and picks each frame from the scroll position |
| `src/quality.ts` | Performance controller: device tier, frame-time monitoring, step-down |

### Layouts

`camera.ts` picks one per viewport:

- **Spread**: two-page spreads, used when the text stays readable (most desktops and landscape tablets).
- **Page**: one page framed at a time; the camera pans from the left page to the right page and follows each turning leaf (portrait tablets).
- **Flow**: the same HTML pages as a normal scrolling stack of paper sheets. Used for phones, without WebGL, after a WebGL context loss, and without JavaScript. Three.js is loaded on demand, so it is never downloaded in this layout.

### Accessibility and motion

- All résumé content is semantic HTML in reading order, available to assistive technology at all times, including pages that are not open.
- Keyboard: skip link, arrow keys, visible focus rings, and focus-driven page turning.
- `prefers-reduced-motion`: no curl, no camera travel and no smoothing; flip-book drawings show their finished frame. Each turn becomes a short fade between spreads over the same scroll distance. Where that would need camera pans, the flow layout is used instead.

### Performance

- The idle book renders nothing. A frame is about 8 draw calls and fewer than 1k triangles, plus a shadow pass when shadows are on.
- Quality tiers (pixel ratio, shadows, shadow map size) start from device hints and step down automatically when animating frames are slow or keep spiking.
- Page curl strips are built while the browser is idle, before the first turn.
- Text is rasterised at its reading size. `will-change` is applied only while moving, so text re-rasterises crisply once the book settles.

### Testing hooks

- `?quality=0|1|2` pins the starting quality tier.
- `?motion=reduce` previews the reduced-motion mode.
- In `npm run dev`, `window.__book` exposes the live state for inspection.

## Editing content

Each page is an `<article class="face …">` in `index.html`. Face order is fixed by the book's binding:

0 cover · 1 inside cover (ex libris + contents) · 2 About · 3 Skills · 4 Deloitte · 5 Deloitte impact · 6 Western Digital · 7 HP · 8 LibraMind · 9 AI engineering · 10 Game · 11 Education · 12 Contact (inside back cover)

Pages have a fixed size (like paper), so keep each page's content roughly the length it is now. A drawing is added with `<figure class="kino" data-kino="<scene>">` (see `SCENES` in `src/kino-scenes.ts`); a corner runner with `<span class="margin-flip">`. To add pages, add faces in pairs (one leaf = front + back); the timeline, rail and contents adapt to the count, but update the page numbers in the contents list.

## Publish with GitHub Pages

The Vite base path is configured for a repository named `library-resume-3d`. If you use a different repository name, update `base` in `vite.config.js`. The included GitHub Actions workflow builds the project and deploys `dist/` to Pages.

## Content notes

- Location is listed as **New Delhi, India**; the Deloitte role is listed in **Hyderabad**, as on the résumé.
- Western Digital experience explicitly includes testing support for an expansion card for Microsoft Xbox.
- Python, FastAPI and AI engineering are described as current learning, and the game as a work in progress, not as professional experience.
- The contact page includes the phone number from the résumé PDF.
- Review the email, LinkedIn, résumé PDF and all dates before publishing publicly.
