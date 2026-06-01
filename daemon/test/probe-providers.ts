/**
 * Quick provider probe — tests connectivity for OpenAI, DeepSeek, and Ollama.
 * Run via: npx tsx test/probe-providers.ts
 * Expects env vars set (or sourced from .env.local).
 */
import { loadProviderConfig, createEmbedder, createCompleter } from "../src/providers/index.js";

async function probeProvider(
  name: string,
  envOverrides: Record<string, string>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Provider: ${name}`);
    console.log(`${"=".repeat(60)}`);

    const cfg = loadProviderConfig();
    console.log(`  embed: ${cfg.embedProvider}, llm: ${cfg.llmProvider}`);

    // Embedder
    const embedder = await createEmbedder(cfg);
    const embedAvail = await embedder.available();
    console.log(`  Embedder available: ${embedAvail}`);
    if (embedAvail) {
      const vec = await embedder.embed("The quick brown fox jumps over the lazy dog.");
      if (vec) {
        console.log(`  Embedding OK: dim=${vec.length}, first3=[${vec[0]?.toFixed(4)}, ${vec[1]?.toFixed(4)}, ${vec[2]?.toFixed(4)}]`);
      } else {
        console.log(`  Embedding FAILED: ${embedder.lastError}`);
      }
    } else {
      console.log(`  Embedder not available: ${embedder.lastError ?? "(no error)"}`);
    }

    // Completer
    const completer = await createCompleter(cfg);
    const llmAvail = await completer.available();
    console.log(`  Completer available: ${llmAvail}`);
    if (llmAvail) {
      const result = await completer.complete(
        "You are a helpful assistant. Reply in 10 words or fewer.",
        "What is 2+2?",
        { maxTokens: 32, temperature: 0 },
      );
      if (result) {
        console.log(`  Completion OK: "${result.trim().slice(0, 100)}"`);
      } else {
        console.log(`  Completion FAILED: ${completer.lastError}`);
      }
    } else {
      console.log(`  Completer not available: ${completer.lastError ?? "(no error)"}`);
    }

    console.log(`  RESULT: ${embedAvail || llmAvail ? "PASS" : "FAIL"}`);
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  RESULT: FAIL`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main(): Promise<void> {
  console.log("Provider Connectivity Probe");
  console.log("Testing: Ollama, OpenAI, DeepSeek\n");

  // Test 1: Ollama (local)
  await probeProvider("Ollama (local)", {
    EIGHTS_PROVIDER: "ollama",
    EIGHTS_EMBED_PROVIDER: "ollama",
    EIGHTS_LLM_PROVIDER: "ollama",
    EIGHTS_ALLOW_CLOUD_PROVIDERS: "0",
    EIGHTS_LLM_COMPLETIONS: "1",
  });

  // Test 2: OpenAI (embed + completions)
  await probeProvider("OpenAI (embed + completions)", {
    EIGHTS_PROVIDER: "openai",
    EIGHTS_EMBED_PROVIDER: "openai",
    EIGHTS_LLM_PROVIDER: "openai",
    EIGHTS_ALLOW_CLOUD_PROVIDERS: "1",
    EIGHTS_LLM_COMPLETIONS: "1",
    EIGHTS_EMBEDDING_DIM: "1536",
  });

  // Test 3: DeepSeek (completions only)
  await probeProvider("DeepSeek (completions only)", {
    EIGHTS_PROVIDER: "ollama",
    EIGHTS_EMBED_PROVIDER: "ollama",
    EIGHTS_LLM_PROVIDER: "deepseek",
    EIGHTS_ALLOW_CLOUD_PROVIDERS: "1",
    EIGHTS_LLM_COMPLETIONS: "1",
  });

  // Test 4: Mixed — OpenAI embeddings + DeepSeek completions
  await probeProvider("Mixed: OpenAI embed + DeepSeek LLM", {
    EIGHTS_EMBED_PROVIDER: "openai",
    EIGHTS_LLM_PROVIDER: "deepseek",
    EIGHTS_PROVIDER: "ollama",
    EIGHTS_ALLOW_CLOUD_PROVIDERS: "1",
    EIGHTS_LLM_COMPLETIONS: "1",
    EIGHTS_EMBEDDING_DIM: "1536",
  });

  // Test 5: Cloud gate enforcement
  await probeProvider("Cloud gate enforcement (should fail)", {
    EIGHTS_PROVIDER: "openai",
    EIGHTS_EMBED_PROVIDER: "openai",
    EIGHTS_LLM_PROVIDER: "openai",
    EIGHTS_ALLOW_CLOUD_PROVIDERS: "0",
    EIGHTS_LLM_COMPLETIONS: "1",
  });

  // Test 6: LLM gate (completions disabled)
  await probeProvider("LLM gate (completions disabled)", {
    EIGHTS_PROVIDER: "openai",
    EIGHTS_EMBED_PROVIDER: "openai",
    EIGHTS_LLM_PROVIDER: "openai",
    EIGHTS_ALLOW_CLOUD_PROVIDERS: "1",
    EIGHTS_LLM_COMPLETIONS: "0",
    EIGHTS_EMBEDDING_DIM: "1536",
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log("  All probes complete.");
  console.log(`${"=".repeat(60)}`);
}

main().catch(console.error);
