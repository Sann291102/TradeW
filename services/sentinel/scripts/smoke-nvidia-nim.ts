/**
 * Connectivity smoke test for the NVIDIA NIM free tier (build.nvidia.com).
 *
 *   npm run nim:smoke            (from services/sentinel)
 *
 * Reads the root .env, assembles the provider manager exactly the way
 * Sentinel does at boot, and exercises the three capabilities NIM can serve on
 * the free tier: an LLM completion per tier, a retrieval embedding, and the
 * news-event classifier from the NVIDIA distillation blueprint
 * (see docs/ai/DISTILLATION.md).
 *
 * No database, no NestJS boot — this only answers "is the key wired correctly
 * and which provider actually serves each call?".
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') }); // root .env — see .env.example
import {
  createProviderManager,
  loadProvidersConfigFromEnv,
  NewsEventClassifier,
  ProviderNotAvailableError,
} from '@tradew/ai-core';

const TIERS = ['fast', 'balanced', 'deep'] as const;

/** Headlines with an unambiguous blueprint label, so a wrong answer is obvious. */
const HEADLINES: { headline: string; expect: string }[] = [
  { headline: 'Reliance Industries Q2 revenue rises 12% to Rs 2.4 lakh crore', expect: 'Earnings' },
  { headline: 'Morgan Stanley raises Infosys price target to Rs 2,100 from Rs 1,850', expect: 'Price Targets' },
  { headline: 'SEBI tightens disclosure norms for algorithmic trading platforms', expect: 'Regulatory' },
  { headline: 'HDFC Bank board approves interim dividend of Rs 19.5 per share', expect: 'Dividends' },
];

async function main(): Promise<void> {
  const config = loadProvidersConfigFromEnv();

  console.log('=== 0. resolved configuration ===');
  console.log(`  AI_LLM_ORDER:       ${config.selection.llm.join(', ')}`);
  console.log(`  AI_EMBEDDING_ORDER: ${config.selection.embedding.join(', ')}`);
  if (!config.nvidiaNim) {
    console.error(
      '\n  nvidia-nim is NOT configured. Set NVIDIA_NIM_API_KEY (free key from\n' +
        '  https://build.nvidia.com) in services/sentinel/.env, then re-run.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  NIM base URL:       ${config.nvidiaNim.baseUrl ?? 'https://integrate.api.nvidia.com/v1 (default)'}`);
  console.log(`  NIM API key:        ${config.nvidiaNim.apiKey ? 'set' : 'MISSING (hosted NIM needs one)'}`);
  console.log(`  NIM embed model:    ${config.nvidiaNim.embeddingModel ?? 'not set — embeddings will be skipped'}`);
  const models = config.nvidiaNim.models;
  console.log(`  NIM tier models:    ${models ? `${models.fast} / ${models.balanced} / ${models.deep}` : 'built-in defaults'}`);
  console.log(`  NIM thinking:       ${JSON.stringify(config.nvidiaNim.extraBody ?? {}) || 'not set'}`);
  console.log(`  NIM top_p/timeout:  ${config.nvidiaNim.topP ?? 'unset'} / ${config.nvidiaNim.timeoutMs ?? 300000}ms`);

  const hosted = (config.nvidiaNim.baseUrl ?? '').includes('integrate.api.nvidia.com');
  if (hosted && !config.nvidiaNim.apiKey) {
    console.error(
      '\n  NVIDIA_NIM_BASE_URL points at the hosted catalog but NVIDIA_NIM_API_KEY is\n' +
        '  empty — every call below would 401. Get a free key at https://build.nvidia.com\n' +
        '  (open any model -> "Get API Key"), put the nvapi-... value in\n' +
        '  services/sentinel/.env, then re-run. Self-hosted NIM needs no key.',
    );
    process.exitCode = 1;
    return;
  }

  const manager = createProviderManager(config);

  console.log('\n=== 1. LLM completion per tier ===');
  let llm;
  try {
    llm = manager.getLlm();
  } catch (err) {
    if (err instanceof ProviderNotAvailableError) {
      console.error(`  ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(`  active LLM provider: ${llm.name}`);
  if (llm.name !== 'nvidia-nim') {
    console.log('  NOTE: another provider outranks nvidia-nim in AI_LLM_ORDER.');
  }

  for (const tier of TIERS) {
    const started = Date.now();
    try {
      const res = await llm.complete({
        tier,
        // reasoning models spend max_tokens on their chain-of-thought before
        // writing a single visible word, so a 60-token budget returns a
        // truncated answer. Give the deep tier room to think.
        maxTokens: tier === 'deep' ? 4096 : 60,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Answer in one short sentence. No preamble.' },
          { role: 'user', content: 'What does implied volatility measure in an options market?' },
        ],
      });
      const ms = Date.now() - started;
      console.log(`  [${tier}] ${res.servedBy.provider} / ${res.servedBy.model}  ${ms}ms  ` +
        `(in ${res.usage.inputTokens} / out ${res.usage.outputTokens} tokens)`);
      console.log(`         ${res.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
      if (res.reasoning) {
        console.log(`         [thinking ${res.reasoning.length} chars, kept out of .text]`);
      }
      if (!res.text.trim()) {
        console.error('         EMPTY answer — raise maxTokens or disable NVIDIA_NIM_ENABLE_THINKING.');
        process.exitCode = 1;
      }
      if (ms > 30_000) {
        console.log(`         SLOW: ${(ms / 1000).toFixed(0)}s per call — unsuitable for latency-sensitive paths.`);
      }
    } catch (err) {
      console.error(`  [${tier}] FAILED: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  console.log('\n=== 2. retrieval embeddings ===');
  try {
    const embedder = manager.getEmbedding();
    console.log(`  active embedding provider: ${embedder.name}`);
    const passage = await embedder.embed({
      texts: ['A low-volume breakout above resistance often precedes a bull trap.'],
      inputType: 'document', // the NIM adapter maps 'document' -> input_type 'passage'
    });
    const query = await embedder.embed({ texts: ['what is a bull trap?'], inputType: 'query' });
    console.log(`  passage: ${passage.dimensions} dims via ${passage.servedBy.provider} / ${passage.servedBy.model}`);
    console.log(`  query:   ${query.dimensions} dims`);
    if (passage.dimensions !== query.dimensions) {
      console.error('  MISMATCH: query and passage dimensions differ — retrieval would be broken.');
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ProviderNotAvailableError) {
      console.log(`  skipped — ${err.message}`);
    } else {
      console.error(`  FAILED: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  console.log('\n=== 3. news-event classifier (NVIDIA distillation blueprint) ===');
  const classifier = new NewsEventClassifier(llm);
  try {
    // concurrency 2: the free tier is rate limited (~40 req/min shared)
    const classified = await classifier.classifyBatch(
      HEADLINES.map((h) => h.headline),
      2,
    );
    let hits = 0;
    classified.forEach((c, i) => {
      const ok = c.eventType === HEADLINES[i].expect;
      if (ok) hits++;
      console.log(`  ${ok ? 'ok  ' : 'MISS'} ${c.eventType.padEnd(26)} expected ${HEADLINES[i].expect}`);
      console.log(`       "${c.headline.slice(0, 80)}"  [raw: ${c.rawLabel.replace(/\s+/g, ' ').slice(0, 40)}]`);
    });
    console.log(`  ${hits}/${HEADLINES.length} matched the expected label ` +
      `(served by ${classified[0]?.servedBy.provider} / ${classified[0]?.servedBy.model})`);
  } catch (err) {
    console.error(`  FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
  }

  console.log(`\n=== done ${process.exitCode ? '(with failures)' : '— NIM is wired correctly'} ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
