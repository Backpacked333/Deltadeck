// Draws the link-preview cards (1200 × 630): public/og-default.png for every
// shared page and profile (worker/src/profile.ts), and public/og-challenge.png
// for shared challenge scores (worker/src/share.ts). The card is the
// same for everyone, so it shows no numbers that could pass for a player's:
// the player's own name and rating go in the preview's title and text.
//
//   node scripts/og-card.ts
import { chromium } from '@playwright/test'

const CARD = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    box-sizing: border-box; padding: 72px 80px;
    display: flex; flex-direction: column; justify-content: space-between;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e9f3ec;
    background: radial-gradient(ellipse at 30% 20%, #2a6b54 0%, #1c4e3d 45%, #123629 100%);
  }
  .brand { font-size: 40px; font-weight: 700; letter-spacing: -0.5px; }
  .brand span { color: #c4e6a8; }
  h1 { margin: 0; max-width: 940px; font-size: 76px; line-height: 1.05; letter-spacing: -1.5px; }
  .row { display: flex; gap: 24px; }
  .chip { padding: 18px 26px; border-radius: 18px;
    background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); }
  .chip b { display: block; font-size: 38px; white-space: nowrap; }
  .chip small { display: block; margin-top: 6px; font-size: 20px; color: #a9c6b6; white-space: nowrap; }
</style></head><body>
  <div class="brand">Delta<span>Deck</span></div>
  <h1>Rated heads-up poker, measured honestly.</h1>
  <div class="row">
    <div class="chip"><b>Rating ± RD</b><small>Glicko-2, uncertainty always shown</small></div>
    <div class="chip"><b>Accuracy</b><small>vs. a model opponent, not a solver</small></div>
    <div class="chip"><b>Luck out</b><small>all-ins settled at equity</small></div>
  </div>
</body></html>`

// The landing page's desk: dark, monospace figures, the question it asks.
// The score to beat is in the preview's title, never on the image.
const CHALLENGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    box-sizing: border-box; padding: 72px 80px;
    display: flex; flex-direction: column; justify-content: space-between;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e9f1ed;
    background:
      radial-gradient(900px 420px at 85% -10%, rgba(178, 224, 140, 0.16), transparent 60%),
      linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px) 0 0 / 44px 44px,
      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px) 0 0 / 44px 44px,
      #070c0a;
  }
  .brand { font-size: 36px; font-weight: 700; letter-spacing: -0.5px; }
  .brand span { color: #b2e08c; }
  .kicker { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 22px;
    letter-spacing: 2px; text-transform: uppercase; color: #a9bab2; }
  h1 { margin: 14px 0 0; max-width: 1000px; font-size: 84px; line-height: 1.02; letter-spacing: -2px; }
  h1 em { font-style: normal; color: #b2e08c; }
  .row { display: flex; gap: 18px; }
  .grade { padding: 12px 22px; border-radius: 999px; font-size: 26px; font-weight: 800; color: #0d1714; }
</style></head><body>
  <div class="brand">Delta<span>Deck</span></div>
  <div>
    <div class="kicker">One hand · graded like chess · play money</div>
    <h1>Most people misprice this hand. <em>Beat my score.</em></h1>
  </div>
  <div class="row">
    <span class="grade" style="background:#3cc48d">Best</span>
    <span class="grade" style="background:#79c79d">Good</span>
    <span class="grade" style="background:#e0b443">Inaccuracy</span>
    <span class="grade" style="background:#ec8d53">Mistake</span>
    <span class="grade" style="background:#f0697a">Blunder</span>
  </div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
for (const [html, file] of [
  [CARD, 'og-default.png'],
  [CHALLENGE, 'og-challenge.png'],
] as const) {
  await page.setContent(html)
  await page.screenshot({
    path: new URL(`../public/${file}`, import.meta.url).pathname,
    type: 'png',
  })
  console.log(`public/${file} written`)
}
await browser.close()
