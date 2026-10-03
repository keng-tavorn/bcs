import en from '../../../messages/en.json'
import th from '../../../messages/th.json'

// Offline page (FR-PLT-005 AC2): plain HTML with its own styles so it renders from the service-worker cache without
// any other file. Thai first, English below; the words come from the message files.

export const dynamic = 'force-static'

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

const HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b6e5f">
<title>${escape(th.pwa.offlineTitle)} · BCS</title>
<style>
  :root { --bg: #ffffff; --surface: #f5f7f8; --line: #dde3e7; --ink: #1c2b33; --ink-muted: #4a5a63; --primary: #0b6e5f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: "IBM Plex Sans Thai", "Noto Sans Thai", system-ui, sans-serif; font-size: 16px; line-height: 1.6; }
  header { background: var(--surface); border-bottom: 1px solid var(--line); padding: 16px; font-weight: 700; font-size: 20px; }
  main { max-width: 28rem; margin: 0 auto; padding: 32px 16px; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 24px; margin: 0; }
  p { margin: 0; color: var(--ink-muted); }
  button { min-height: 44px; padding: 0 16px; border: 0; border-radius: 6px; background: var(--primary); color: #ffffff; font: inherit; font-weight: 600; cursor: pointer; align-self: flex-start; }
  button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  hr { border: 0; border-top: 1px solid var(--line); width: 100%; }
</style>
</head>
<body>
<header>BCS</header>
<main>
  <h1>${escape(th.pwa.offlineTitle)}</h1>
  <p>${escape(th.pwa.offlineBody)}</p>
  <button type="button" onclick="location.reload()">${escape(th.pwa.retry)}</button>
  <hr>
  <p lang="en">${escape(en.pwa.offlineTitle)}. ${escape(en.pwa.offlineBody)}</p>
</main>
</body>
</html>
`

export function GET() {
  return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
