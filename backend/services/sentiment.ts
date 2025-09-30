import axios from 'axios';

export type SentimentOptions = {
  maxItems?: number; // max tweets to fetch
  tweetLanguage?: string; // ISO 639-1 e.g. 'en'
  minFaves?: number;
  minReplies?: number;
  minRetweets?: number;
};

export type SentimentResult = {
  query: string;
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  topTweets: Array<{ text: string; url?: string; likeCount?: number; retweetCount?: number; replyCount?: number; createdAt?: string; author?: string }>;
};

const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR_ID = 'apidojo~tweet-scraper';

// No date logic for now; we strictly use the actor template with cashtag

function quickSentiment(text: string): 'pos' | 'neg' | 'neu' {
  const t = text.toLowerCase();
  const posWords = ['bull', 'pump', 'moon', '🚀', '🔥', 'good', 'great', 'love', 'win', 'profit'];
  const negWords = ['dump', 'scam', 'rug', 'bad', 'hate', 'down', 'lose', 'bagholder', 'rekt'];
  let score = 0;
  for (const w of posWords) if (t.includes(w)) score += 1;
  for (const w of negWords) if (t.includes(w)) score -= 1;
  if (score > 0) return 'pos';
  if (score < 0) return 'neg';
  return 'neu';
}

export class OnlineSentimentService {
  constructor(private token = process.env.APIFY_TOKEN as string | undefined) {
    // APIFY_TOKEN is now optional - Tavily can be used as fallback
    if (!this.token && !process.env.TAVILY_API) {
      console.warn('⚠️  Neither APIFY_TOKEN nor TAVILY_API is set. Sentiment analysis will not work.');
    }
  }

  async analyze(query: string, opts: SentimentOptions = {}): Promise<SentimentResult> {
    const maxItems = opts.maxItems ?? 100; // align with provided template
    const tweetLanguage = 'en'; // align exactly with template
    // derive cashtag from the first token of query
    const base = query.split(/\s+/)[0].replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (!base) throw new Error('Unable to derive cashtag from query');
    const cashtag = `$${base}`;
    const minFaves = opts.minFaves ?? 5;
    const minReplies = opts.minReplies ?? 5;
    const minRetweets = opts.minRetweets ?? 5;

    let items: any[] = [];
    
    // Only try Apify if token is available
    if (this.token) {
      try {
        // 1) Start run (Top sort, minimal thresholds)
        const startUrl = `${APIFY_BASE}/acts/${encodeURIComponent(ACTOR_ID)}/runs?token=${this.token}`;
      // EXACT payload fields per template
      const input: any = {
        customMapFunction: '(object) => { return {...object} }',
        includeSearchTerms: false,
        onlyImage: false,
        onlyQuote: false,
        onlyTwitterBlue: false,
        onlyVerifiedUsers: false,
        onlyVideo: false,
        searchTerms: [cashtag],
        mentioning: cashtag,
        sort: 'Top',
        tweetLanguage,
        maxItems,
        minimumFavorites: minFaves,
        minimumReplies: minReplies,
        minimumRetweets: minRetweets,
      };
      const startRes = await axios.post(startUrl, input, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
      const runId: string | undefined = startRes?.data?.data?.id;
      const datasetIdFromStart: string | undefined = startRes?.data?.data?.defaultDatasetId;
      if (!runId) throw new Error('Apify run did not return an id');

      // 2) Poll run status
      const runUrl = `${APIFY_BASE}/actor-runs/${runId}?token=${this.token}`;
      const started = Date.now();
      let status = 'READY';
      let datasetId = datasetIdFromStart;
      while (Date.now() - started < 120000) { // up to 120s
        const r = await axios.get(runUrl, { timeout: 15000 });
        status = r?.data?.data?.status || status;
        datasetId = r?.data?.data?.defaultDatasetId || datasetId;
        if (status === 'SUCCEEDED') break;
        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          throw new Error(`Apify run ended with status ${status}`);
        }
        await new Promise(res => setTimeout(res, 3000));
      }
      if (status !== 'SUCCEEDED') throw new Error(`Apify run did not finish in time (status: ${status})`);

      // 3) Fetch items
      if (!datasetId) throw new Error('No dataset id returned by Apify');
      const itemsUrl = `${APIFY_BASE}/datasets/${datasetId}/items?token=${this.token}&clean=true&limit=${maxItems}`;
        const itemsRes = await axios.get(itemsUrl, { timeout: 30000 });
        items = itemsRes?.data || [];
      } catch (apifyErr) {
        console.log('⚠️  Apify failed, falling back to Tavily...');
        items = [];
      }
    } else {
      console.log('ℹ️  No APIFY_TOKEN configured, using Tavily directly');
    }

    // If no items, fallback to Tavily Web Search
    if (!items.length) {
      const tavilyKey = process.env.TAVILY_API;
      if (tavilyKey) {
        console.log(`🔍 Attempting Tavily search for: ${cashtag}`);
        try {
          const tavilyQuery = `${cashtag} sentiment news community opinion`;
          const tavilyRes = await axios.post(
            'https://api.tavily.com/search',
            { 
              api_key: tavilyKey,
              query: tavilyQuery, 
              search_depth: 'basic', 
              include_answer: false, 
              max_results: maxItems 
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
          );
          const results: any[] = tavilyRes?.data?.results || [];
          // Map Tavily results to items-like objects
          items = results.map(r => ({
            text: r.content || r.title || '',
            url: r.url,
            likeCount: Math.round((r.score || 0) * 100),
            createdAt: undefined,
            author: undefined,
          }));
          console.log(`✅ Tavily returned ${items.length} results`);
        } catch (tavilyErr: any) {
          console.error('❌ Tavily failed:', tavilyErr?.response?.data || tavilyErr?.message || tavilyErr);
          // leave items empty
        }
      } else {
        console.log('⚠️  TAVILY_API not configured');
      }
    }

    // 4) Summarize
    let total = 0, positive = 0, negative = 0, neutral = 0;
    const topTweets: SentimentResult['topTweets'] = [];

    for (const it of items) {
      if (!it || typeof it.text !== 'string') continue;
      total += 1;
      const s = quickSentiment(it.text);
      if (s === 'pos') positive += 1; else if (s === 'neg') negative += 1; else neutral += 1;
      // Collect top by likeCount as a rough proxy
      topTweets.push({
        text: it.text,
        url: it.url || it.twitterUrl,
        likeCount: it.likeCount,
        retweetCount: it.retweetCount,
        replyCount: it.replyCount,
        createdAt: it.createdAt,
        author: it?.author?.userName,
      });
    }

    topTweets.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));

    return { query, total, positive, negative, neutral, topTweets: topTweets.slice(0, 5) };
  }
}
