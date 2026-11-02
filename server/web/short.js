'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, all shown, each with its own heading. On a phone a row of chip
 *                links jumps to a block; nothing is hidden and no script is needed.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in public/home.css.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pick block. The panes are the page's own blocks; every pane shows, stacked, each with its own heading. On a
 * phone the chips are links that jump to a pane; a wide screen shows no chips.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', headId = '', bodyClass = '', panes }) {
    if (!panes || !panes.length) return '';
    const chips = panes.map((p) => `<a class="pick-chip" href="#pp-${esc(key)}-${esc(p.id)}">${esc(p.label)}</a>`).join('');
    const body = panes.map((p) => `<div class="pick-pane" id="pp-${esc(key)}-${esc(p.id)}">${p.html}</div>`).join('');
    const heading = `<h2${headId ? ` id="${esc(headId)}"` : ''}>${esc(head || label)}</h2>`;
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar"><div class="pick-head">${heading}</div><nav class="pick-row" aria-label="${esc(label)}">${chips}</nav></div><div class="pick-body${bodyClass ? ` ${bodyClass}` : ''}">${body}</div></div>`;
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return `<details class="hm-fold hm-fold-block" id="${esc(id)}" open><summary>${head}<span>tap to open</span></summary>${html}</details>${foldScript(id)}`;
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`;
}

module.exports = { pickBlock, foldBlock, foldScript };
