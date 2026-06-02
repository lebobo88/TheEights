/* Atlas app: lenses, legend, search, inspector + SVG interaction & loop. */
(function () {
  const ATLAS = window.ATLAS;
  const svg = document.getElementById('graph');
  const el = id => document.getElementById(id);
  const lensBar = el('lensBar'), legendBox = el('legend'), inspector = el('inspector'),
        tooltip = el('tooltip'), searchInput = el('search'), statEl = el('stat'), lensDesc = el('lensDesc');

  let pointer = { x: 0, y: 0 };
  const rectPos = e => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const sim = new window.AtlasSim(svg, ATLAS,
    n => { if (drag || pan) return; sim.setHovered(n.id); showTip(n); },
    n => { if (drag || pan) return; sim.setHovered(null); tooltip.style.opacity = 0; }
  );

  function showTip(n) {
    tooltip.style.opacity = 1;
    tooltip.style.left = pointer.x + 16 + 'px';
    tooltip.style.top = pointer.y + 16 + 'px';
    tooltip.innerHTML = `<b>${n.label}</b><span>${ATLAS.groups[n.group].label}${n.meta ? ' · ' + n.meta : ''}</span>`;
  }

  let currentLens = ATLAS.lenses[0];
  const legendOff = new Set();

  ATLAS.lenses.forEach((lens, i) => {
    const b = document.createElement('button');
    b.className = 'lens' + (i === 0 ? ' on' : '');
    b.textContent = lens.label;
    b.onclick = () => { document.querySelectorAll('.lens').forEach(x => x.classList.remove('on')); b.classList.add('on'); applyLens(lens); };
    lensBar.appendChild(b);
  });

  function applyLens(lens) {
    currentLens = lens; legendOff.clear(); lensDesc.textContent = lens.desc;
    buildLegend();
    recompute();
    setSelected(null);
  }

  const nodeVisible = n => currentLens.groups.includes(n.group) && !legendOff.has(n.group) && !(currentLens.collapseLeaves && n.r < 6);
  function recompute() {
    const ids = new Set(ATLAS.nodes.filter(nodeVisible).map(n => n.id)); ids.add('core');
    sim.setActive(ids);
    sim.fitView();
    const links = sim.links.filter(l => l.s.active && l.t.active).length;
    statEl.textContent = `${ids.size} nodes · ${links} edges visible · ${ATLAS.nodes.length} total in codebase`;
  }

  function buildLegend() {
    legendBox.innerHTML = '';
    const counts = {}; ATLAS.nodes.forEach(n => (counts[n.group] = (counts[n.group] || 0) + 1));
    currentLens.groups.forEach(g => {
      if (g === 'core') return;
      const def = ATLAS.groups[g];
      const row = document.createElement('div'); row.className = 'lrow';
      row.innerHTML = `<span class="lsw" style="background:${sim.colorOf[g]}"></span><span class="lname">${def.label}</span><span class="lcnt">${counts[g] || 0}</span>`;
      row.onclick = () => { if (legendOff.has(g)) { legendOff.delete(g); row.classList.remove('off'); } else { legendOff.add(g); row.classList.add('off'); } recompute(); };
      legendBox.appendChild(row);
    });
  }

  function setSelected(id) {
    sim.setSelected(id);
    if (!id) { inspector.classList.remove('open'); return; }
    const n = sim.byId[id], groupLabel = ATLAS.groups[n.group].label;
    const neighbors = [...sim.adj[id]].map(nid => sim.byId[nid]).filter(Boolean);
    const byGroup = {}; neighbors.forEach(m => (byGroup[m.group] = byGroup[m.group] || []).push(m));
    const connHtml = Object.entries(byGroup).map(([g, list]) => `
      <div class="conn-group"><div class="conn-h"><span class="lsw" style="background:${sim.colorOf[g]}"></span>${ATLAS.groups[g].label} · ${list.length}</div>
      <div class="conn-list">${list.map(m => `<span class="chip" data-go="${m.id}">${m.label}</span>`).join('')}</div></div>`).join('');
    inspector.innerHTML = `
      <button class="ix" id="closeInsp">✕</button>
      <div class="ik"><span class="kdot" style="background:${n.color}"></span>${groupLabel}</div>
      <div class="it">${n.label}</div>
      ${n.path ? `<div class="ipath">${n.path}</div>` : ''}
      ${n.meta ? `<div class="imeta">${n.meta}</div>` : ''}
      <p class="idesc">${n.desc || ''}</p>
      ${neighbors.length ? `<div class="conn-title">Connections · ${neighbors.length}</div>${connHtml}` : ''}`;
    inspector.classList.add('open');
    el('closeInsp').onclick = () => setSelected(null);
    inspector.querySelectorAll('.chip').forEach(c => { c.onclick = () => { const g = c.dataset.go; if (sim.byId[g] && sim.byId[g].active) { setSelected(g); centerOn(g); } }; });
  }
  function centerOn(id) { const n = sim.byId[id]; sim.view.x = -n.x * sim.view.k; sim.view.y = -n.y * sim.view.k; sim.applyView(); sim.reheat(0.25); }

  /* ---- interaction ---- */
  let drag = null, pan = null, moved = false;
  svg.addEventListener('pointerdown', e => {
    pointer = rectPos(e); moved = false;
    const t = e.target;
    if (t.classList && t.classList.contains('gnode')) {
      const n = sim.byId[t.getAttribute('data-id')];
      if (n) { drag = n; n.fixed = true; tooltip.style.opacity = 0; }
    } else { pan = { sx: pointer.x, sy: pointer.y, vx: sim.view.x, vy: sim.view.y }; svg.style.cursor = 'grabbing'; }
  });
  window.addEventListener('pointermove', e => {
    pointer = rectPos(e);
    if (drag) { const w = sim.screenToWorld(pointer.x, pointer.y); drag.x = w.x; drag.y = w.y; drag.vx = 0; drag.vy = 0; sim.reheat(0.35); moved = true; }
    else if (pan) { sim.view.x = pan.vx + (pointer.x - pan.sx); sim.view.y = pan.vy + (pointer.y - pan.sy); sim.applyView(); moved = true; }
    else if (sim.state.hovered) { showTip(sim.byId[sim.state.hovered]); }
  });
  window.addEventListener('pointerup', () => {
    if (drag) { drag.fixed = false; if (!moved) setSelected(drag.id); drag = null; }
    else if (pan) { if (!moved) setSelected(null); pan = null; }
    svg.style.cursor = 'grab';
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const p = rectPos(e), before = sim.screenToWorld(p.x, p.y);
    sim.view.k = Math.min(2.8, Math.max(0.28, sim.view.k * Math.exp(-e.deltaY * 0.0012)));
    sim.view.x = p.x - sim.cx() - before.x * sim.view.k;
    sim.view.y = p.y - sim.cy() - before.y * sim.view.k;
    sim.applyView();
  }, { passive: false });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim(); sim.setSearch(q);
    if (q.length >= 2) { const m = ATLAS.nodes.find(n => n.active && n.label.toLowerCase().includes(q.toLowerCase())); if (m) centerOn(m.id); }
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const q = searchInput.value.trim().toLowerCase(); const m = ATLAS.nodes.find(n => n.active && n.label.toLowerCase().includes(q)); if (m) { setSelected(m.id); centerOn(m.id); } }
  });
  el('reset').onclick = () => { searchInput.value = ''; sim.setSearch(''); applyLens(currentLens); };
  window.addEventListener('resize', () => sim.applyView());

  let last = performance.now();
  function frame(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; sim.tick(dt); requestAnimationFrame(frame); }
  applyLens(ATLAS.lenses[0]);
  requestAnimationFrame(frame);
  setInterval(() => sim.spawnPulse(), 260);
  window.__atlas = { sim, applyLens, lenses: ATLAS.lenses };
})();
