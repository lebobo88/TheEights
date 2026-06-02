# Codebase Memory Dashboard

_Started 2026-06-01 01:27 UTC_

---

## User

examine this codebase and understand what it is as persistent memory for ai coding agents and harnesses. plan a visual web UI to illustrate and demonstrate exactly what's going on with theeights and its memory for all the connected hydra projects and otherwise. ask any questions as needed. do deep research on best practices and to brainstorm ideas. let's do a best of n approach where n = 5

## Assistant

_[tool: local_ls]_

I'll start by exploring the codebase to understand what TheEights is.

_[tool: local_read]_

_[tool: local_read]_

Let me read the core documentation files to understand what TheEights is.

_[tool: local_read]_

_[tool: local_read]_

This is rich. Let me read the architecture, agents contract, and the reports in parallel.

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

Now the reports and the Hydra integration — these are key to visualizing "what's going on with the memory."

_[tool: local_ls]_

_[tool: local_read]_

Let me look at the Hydra integration and a couple of source files to ground the visualization in real data shapes.

_[tool: local_ls]_

_[tool: local_read]_

I have a deep understanding now. Let me glance at the schemas to ground the data shapes, then I'll ask my design questions.

_[tool: local_read]_

_[tool: local_read]_

_[tool: questions_v2]_

I now have a deep, thorough understanding of TheEights. Quick synthesis before I ask you a few things:

**What it is:** TheEights is a *local-first daemon + MCP server* that sits **below** your orchestrators (Hydra, pair-programmer, ExecutiveSuite, RLM family, AgentSmith, MarketBliss) and gives them four shared things — **hybrid memory** (sqlite-vec vectors + Kuzu/LadybugDB graph + episodic SQLite), a **governance plane** (SSGM/LASM gates, budget ledger, circuit breaker, HITL queue), **gated self-evolution** (1,284 versioned resources, risk-class routing, RSPL/SEPL), and a **tamper-evident audit ledger** (hash-chained `.jsonl` + CycloneDX ML-BOM). 65 MCP tools across 12 namespaces. "Substrate, not orchestrator."

The most *visually interesting* truths in here: the 658,280-event ledger that's **96% pp-watcher `memory.add`** (a 2.2 GB bursty growth story), the **Eight Cells** semantic axis, the **21 pending HITL proposals nobody has seen**, the layered L1–L7 stack, and the 10 immutable invariants.

Before I build 5 directions, a few questions so I aim right:

## User

Questions timed out; go with defaults

## Assistant

_[tool: update_todos]_

Got it — going with sensible defaults: an operator console that *also* self-documents, real repo data verbatim, and a deliberate **spread of 5 directions** from by-the-book console → bold experimental data-viz, each centering a different facet of the memory story. Let me do a little fresh research to sharpen ideas, then build.

_[tool: web_search]_

_[tool: update_todos]_

Research confirms my direction spread (time-travel replay, trace-as-source-of-truth, governance signals, HITL pause/approve, graph-level tracing — all map onto facets of TheEights). Locking the plan and building.

_[tool: write_file]_

Now building Direction 1 — Mission Control (dark observability console).

_[tool: write_file]_

Direction 1 done. Now Direction 2 — The Substrate Stack (editorial architecture poster, light).

_[tool: write_file]_

Direction 3 — Memory Ledger Explorer (data-viz, the literal "what's going on with the memory").

_[tool: write_file]_

Direction 4 — Blueprint / Schematic (engineering drawing of the self-evolution loop).

_[tool: write_file]_

Direction 5 — the experimental one: a living Agent-BOM graph constellation.

_[tool: write_file]_

Now the gallery index that ties all five together — the entry point.

_[tool: update_todos]_

All built. Let me verify the gallery loads cleanly with its embedded previews.

_[tool: show_html]_

_[tool: done]_

_[tool: save_screenshot]_

Clean load. Let me take one look at the gallery to confirm the scaled previews render, then hand off to the verifier.

_[tool: view_image]_

_[tool: show_html]_

Header is strong, but the embedded preview is blank — could be iframe capture timing or a render issue. Let me open Direction 1 directly to confirm it renders.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: get_webview_logs]_

Direction 1's layout and data are excellent, but the JS-generated content (counters, event stream, growth bars) is blank — looks like a script error or capture-before-run. Let me check the console.

_[tool: eval_js_user_view]_

No errors. Let me inspect the live DOM to see whether the dynamic content actually populated.

_[tool: show_to_user]_

That eval ran against the user's pane (still on index.html). Let me put dir1 in the user's pane and check its real DOM state.

_[tool: eval_js_user_view]_

_[tool: str_replace_edit]_

The script runs (stream + bars exist) but the **requestAnimationFrame-driven** parts (counter count-up, bar heights) don't paint in capture/hidden contexts — fragile. I'll make the end-states robust with timer fallbacks so the real values always show. Fixing Dir 1 and Dir 3 (the two that depend on rAF for their final state).

_[tool: str_replace_edit]_

Now Dir 3 — its bar widths zero-then-restore via rAF, which leaves them at 0 (invisible) if rAF doesn't fire. Converting to timer-based.

_[tool: show_to_user]_

Now let me confirm the fixes in the live pane.

_[tool: sleep]_

_[tool: eval_js_user_view]_

_[tool: show_to_user]_

Dir 1 now solid (counter 658,280, bars sized, peak correct). Let me confirm the gallery's embedded previews actually render live (the white was likely a capture artifact).

_[tool: sleep]_

_[tool: eval_js_user_view]_

_[tool: save_screenshot]_

All five previews are live and rendering (correct backgrounds, populated DOM) — the earlier white frame was a nested-iframe capture limitation, not a real defect. Let me grab a final look at the gallery as the user sees it.

_[tool: view_image]_

_[tool: show_html]_

Confirmed: the iframe content is fully rendered live (correct dark backgrounds, populated DOM) — the white frame is purely a nested-iframe rasterization limit of the capture tool. To make the gallery bulletproof *and* lighter (5 live animated iframes is heavy), I'll switch the previews to crisp static thumbnails that link to the live full-screen versions. First let me capture + visually QA each direction.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: show_html]_

Direction 2 is gorgeous. Now Dir 3.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: show_html]_

Dir 3 is working beautifully — area chart, donut, bars, cells all render. Now Dir 4.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Dir 4 reads great — one glitch: the title wraps and "Loop" collides with the meta line. Quick fix.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now Dir 5, the experimental graph.

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: show_html]_

All five directions verified — each is distinct and polished. Let me recapture Dir 1 (post-fix) as its thumbnail, then convert the gallery to robust static thumbnails that link to the live versions.

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: read_file]_

The counters now render, but the capture tool freezes CSS entrance animations at their initial (hidden) frame — so the event stream (starts at `opacity:0`) and the grow-from-zero chart bars look empty in screenshots even though they're correct live. Since the gallery uses live iframes (which the user sees correctly), this is cosmetic for *my* captures — but I'll make Dir 1's data visible without depending on animation, so it's bulletproof everywhere. Let me read the relevant section.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: show_html]_

Now Dir 1's chart and stream are render-independent of animations. Let me reconfirm with a capture.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: show_to_user]_

The chart/stream still don't paint in capture even with inline heights — I need to rule out a real CSS bug (vs. capture quirk). Let me check the actual *rendered* sizes in the live pane.

_[tool: sleep]_

_[tool: eval_js_user_view]_

_[tool: delete_file]_

Confirmed — the live view renders everything perfectly (peak bar 107px tall, 14 populated stream rows). The empty captures are purely a screenshot-tool limitation with JS-generated/flex content; the user and the live gallery iframes see the complete dashboards. So the gallery's live previews are the right call — no thumbnail swap needed.

Cleaning up QA artifacts and finalizing.

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

I've built out all five directions. Here's what's waiting in your tab:

**`index.html`** — a gallery of all 5, each in a labeled card with a live preview (click any frame to open it full-screen).

The five directions deliberately span by-the-book → experimental, and each centers a *different* facet of what's actually happening inside TheEights:

1. **Mission Control** — dark operator console. KPI ribbon, the L7→L1 substrate stack, a live `tail -f` event stream, ledger-growth bars (with the May 23 peak), the HITL queue, and every governance gate at a glance.
2. **The Substrate Stack** — editorial architecture poster. The 6 consumers on top, data flowing down through the MCP surface into the three planes and four stores. For docs / onboarding / a README hero.
3. **Memory Ledger Explorer** — the literal answer to "what's going on with the memory." The 658k-event ledger dissected: growth over time, the **96% pp-watcher firehose**, event-kind & actor breakdowns, memory types, the Eight Cells axis, and the root-cause panel.
4. **Blueprint / Schematic** — the gated evolution loop as an engineering drawing: propose → evaluate → commit | HITL, risk-class routing, SSGM gates, the 10 invariants as spec notes.
5. **Living Agent-BOM Graph** — the boldest take: the audit graph as a constellation where runs, memories, resources and HITL proposals orbit the core, pulses are live `memory.add` writes, and clicking any node traces its edges.

All data is pulled verbatim from the repo + the 2026-05-31 audit-growth report (658,280 events, 2.2 GB, 1,284 resources, 21 pending, 6 consumers).

**Notes & next steps:**
- Hydra is treated as one consumer among six (the defaults route). If you want a Hydra-centric drill-down — squads, envelopes, cross-squad handoffs — that's a natural 6th screen or a deeper layer inside whichever direction you pick.
- These are concept frames with light interactivity. **Tell me which one (or which mix) to commit to** and I'll build it into a full, navigable prototype — drill-into-node, filters, the real per-namespace MCP tool browser, etc.
- A verifier is doing a background pass; I'll flag anything it turns up.

Which direction pulls you?

## User

i love #5 the living agent-bom graph. can we fully extend and expand upon that and make sure our codebase is completely covered?

## Assistant

_[tool: update_todos]_

Love that choice — #5 has the most room to grow. Let me turn it into a complete, explorable **Agent-BOM Atlas**: a force-directed knowledge graph where every module in the codebase is a node — all 18 engines, 4 stores, 12 MCP namespaces + 65 tools, 4 cognitive services, 4 adapters, 4 providers, 7 schemas, 6 consumers, the memory types & Eight Cells, the Agent-BOM node types, resources, proposals, the 10 invariants and 8 ADRs — with real source paths, lens filters to navigate it, search, a rich inspector, and the live write-pulses.

Let me lay out the plan and build it in modular files.

_[tool: write_file]_

Building the data model first — this is where "complete codebase coverage" lives. Every module from `ARCHITECTURE.md §10`, with real source paths.

_[tool: write_file]_

Now the force-simulation engine — canvas-based with cluster gravity, pan/zoom, hover and drag.

_[tool: write_file]_

Now the app shell — lenses, search, inspector, legend, interactions and the live loop.

_[tool: write_file]_

Now the HTML shell with full styling and the group color tokens.

_[tool: show_html]_

Let me load it and check for errors.

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Found it — the canvas is a replaced element, so `inset:0` alone doesn't stretch it; it stayed ~300×150, collapsing the graph into the corner. Adding explicit dimensions.

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: show_to_user]_

Identical render — the edit may not have reloaded, or something else sizes the canvas. Let me put it in the user pane and inspect the actual canvas dimensions.

_[tool: sleep]_

_[tool: eval_js_user_view]_

_[tool: str_replace_edit]_

Canvas is full-size now (1520×952) and the graph is near center — the earlier screenshot was just stale cache. One refinement: the core drifts off-origin (46,−141). Let me pin it dead-center so the whole atlas stays anchored.

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: show_to_user]_

My preview iframe is serving a stale cache (3 byte-identical shots). The user pane is authoritative (clientW 1520, centered). Let me reload it fresh there and capture the *user* view.

_[tool: sleep]_

_[tool: screenshot_user_view]_

_[tool: write_file]_

The layout is too compressed — clusters pile and labels collide. I'll give every node its own anchor (members fan out on a ring around each group's centroid, tools orbit their namespace), pre-settle the layout with a synchronous warm-up so it appears clean instantly, and strengthen the forces. Rewriting the sim.

_[tool: str_replace_edit]_

Now I need to retune the group centroid distances (some clusters fly off-screen) and the per-lens zoom. Updating the group layout table.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the per-lens zoom in app.js:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_to_user]_

_[tool: sleep]_

_[tool: screenshot_user_view]_

_[tool: eval_js_user_view]_

Blank canvas now though the data is active (15 nodes). Something in the rewrite broke rendering or positions. Let me inspect live.

_[tool: screenshot_user_view]_

No error and positions are correct (core at screen-center). render() works when called manually. The rAF loop may have stopped. Let me re-screenshot to see if my manual render painted, and probe the loop.

_[tool: eval_js_user_view]_

_[tool: write_file]_

The page renders perfectly (I sampled the center pixel — it's cyan, the core). The blank screenshots are because the capture tool can't rasterize `<canvas>` content (unlike Dir 5's SVG). That blocks me *and* the verifier from seeing the layout to refine it. The clean fix is to render the graph in **SVG** instead of canvas — screenshots work, labels stay crisp, and pan/zoom becomes a single transform. Rewriting the renderer.

_[tool: write_file]_

Now app.js — DOM-based interaction (native hover via SVG elements, drag, pan, zoom).Now switch the HTML from `<canvas>` to `<svg>` and add the SVG node/label styles.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_to_user]_

_[tool: sleep]_

_[tool: screenshot_user_view]_

_[tool: sleep]_

_[tool: screenshot_user_view]_

_[tool: show_html]_

Let me use my own iframe + save_screenshot, which should now capture since it's SVG.

_[tool: save_screenshot]_

_[tool: get_webview_logs]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: eval_js_user_view]_

The screenshot infra is erroring; let me check the page is alive and the SVG populated via eval.

_[tool: screenshot_user_view]_

The page is alive and correct (186 nodes built, 15 visible in Overview, centered). The screenshot errors were transient. Let me retry capturing the user view.

_[tool: eval_js_user_view]_

The page itself is verified healthy via eval (186 nodes, correct layout, centered). The capture tool is having an environment hiccup. Let me extract the actual visible-node screen positions to check the layout quality quantitatively while the capture recovers.

_[tool: str_replace_edit]_

The layout is valid but too compact and lopsided — all members of a group blob at one offset point. I'll switch to a **polar-arc** anchor model (each group's members spread along an arc at its own radius from the core), soften centering, and let it settle longer. Updating both the radii table and the anchor math.Now the polar-arc anchor math and softer settling in sim.js:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_to_user]_

_[tool: sleep]_

_[tool: screenshot_user_view]_

_[tool: eval_js_user_view]_

Capture still down — I'll evaluate the layout numerically across lenses. Checking overview spread, then the full atlas.

_[tool: str_replace_edit]_

Found the real problem: the **link springs are far too strong** and collapse everything toward the core (rest length ~84px but anchors are 200–480px out), so the whole graph implodes to ~300px. I'll make cluster-gravity the dominant force, weaken springs to gentle connectors, and drop centering (the pinned core already centers it).

_[tool: read_file]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: show_to_user]_

_[tool: sleep]_

_[tool: eval_js_user_view]_

_[tool: str_replace_edit]_

The world layout is actually a healthy ring (~radius 350–480); it just renders tiny because the per-lens zooms are too low — and hand-tuning 9 zooms is fragile. I'll add an **auto-fit** that measures the active bounding box and frames it to the viewport every time. Cleaner and self-correcting.

_[tool: str_replace_edit]_

_[tool: show_to_user]_

_[tool: sleep]_

_[tool: screenshot_user_view]_

_[tool: eval_js_user_view]_

_[tool: show_html]_

Auto-fit works — every lens now fills the viewport with zero node overlaps (overview 504×744, full atlas 801×768 for 186 nodes). I still need to *see* it to judge labels/edges. Let me retry the capture path.

_[tool: save_screenshot]_

_[tool: multi_screenshot]_

_[tool: sleep]_

The capture service is consistently erroring for this page (every tool: `No preview pane available`), though `eval_js` confirms the page is healthy. Let me wait for the service and retry once; meanwhile I'll verify the interactions via eval.

_[tool: eval_js_user_view]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

It captured this time. Let me look.

_[tool: view_image]_

_[tool: save_screenshot]_

It works and looks clean — core glowing at center, consumers fanned across the top, the seven subsystems cascading down the right with crisp labels, invariants in red between. Now let me see the denser lenses (Architecture, MCP, Full Atlas) by switching lens before each capture.

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

Steps 1–2 saved before it dropped. Let me view those.

_[tool: list_files]_

_[tool: save_screenshot]_

Capture is very flaky for this page (works ~1 in 4). The overview looks great and eval confirms all dense lenses fit with zero overlaps. Let me grab the full atlas with a single-shot retry.

_[tool: view_image]_

_[tool: save_screenshot]_

The full atlas is excellent — all 186 modules in one readable graph: core at center, the 12 `eights.*` namespaces with their 57 tools orbiting, engines, stores, cognitive services, Eight Cells, Agent-BOM nodes, and the amber HITL queue, with the complete legend. Let me verify the inspector + neighbor-highlight by capturing a selected node.

_[tool: view_image]_

_[tool: eval_js_user_view]_

Selection + neighbor-tracing works beautifully (Evolution Engine lit up with all its resources, ADRs, Policy Engine, Git Writer; everything else dimmed). That test bypassed the inspector (I called the sim directly). Let me confirm the inspector panel builds on a real node click.

_[tool: str_replace_edit]_

Inspector builds perfectly with real source paths (`daemon/src/engines/memory.ts`, 12 connection chips). Everything works. One polish pass: widen the arc spacing so labels (especially the long consumer names) breathe.

_[tool: show_html]_

Let me see the Architecture and MCP lenses (haven't viewed those).

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Architecture lens reads great too — hubs around the core, the 12 `eights.*` namespaces arcing right, the four named engines, stores along the bottom, the 19 engines fanning left. Every lens works.

This is a strong, complete deliverable. Let me wire the gallery's slot #5 to the expanded Atlas, clean up QA artifacts, and finalize.

_[tool: delete_file]_

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

I've expanded direction #5 into a full **Agent-BOM Atlas** — now open in your tab.

**What it is:** the entire TheEights codebase rendered as one live, force-directed knowledge graph. **186 nodes, 212 edges**, every one sourced from the repo:

- **18 engines** (memory, evolution, policy, audit, governance-state, redaction, constitution, hydra, bom, miner, git-writer, the 3 watchers, registrars ×4, writers ×4, eval ×4) — each with its real `daemon/src/engines/*.ts` path
- **12 MCP namespaces + 57 tools**, **4 stores**, **4 cognitive services**, **4 adapters**, **4 providers**, **6 schemas**
- **6 consumers**, the **5 CoALA memory types**, the **Eight Cells**, the **9 Agent-BOM node types**, **10 resource kinds**, the **HITL queue + sample proposals**, the **10 hard invariants**, and **8 ADRs** (wired to the decisions they justify)

**How you explore it:**
- **9 lenses** across the top — Overview, Architecture, MCP Surface, Ecosystem, Memory, Self-Evolution, Audit/BOM, Governance, and **Full Atlas** (everything at once). Each auto-frames itself to fit.
- **Click any node** → inspector with its kind, source path, description, and clickable connections (hop node to node).
- **Search**, **drag** nodes, **scroll** to zoom, **drag background** to pan, **click legend groups** to filter.
- Live **pulses** flow along edges = `memory.add` writes moving through the chain.

**Coverage note:** it maps the codebase's *structure* (modules, the MCP surface, the data/governance model, ADRs). If you want me to push "completely covered" further, I can add the remaining engine leaf-labels, the full per-namespace tool inspector, or pull in live counts (resource totals per consumer, the 21 real pending proposals).

**Heads-up:** the gallery's slot #5 now points to this Atlas. A background verifier is doing a full pass; I'll flag anything it catches.

What would you like next — refine the layout/visuals, or deepen the data coverage?

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

_[tool: snip]_

_[tool: snip]_

The verifier passed — the Agent-BOM Atlas is confirmed working (186 nodes, all 9 lenses, auto-fit, inspector with real source paths).

Everything's in place and open in your tab. Whenever you're ready, the natural next moves are:
- **Deepen coverage** — per-namespace tool inspector, engine leaf-labels, or live counts (real 21 pending proposals, per-consumer resource totals).
- **Refine visuals** — layout balance, label de-collision on dense lenses, or a guided "tour" that auto-walks the lenses.

Just say the word.

## User

this is amazing. let's deepen coverage.

## Assistant

_[tool: read_file]_

Love it. Let me deepen the coverage substantially — pulling in the real internals: the registrar/writer/eval-adapter leaves, the daemon runtime + CLI, the 10 Hydra envelope subtypes, the **named critical-frozen roster**, and the **real 21 pending proposals** with their origins. First let me re-read the data model.

_[tool: str_replace_edit]_

This is the fun part — pulling the real internals into the graph. Let me update the group table, then add a large coverage block (engine internals, runtime, CLI, the 10 Hydra envelope subtypes, the named frozen roster, and the real 21 proposals). Starting with new groups + the arc-span cap so big clusters stay bounded.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the real 21 proposals:

_[tool: str_replace_edit]_

Now the big coverage block — engine internals, daemon runtime, CLI, Hydra envelope subtypes, and the named frozen roster:

_[tool: str_replace_edit]_

Now the lenses — wire the new groups into focused views and add a "Safety & Frozen" lens:

_[tool: str_replace_edit]_

Now add the four new group colors and tighten the lens bar (now 11 lenses) in the HTML:

_[tool: show_html]_

Let me verify it loads cleanly and check the new coverage numbers.

_[tool: get_webview_logs]_

_[tool: eval_js]_

_[tool: save_screenshot]_

Coverage jumped from 186 → **250 nodes, 316 links, 11 lenses**, zero dangling — engines now 31 (with the registrar/writer/eval leaves), proposals 22 (the real 21 + queue), plus runtime, CLI, 10 envelopes and the 12-node frozen roster. Let me see the dense lenses. Full atlas first.

_[tool: view_image]_

_[tool: save_screenshot]_

250 nodes render cleanly and the lens bar wrapped to two tidy rows. The amber proposal queue and the frozen roster are now substantial. Let me check the focused new lenses — Self-Evolution (the 21 proposals) and Safety & Frozen.

_[tool: view_image]_

_[tool: save_screenshot]_

The Self-Evolution lens now shows the real 21-proposal queue fanning off the HITL Queue, plus the frozen roster and invariants. Let me see Safety & Frozen and Hydra Flow.

_[tool: view_image]_

_[tool: delete_file]_

The Safety & Frozen lens with the roster selected is exactly the payoff — every named frozen resource from `ARCHITECTURE §12.3` radiating from the hub, tied to invariant #3: the 2 eights policies, 5 eval rubrics, the 3 ExecSuite skills, pp's security/contract/spec rubrics, RLM's 4 safety hooks, and Hydra's 8 squads + HITL gates.

Coverage is substantially deeper. Cleaning up and finalizing.

_[tool: done]_

_[tool: fork_verifier_agent]_

Coverage is now substantially deeper — the Atlas grew from **186 → 250 nodes / 316 edges**, all sourced from the repo:

**New internals added**
- **Engine leaves** — the 4 registrars, 4 WriteBridges, and 4 eval adapters (llm-judge, yaml-structural, rubric-backtest, noop) now exist as their own nodes under their parent engines (engines: 19 → 31).
- **Daemon runtime** — `config`, `logger`, `embeddings`, `completer`, `audit-repair`, `otel-sink`, `mcp/server`, `zod-to-json`, each with its real source path.
- **CLI** — `eights init / status / memory search / review` + `mcp-client`.
- **10 Hydra envelope subtypes** — CSuiteDecisionPacket, PRD, ArchRFC, DevTask, CreativeBrief, ShotList, AssetJob, DecisionRecord, HITLRequest, Handoff.
- **The named critical-frozen roster** (from `ARCHITECTURE §12.3`) — the 2 eights policies, 5 eval rubrics, ExecSuite's ai-governance/executive-protocol/financial-frameworks, pp's security/contract/spec rubrics, RLM's 4 safety hooks, Hydra's 8 squads + HITL gates — all wired to invariant #3.
- **The real 21 pending proposals** — by origin (RLM ×10, Hydra ×2, pp/AgentSmith ×3, ExecSuite ×1, cross-cutting ×5), each with risk class, proposer, and eval Δ, linked to both the HITL queue and its source consumer.

**Two new lenses** — **Hydra Flow** (envelopes, engine, squads, handoffs) and **Safety & Frozen** (the immutable surface) — bringing the total to **11 lenses**, which now wrap across two tidy rows.

It's open in your tab; a verifier is doing a pass. Possible next steps if you want to go further: the remaining engine watchers' file-level detail, live per-consumer resource sub-trees, or a guided "tour" that auto-walks the lenses with narration. Otherwise — this is a thorough map of the codebase.

## User

Verifier agent check completed

## Assistant

The verifier passed — the deepened Atlas (250 nodes, 11 lenses, frozen roster, real 21 proposals) is confirmed working.

_[tool: snip]_

You're all set. The **Agent-BOM Atlas** now maps the TheEights codebase in real depth — **250 nodes across 11 lenses**, from the substrate core down to individual registrars, WriteBridges, eval adapters, runtime files, CLI commands, the 10 Hydra envelope subtypes, the named critical-frozen roster, and the real 21 pending proposals — each node carrying its actual source path and clickable connections.

Whenever you want to push further, the open threads are:
- **Live data** — wire in real per-consumer resource sub-trees or actual counts.
- **Guided tour** — an auto-walk through the lenses with narration.
- **Watcher detail** — file-level breakdown of the pp/execsuite/rlm watchers.

Otherwise, this is a thorough, explorable map. Just say the word.

