// The small page the sign-in popup lands on. It tells the opener and closes itself.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function connectedHtml(ok: boolean, text: string) {
  const msg = ok ? `Connected ${esc(text)}. Reading it now: you can close this tab.` : `Couldn't connect: ${esc(text)}`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Connected' : 'Not connected'}</title>
<link rel="stylesheet" href="/styles.css"><main class="view start"><div class="start-inner"><h1 class="display">${ok ? 'Connected' : 'Not connected'}</h1><p class="lede">${msg}</p></div></main>
<script>try{window.opener&&window.opener.postMessage({type:'source-connected',ok:${ok}},location.origin)}catch(e){}${ok ? 'setTimeout(function(){window.close()},1500)' : ''}</script>`;
}

export const connectedPage = (ok: boolean, text: string) => new Response(connectedHtml(ok, text), { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
