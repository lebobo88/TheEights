process.env.EIGHTS_AUTHHUB_BASE_URL = "http://localhost:3100";
process.env.EIGHTS_AUTHHUB_API_KEY = "ak_ff967c02d29170a9b4512200d96ed87b92f96ed681e5da8dc37356e7e0fc041d";

async function main() {
  console.log("Direct AuthHub SDK test\n");

  // Try importing the SDK directly
  let AuthHubClient: unknown;
  try {
    const mod = await import("@authhub/sdk");
    AuthHubClient = mod.AuthHubClient;
    console.log("SDK imported OK");
  } catch (e) {
    console.log(`SDK import failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  // Create client
  const client = new (AuthHubClient as new (opts: { baseUrl: string; apiKey: string }) => {
    ai: {
      createEmbedding(opts: { model: string; input: string; dimensions?: number }): Promise<unknown>;
      chat(opts: { model: string; messages: Array<{ role: string; content: string }>; max_tokens?: number }): Promise<unknown>;
    };
  })({
    baseUrl: "http://localhost:3100",
    apiKey: process.env.EIGHTS_AUTHHUB_API_KEY!,
  });
  console.log("Client created OK\n");

  // Test embedding
  console.log("--- Embedding test ---");
  try {
    const res = await client.ai.createEmbedding({
      model: "text-embedding-3-small",
      input: "hello world",
      dimensions: 1536,
    });
    console.log("Embedding response:", JSON.stringify(res).slice(0, 300));
  } catch (e) {
    console.log(`Embedding error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }

  // Test chat
  console.log("\n--- Chat test ---");
  try {
    const res = await client.ai.chat({
      model: process.env.EIGHTS_AUTHHUB_LLM_MODEL ?? "gpt-5.4-mini",
      messages: [{ role: "user", content: "What is 2+2? Reply in one word." }],
      max_tokens: 16,
    });
    console.log("Chat response:", JSON.stringify(res).slice(0, 300));
  } catch (e) {
    console.log(`Chat error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
