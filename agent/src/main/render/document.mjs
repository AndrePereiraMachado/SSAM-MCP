// The page the render worker serves for one document and viewport (worker.mjs): its own CSP and a style that settles
// transitions first in <head>, then the document's style sheets in the order it names them, and the viewport's classes on
// <body> (on a real runtime the OutSystems UI script puts desktop/tablet/phone there; no script runs here). No Electron
// import, so the app tests check it under Node.
export const RENDER_SCHEME = 'ssam-render';
export const RENDER_CSP = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'";
// Transitions and animations end at once, so the layout measured is the settled one.
const SETTLE = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}';
const escapeAttribute = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The page the worker serves: the CSP and the document's style sheets first in <head>, the viewport's classes on <body>.
export function composeDocument(document, styles, viewport) {
  const sheets = document.styles.map(id => styles.find(style => style.id === id)).filter(Boolean)
    .map(style => `<style data-ssam-style="${style.id}">${style.css}</style>`).join('');
  const head = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(RENDER_CSP)}"><style data-ssam-settle>${SETTLE}</style>${sheets}`;
  let html = document.html;
  const classes = viewport.bodyClasses.join(' ');
  if (classes) {
    html = html.replace(/<body\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i, (tag, attrs) => {
      const existing = /(\sclass\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      if (!existing) return `<body${attrs} class="${classes}">`;
      const value = existing[3] ?? existing[4] ?? existing[5] ?? '';
      return '<body' + attrs.replace(existing[0], `${existing[1]}"${(value + ' ' + classes).trim().replace(/"/g, '')}"`) + '>';
    });
  }
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, match => match + head);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, match => match + '<head>' + head + '</head>');
  return '<!doctype html><head>' + head + '</head>' + html;
}

