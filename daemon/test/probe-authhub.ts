/**
 * AuthHub-only probe. Run via:
 *   npx tsx test/probe-authhub.ts
 * Requires EIGHTS_AUTHHUB_* env vars set.
 */
import { loadProviderConfig, createEmbedder, createCompleter } from "../src/providers/index.js";

process.env.EIGHTS_PROVIDER = "authhub";
process.env.EIGHTS_EMBED_PROVIDER = "authhub";
process.env.EIGHTS_LLM_PROVIDER = "authhub";
process.env.EIGHTS_ALLOW_CLOUD_PROVIDERS = "1";
process.env.EIGHTS_LLM_COMPLETIONS = "1";
process.env.EIGHTS_EMBEDDING_DIM = "1536";

async function main(): Promise<void> {
  console.log("AuthHub Provider Probe\n");

  try {
    const cfg = loadProviderConfig();
    console.log(`embed=${cfg.embedProvider}, llm=${cfg.llmProvider}`);
    console.log(`authhub base: ${cfg.authhubBaseUrl ?? "NOT SET"}`);
    console.log(`authhub key: ${cfg.authhubApiKey ? "set (redacted)" : "NOT SET"}`);
    console.log(`authhub embed model: ${cfg.authhubEmbedModel}`);
    console.log(`authhub llm model: ${cfg.authhubLlmModel}`);

    console.log("\n--- Embedder ---");
    let embedder;
    try {
      embedder = await createEmbedder(cfg);
      console.log("Embedder created successfully");
    } catch (e) {
      console.log(`Embedder creation FAILED: ${e instanceof Error ? e.message : e}`);
      return;
    }

    let embedAvail: boolean;
    try {
      embedAvail = await embedder.available();
      console.log(`Available: ${embedAvail}`);
    } catch (e) {
      console.log(`Available check FAILED: ${e instanceof Error ? e.message : e}`);
      embedAvail = false;
    }

    if (embedAvail) {
      try {
        const vec = await embedder.embed("The quick brown fox.");
        if (vec) {
          console.log(`Embedding OK: dim=${vec.length}`);
        } else {
          console.log(`Embedding returned null: ${embedder.lastError}`);
        }
      } catch (e) {
        console.log(`Embedding threw: ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log("\n--- Completer ---");
    let completer;
    try {
      completer = await createCompleter(cfg);
      console.log("Completer created successfully");
    } catch (e) {
      console.log(`Completer creation FAILED: ${e instanceof Error ? e.message : e}`);
      return;
    }

    let llmAvail: boolean;
    try {
      llmAvail = await completer.available();
      console.log(`Available: ${llmAvail}`);
    } catch (e) {
      console.log(`Available check FAILED: ${e instanceof Error ? e.message : e}`);
      llmAvail = false;
    }

    if (llmAvail) {
      try {
        const result = await completer.complete(
          "Reply in 10 words or fewer.",
          "What is 2+2?",
          { maxTokens: 32, temperature: 0 },
        );
        if (result) {
          console.log(`Completion OK: "${result.trim().slice(0, 100)}"`);
        } else {
          console.log(`Completion returned null: ${completer.lastError}`);
        }
      } catch (e) {
        console.log(`Completion threw: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    console.log(`Top-level error: ${e instanceof Error ? e.stack : e}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
