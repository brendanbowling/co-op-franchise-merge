'use strict';

const files = { baseline: null, host: null, guest: null };
const out = document.getElementById('output');
const mergeBtn = document.getElementById('mergeBtn');
const previewBtn = document.getElementById('previewBtn');

// File pickers
document.querySelectorAll('button[data-pick]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.pick;
    const labels = { baseline: 'shared starting save', host: 'your save', guest: "partner's played save" };
    const p = await window.api.pickSave(`Select the ${labels[key]}`);
    if (!p) return;
    files[key] = p;
    document.getElementById(key).value = p;
    mergeBtn.disabled = true; // require a fresh preview after changing files
    out.classList.add('hidden');
  });
});

function show(html, cls) {
  out.className = 'output' + (cls ? ' ' + cls : '');
  out.innerHTML = html;
  out.classList.remove('hidden');
}

previewBtn.addEventListener('click', async () => {
  if (!files.baseline || !files.host || !files.guest) {
    show('Please choose all three files first.', 'warn');
    return;
  }
  show('Reading saves…');
  const res = await window.api.preview({ ...files, game: 'madden26' });
  if (!res.ok) { show('Error: ' + esc(res.error), 'error'); mergeBtn.disabled = true; return; }

  if (!res.games.length) {
    show('No new played game found in the partner save (relative to the shared starting save). '
       + 'Make sure the partner played their game on a copy of the shared save and did not advance the week.', 'warn');
    mergeBtn.disabled = true;
    return;
  }

  const list = res.games.map(g =>
    `<li><b>${esc(g.away)} ${g.awayScore} @ ${esc(g.home)} ${g.homeScore}</b> <span class="hint">(Week ${g.week})</span></li>`
  ).join('');
  const warn = res.warnings.length
    ? `<p class="warn-inline">Notes: ${res.warnings.map(esc).join('; ')}</p>` : '';
  show(
    `<h3>Will be merged in:</h3>
     <ul>${list}</ul>
     <p>${res.statLines} player season-stat line(s) come with these game(s).</p>
     ${warn}
     <p class="hint">Click “Merge →” to write the merged save. Your three files stay untouched — only the new file you name is written.</p>`,
    'ok'
  );
  mergeBtn.disabled = false;
});

mergeBtn.addEventListener('click', async () => {
  const suggested = (files.host.split(/[\\/]/).pop() || 'CAREER') + '-MERGED';
  const outPath = await window.api.pickOutput(suggested);
  if (!outPath) return;

  show('Merging…');
  mergeBtn.disabled = true;
  const res = await window.api.apply({ ...files, out: outPath, game: 'madden26' });
  if (!res.ok) { show('Merge failed: ' + esc(res.error), 'error'); return; }

  const applied = Object.entries(res.applied)
    .map(([t, v]) => `<li>${esc(t)}: ${v.rows} row(s)</li>`).join('');
  const vr = res.verify;
  const warn = res.warnings && res.warnings.length
    ? `<details><summary>${res.warnings.length} note(s)</summary><ul>${res.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : '';
  show(
    `<h3>✅ Merge complete</h3>
     <p>Saved: <code>${esc(outPath)}</code></p>
     <p class="hint">Your original three files were not modified.</p>
     <p>Verification: <b>${vr.ok}/${vr.checked}</b> transplanted values confirmed ${vr.pass ? '✓' : '✗'}.</p>
     <ul>${applied}</ul>
     ${warn}
     <p class="hint">Load the merged save in Madden, then advance the week to finish the rest of the league.</p>`,
    vr.pass ? 'ok' : 'warn'
  );
});

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
