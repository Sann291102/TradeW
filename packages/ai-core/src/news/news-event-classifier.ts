import { LlmProvider } from '../providers/interfaces';

/**
 * Financial news event classification — ported from NVIDIA's "AI Model
 * Distillation for Financial Data" blueprint (see docs/ai/DISTILLATION.md).
 *
 * The blueprint's teacher model (Llama 3.3 Nemotron Super 49B on NIM) labels
 * headlines into 13 event categories; the NeMo Data Flywheel then distills a
 * small student model (e.g. fine-tuned llama-3.2-3b) that serves the same
 * classification cheaply. On our side both are just an LlmProvider — point
 * NVIDIA_NIM_BASE_URL at the deployed student NIM and this classifier uses it
 * without any code change (provider-agnostic by design).
 */

/** The blueprint's 13 standardized event categories (VALID_LABELS). */
export const NEWS_EVENT_LABELS = [
  'Analyst Rating',
  'Price Targets',
  'Earnings',
  'Labour Issues',
  'Mergers and Acquisitions',
  'Dividends',
  'Regulatory',
  'Stock price movement',
  'Credit Ratings',
  'Products-Services',
  'Product Approval',
  'Guidance',
  'OTHER',
] as const;

export type NewsEventLabel = (typeof NEWS_EVENT_LABELS)[number];

/** Classification prompt — faithful adaptation of the blueprint's teacher prompt. */
export const NEWS_EVENT_PROMPT = `You are a helpful AI assistant that analyses financial news headlines and identifies what event type is described.
You will classify event types into one of the following categories (in square brackets):

- [Analyst Rating]: An entity such as a bank, asset manager, etc. gives a classification/rating/downgrade/upgrade/opinion to an asset. If there is no specified analyst and company given, it's not Analyst Rating and should be OTHER.
- [Price Targets]: A mention of a price target (PT) given by an entity such as a bank, asset manager, etc. This takes priority over any other class.
- [Earnings]: Reports of quarterly/monthly concrete values of revenue, EPS, etc. Expected values are not Earnings and should be Guidance instead.
- [Labour Issues]: Layoffs, union action, strikes, labour costs, executive bonuses, important personnel changes (CEO, CFO, VPs).
- [Mergers and Acquisitions]: Merging or acquisition of entities. Partnerships do not belong to this class. Takes priority over other classes.
- [Dividends]: Dividend performance, dividend per share, decisions not to issue dividends, etc.
- [Regulatory]: Environmental affairs, government regulation, treaties, geopolitics, debt repayment, licenses, patents; any executive decision taken by a government. Takes priority over other classes.
- [Stock price movement]: Pricing of public offerings, daily/monthly/yearly movements, highs and lows, options trade alerts — only when a specific entity/industry is mentioned. Stock splits do not count.
- [Credit Ratings]: Adjustments of a company's borrowing capacity, changes in debt values or ratings.
- [Products-Services]: A company's particular product, forward-looking product directions, disruptions, contracts, product delays.
- [Product Approval]: FDA/environmental approvals, acceptance for review — any entity approving a corporation's product rollout.
- [Guidance]: Forward-looking statements issued by companies themselves (projected revenue, EPS, sales) — projections rather than realised values.

If the headline doesn't match any class, classify it as OTHER.
ATTENTION:
- Only assign a category if the headline meets all the criteria listed for it; otherwise use OTHER.
- Prefer precise matching over partial or superficial similarity; OTHER is the default when in doubt.
- If no specific company is mentioned, use OTHER.

Answer with ONLY the category name in square brackets, e.g. [Earnings].`;

export interface ClassifiedHeadline {
  headline: string;
  eventType: NewsEventLabel;
  /** raw model output before standardization, kept for the audit trail */
  rawLabel: string;
  servedBy: { provider: string; model: string };
}

/**
 * Deterministic label standardization — replaces the blueprint's LLM cleanup
 * pass. Strips brackets/prefixes and maps casing/synonym variants onto the 13
 * valid labels; anything unmappable becomes OTHER (the blueprint's default).
 */
export function standardizeLabel(raw: string): NewsEventLabel {
  const cleaned = raw
    .replace(/^[\s\S]*?(\[[^\]]+\])[\s\S]*$/, '$1') // grab the first [bracketed] token if present
    .replace(/[[\]]/g, '')
    .replace(/^event\s*type\s*:\s*/i, '')
    .trim()
    .toLowerCase();

  const aliases: Record<string, NewsEventLabel> = {
    'analyst rating': 'Analyst Rating',
    'analyst ratings': 'Analyst Rating',
    'price target': 'Price Targets',
    'price targets': 'Price Targets',
    earnings: 'Earnings',
    'labour issues': 'Labour Issues',
    'labor issues': 'Labour Issues',
    'mergers and acquisitions': 'Mergers and Acquisitions',
    'm&a': 'Mergers and Acquisitions',
    dividends: 'Dividends',
    dividend: 'Dividends',
    regulatory: 'Regulatory',
    'stock price movement': 'Stock price movement',
    'stock price movements': 'Stock price movement',
    'credit ratings': 'Credit Ratings',
    'credit rating': 'Credit Ratings',
    'products-services': 'Products-Services',
    'products services': 'Products-Services',
    'products and services': 'Products-Services',
    'product approval': 'Product Approval',
    guidance: 'Guidance',
    other: 'OTHER',
  };
  return aliases[cleaned] ?? 'OTHER';
}

export class NewsEventClassifier {
  constructor(private llm: LlmProvider) {}

  async classify(headline: string): Promise<ClassifiedHeadline> {
    const response = await this.llm.complete({
      tier: 'fast', // per the blueprint: a small distilled student handles this well
      maxTokens: 20,
      temperature: 0,
      messages: [
        { role: 'system', content: NEWS_EVENT_PROMPT },
        { role: 'user', content: `What is the event type for this news headline: ${headline}?` },
      ],
    });
    return {
      headline,
      eventType: standardizeLabel(response.text),
      rawLabel: response.text.trim(),
      servedBy: response.servedBy,
    };
  }

  /** Sequential batch with bounded concurrency to stay polite to rate limits. */
  async classifyBatch(headlines: string[], concurrency = 5): Promise<ClassifiedHeadline[]> {
    const results: ClassifiedHeadline[] = new Array(headlines.length);
    let next = 0;
    const worker = async () => {
      while (next < headlines.length) {
        const i = next++;
        results[i] = await this.classify(headlines[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, headlines.length) }, worker));
    return results;
  }
}
