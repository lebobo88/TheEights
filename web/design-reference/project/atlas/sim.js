/* Atlas force-simulation + SVG renderer.
   Velocity-Verlet physics (repulsion, link springs, per-node cluster anchors,
   centering) with an SVG scene graph. Pan/zoom is a single <g> transform;
   labels live in a non-scaled overlay so they stay crisp at any zoom. */

(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  function resolveColor(str) {
    if (typeof str === 'string' && str.startsWith('var(')) {
      const name = str.slice(4, -1).trim();
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
    }
    return str;
  }
  const mk = (n, attrs) => { const e = document.createElementNS(SVGNS, n); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  class AtlasSim {
    constructor(svg, data, onNodeEnter, onNodeLeave, onNodeClick) {
      this.svg = svg;
      this.groups = data.groups;
      this.cb = { enter: onNodeEnter, leave: onNodeLeave, click: onNodeClick };
      this.colorOf = {};
      Object.keys(this.groups).forEach(g => (this.colorOf[g] = resolveColor(this.groups[g].color)));

      this.nodes = data.nodes.map(n => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, active: true, fixed: false, color: this.colorOf[n.group] }));
      this.byId = {}; this.nodes.forEach(n => (this.byId[n.id] = n));

      this.centroid = {};
      Object.entries(this.groups).forEach(([g, def]) => {
        const a = (def.ang * Math.PI) / 180;
        this.centroid[g] = { x: Math.cos(a) * def.dist, y: Math.sin(a) * def.dist };
      });

      this.links = data.links.map(l => ({ s: this.byId[l.s], t: this.byId[l.t], rel: l.rel })).filter(l => l.s && l.t);
      this.adj = {}; this.deg = {}; this.parentOf = {};
      this.nodes.forEach(n => { this.adj[n.id] = new Set(); this.deg[n.id] = 0; });
      this.links.forEach(l => {
        this.adj[l.s.id].add(l.t.id); this.adj[l.t.id].add(l.s.id);
        this.deg[l.s.id]++; this.deg[l.t.id]++;
        if (l.rel === 'tool') this.parentOf[l.t.id] = l.s.id;
      });
      this.byId.core.fixed = true;

      this.view = { x: 0, y: 0, k: 1 };
      this.alpha = 1;
      this.state = { selected: null, hovered: null, neigh: new Set(), search: '' };
      this.activeIds = new Set();
      this.pulses = [];
      this.dragging = null;

      this._buildScene();
      this.setActive(new Set(this.nodes.map(n => n.id)));
      this.applyView();
    }

    /* ---- build SVG once ---- */
    _buildScene() {
      const defs = mk('defs', {});
      const f = mk('filter', { id: 'aglow', x: '-80%', y: '-80%', width: '260%', height: '260%' });
      f.appendChild(mk('feGaussianBlur', { stdDeviation: '3.2', result: 'b' }));
      const fm = mk('feMerge', {}); fm.appendChild(mk('feMergeNode', { in: 'b' })); fm.appendChild(mk('feMergeNode', { in: 'SourceGraphic' }));
      f.appendChild(fm); defs.appendChild(f); this.svg.appendChild(defs);

      this.vp = mk('g', { id: 'vp' });
      this.gEdges = mk('g', { id: 'edges' });
      this.gPulses = mk('g', { id: 'pulses' });
      this.gNodes = mk('g', { id: 'nodes' });
      this.vp.appendChild(this.gEdges); this.vp.appendChild(this.gPulses); this.vp.appendChild(this.gNodes);
      this.svg.appendChild(this.vp);
      this.gLabels = mk('g', { id: 'labels' });
      this.svg.appendChild(this.gLabels);

      this.links.forEach(l => {
        l.el = mk('line', { stroke: this.colorOf[l.t.group], 'stroke-width': 1, 'stroke-opacity': 0.13 });
        this.gEdges.appendChild(l.el);
      });
      this.nodes.forEach(n => {
        n.c = mk('circle', { r: n.r, fill: n.color, 'data-id': n.id, class: 'gnode' });
        if (['core', 'hub', 'proposal'].includes(n.group) || n.id === 'cons-pp') n.c.setAttribute('filter', 'url(#aglow)');
        if (n.group === 'core') n.c.setAttribute('stroke', 'rgba(255,255,255,0.85)'), n.c.setAttribute('stroke-width', 2);
        n.c.addEventListener('pointerenter', () => this.cb.enter && this.cb.enter(n));
        n.c.addEventListener('pointerleave', () => this.cb.leave && this.cb.leave(n));
        this.gNodes.appendChild(n.c);
        // label
        n.t = mk('text', { class: 'glabel', 'text-anchor': 'middle' });
        n.t.textContent = n.label;
        this.gLabels.appendChild(n.t);
      });
    }

    computeAnchors() {
      const active = this.nodes.filter(n => n.active && n.group !== 'tool');
      const byG = {};
      active.forEach(n => (byG[n.group] = byG[n.group] || []).push(n));
      Object.entries(byG).forEach(([g, members]) => {
        if (g === 'core') { members.forEach(n => { n.ax = 0; n.ay = 0; }); return; }
        const def = this.groups[g];
        const base = (def.ang * Math.PI) / 180, radius = def.dist;
        const m = members.length;
        if (m === 1) { members[0].ax = Math.cos(base) * radius; members[0].ay = Math.sin(base) * radius; return; }
        const meanR = members.reduce((s, n) => s + n.r, 0) / m;
        const stepA = Math.min((2 * meanR + 40) / radius, 2.4 / Math.max(1, m - 1));            // angular spacing, capped to a ~137° arc
        members.forEach((n, i) => {
          const a = base + (i - (m - 1) / 2) * stepA;
          n.ax = Math.cos(a) * radius; n.ay = Math.sin(a) * radius;
        });
      });
      const tbp = {};
      this.nodes.filter(n => n.active && n.group === 'tool').forEach(n => {
        const pid = this.parentOf[n.id] || '_'; (tbp[pid] = tbp[pid] || []).push(n);
      });
      Object.entries(tbp).forEach(([pid, ts]) => {
        const p = this.byId[pid], m = ts.length, rr = Math.max(22, (m * 13) / (2 * Math.PI));
        ts.forEach((n, i) => { const a = (i / m) * Math.PI * 2; n.ax = (p ? p.ax : 0) + Math.cos(a) * rr; n.ay = (p ? p.ay : 0) + Math.sin(a) * rr; });
      });
    }

    setActive(idSet) {
      idSet.add('core');
      this.activeIds = idSet;
      this.nodes.forEach(n => { n.active = idSet.has(n.id); n.c.style.display = n.active ? '' : 'none'; n.t.style.display = n.active ? '' : 'none'; });
      this.links.forEach(l => { l.el.style.display = (l.s.active && l.t.active) ? '' : 'none'; });
      this.computeAnchors();
      this.nodes.forEach(n => { if (!n.active) return; n.x = n.ax + (Math.random() - 0.5) * 10; n.y = n.ay + (Math.random() - 0.5) * 10; n.vx = 0; n.vy = 0; });
      this.byId.core.x = 0; this.byId.core.y = 0;
      this.alpha = 1;
      for (let i = 0; i < 320; i++) this.step();
      this.alpha = 0.2;
      this.updateDOM(); this.updateStyles();
    }
    reheat(a = 0.5) { this.alpha = Math.max(this.alpha, a); }

    setSelected(id) { this.state.selected = id; this.state.neigh = id ? new Set([id, ...this.adj[id]]) : new Set(); this.updateStyles(); }
    setHovered(id) { this.state.hovered = id; this.updateStyles(); }
    setSearch(q) { this.state.search = (q || '').toLowerCase(); this.updateStyles(); }

    step() {
      if (this.alpha < 0.004) return;
      const active = this.nodes.filter(n => n.active);
      const k = this.alpha;
      for (const n of active) {
        if (n.fixed) continue;
        n.vx += (n.ax - n.x) * 0.09 * k; n.vy += (n.ay - n.y) * 0.09 * k;
      }
      for (let i = 0; i < active.length; i++) {
        const a = active[i];
        for (let j = i + 1; j < active.length; j++) {
          const b = active[j];
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
          const d = Math.sqrt(d2), rep = (a.r * b.r * 5 + 120) / d2;
          const fx = (dx / d) * rep * k, fy = (dy / d) * rep * k;
          if (!a.fixed) { a.vx += fx; a.vy += fy; }
          if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
          const minD = a.r + b.r + 7;
          if (d < minD) { const push = (minD - d) * 0.5, ux = dx / d, uy = dy / d; if (!a.fixed) { a.x += ux * push; a.y += uy * push; } if (!b.fixed) { b.x -= ux * push; b.y -= uy * push; } }
        }
      }
      for (const l of this.links) {
        if (!l.s.active || !l.t.active) continue;
        const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - (l.s.r + l.t.r + 50)) * 0.006 * k, fx = (dx / d) * f, fy = (dy / d) * f;
        if (!l.s.fixed) { l.s.vx += fx; l.s.vy += fy; }
        if (!l.t.fixed) { l.t.vx -= fx; l.t.vy -= fy; }
      }
      for (const n of active) { if (n.fixed) { n.vx = 0; n.vy = 0; continue; } n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy; }
      this.alpha *= 0.992;
    }

    /* ---- view + transforms ---- */
    cx() { return this.svg.clientWidth / 2; }
    cy() { return this.svg.clientHeight / 2; }
    fitView(topPad = 96, botPad = 70) {
      const act = this.nodes.filter(n => n.active);
      if (!act.length) return;
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (const n of act) { minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r); minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r); }
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const W = this.svg.clientWidth, H = this.svg.clientHeight;
      const k = Math.min((W * 0.8) / bw, ((H - topPad - botPad)) / bh);
      this.view.k = Math.max(0.3, Math.min(1.7, k));
      const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
      this.view.x = -bcx * this.view.k;
      this.view.y = -bcy * this.view.k + (topPad - botPad) / 2;
      this.applyView();
    }
    applyView() {
      this.vp.setAttribute('transform', `translate(${this.cx() + this.view.x},${this.cy() + this.view.y}) scale(${this.view.k})`);
      this.updateLabels();
    }
    worldToScreen(x, y) { return { x: this.cx() + this.view.x + x * this.view.k, y: this.cy() + this.view.y + y * this.view.k }; }
    screenToWorld(sx, sy) { return { x: (sx - this.cx() - this.view.x) / this.view.k, y: (sy - this.cy() - this.view.y) / this.view.k }; }

    updateDOM() {
      for (const l of this.links) {
        if (!l.s.active || !l.t.active) continue;
        l.el.setAttribute('x1', l.s.x); l.el.setAttribute('y1', l.s.y);
        l.el.setAttribute('x2', l.t.x); l.el.setAttribute('y2', l.t.y);
      }
      for (const n of this.nodes) { if (!n.active) continue; n.c.setAttribute('cx', n.x); n.c.setAttribute('cy', n.y); }
      this.updateLabels();
    }
    updateLabels() {
      const sel = this.state.selected, hov = this.state.hovered, q = this.state.search;
      const neigh = sel ? this.state.neigh : (hov ? new Set([hov, ...this.adj[hov]]) : null);
      for (const n of this.nodes) {
        if (!n.active) { n.t.style.display = 'none'; continue; }
        const isSel = n.id === sel, isHov = n.id === hov, match = q && n.label.toLowerCase().includes(q);
        const big = n.r >= 8;
        const show = big || isSel || isHov || match || (neigh && neigh.has(n.id) && this.view.k > 0.6);
        const dim = (neigh && !neigh.has(n.id)) || (q && !match);
        if (!show || dim) { n.t.style.display = 'none'; continue; }
        n.t.style.display = '';
        const p = this.worldToScreen(n.x, n.y);
        const size = n.group === 'core' ? 15 : (n.r >= 12 ? 12.5 : 11);
        n.t.setAttribute('x', p.x.toFixed(1));
        n.t.setAttribute('y', (p.y - Math.max(n.r * this.view.k, 3) - 5).toFixed(1));
        n.t.setAttribute('font-size', size);
        n.t.setAttribute('font-weight', (isSel || isHov || n.group === 'core' || n.group === 'hub') ? 600 : 500);
        n.t.setAttribute('fill', (isSel || isHov || n.group === 'core') ? '#fff' : 'rgba(226,229,240,0.9)');
      }
    }
    updateStyles() {
      const sel = this.state.selected, hov = this.state.hovered, q = this.state.search;
      const neigh = sel ? this.state.neigh : (hov ? new Set([hov, ...this.adj[hov]]) : null);
      for (const n of this.nodes) {
        if (!n.active) continue;
        const isSel = n.id === sel, isHov = n.id === hov, match = q && n.label.toLowerCase().includes(q);
        let op = 1;
        if (neigh && !neigh.has(n.id)) op = 0.2;
        if (q && !match) op = Math.min(op, 0.16);
        n.c.setAttribute('opacity', op);
        if (isSel || isHov || match) { n.c.setAttribute('stroke', '#fff'); n.c.setAttribute('stroke-width', isSel ? 2 : 1.5); }
        else if (n.group === 'core') { n.c.setAttribute('stroke', 'rgba(255,255,255,0.85)'); n.c.setAttribute('stroke-width', 2); }
        else { n.c.removeAttribute('stroke'); n.c.removeAttribute('stroke-width'); }
        if (match) n.c.setAttribute('filter', 'url(#aglow)');
      }
      for (const l of this.links) {
        if (!l.s.active || !l.t.active) continue;
        let a = 0.12, w = 1;
        if (neigh) { const on = neigh.has(l.s.id) && neigh.has(l.t.id); a = on ? 0.6 : 0.03; w = on ? 1.6 : 1; }
        l.el.setAttribute('stroke-opacity', a); l.el.setAttribute('stroke-width', w);
      }
      this.updateLabels();
    }

    /* ---- pulses ---- */
    spawnPulse() {
      const flows = this.links.filter(l => l.s.active && l.t.active && ['consumer', 'mcp', 'memtype', 'writes', 'reads', 'proposes', 'adapter'].includes(l.rel));
      if (!flows.length) return;
      const l = flows[(Math.random() * flows.length) | 0];
      const el = mk('circle', { r: 2.6, fill: l.rel === 'proposes' ? this.colorOf.proposal : this.colorOf.core, filter: 'url(#aglow)' });
      this.gPulses.appendChild(el);
      this.pulses.push({ l, el, t: 0, dur: 0.6 + Math.random() * 0.7 });
    }
    updatePulses(dt) {
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const p = this.pulses[i];
        p.t += dt / p.dur;
        if (p.t >= 1 || !p.l.s.active || !p.l.t.active) { p.el.remove(); this.pulses.splice(i, 1); continue; }
        p.el.setAttribute('cx', p.l.s.x + (p.l.t.x - p.l.s.x) * p.t);
        p.el.setAttribute('cy', p.l.s.y + (p.l.t.y - p.l.s.y) * p.t);
        p.el.setAttribute('opacity', Math.sin(p.t * Math.PI));
      }
    }

    tick(dt) {
      if (this.alpha > 0.004 || this.dragging) { this.step(); this.updateDOM(); }
      this.updatePulses(dt);
    }
  }
  window.AtlasSim = AtlasSim;
})();
