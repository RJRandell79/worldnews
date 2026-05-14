require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const cron = require('node-cron');
const Parser = require('rss-parser');
const countries = require('../data/countries.json');

const API_KEY    = process.env.NEWS_API_KEY;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const SECRET     = process.env.INTERNAL_SECRET || 'newslocator-internal';

const rssParser = new Parser({ timeout: 10000 });

const RSS_FEEDS = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
  { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
  { name: 'BBC Latin Am.', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml' },
  { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  { name: 'RFI English', url: 'https://www.rfi.fr/en/rss' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'France 24', url: 'https://www.france24.com/en/rss' },
  { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-all' },
  { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  { name: 'ABC News', url: 'https://abcnews.go.com/abcnews/internationalheadlines' },
  { name: 'Merco Press', url: 'https://en.mercopress.com/rss' },
  { name: 'ABC News Australia', url: 'https://www.abc.net.au/news/feed/51120/rss.xml' },
  { name: 'CBC World', url: 'https://www.cbc.ca/cmlink/rss-world' },
  { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
  { name: 'Xinhua', url: 'http://www.xinhuanet.com/english/rss/worldrss.xml' }
];

// Build regex patterns: [{iso2, patterns[]}]
const index = countries.map(({ iso2, name, aliases }) => ({
  iso2,
  patterns: [name, ...aliases].map(
    term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  ),
}));

async function fetchNewsApi() {
  if (!API_KEY) return [];
  const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=100&apiKey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NewsAPI ${res.status}`);
  const { articles } = await res.json();
  return (articles || []).map(a => ({
    title:       a.title,
    description: a.description,
    url:         a.url,
    source:      a.source?.name,
    publishedAt: a.publishedAt,
  }));
}

async function fetchRssFeeds() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async ({ name, url }) => {
      const feed = await rssParser.parseURL(url);
      return feed.items.map(item => ({
        title:       item.title,
        description: item.contentSnippet || item.summary || '',
        url:         item.link,
        source:      name,
        publishedAt: item.pubDate || item.isoDate,
      }));
    })
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[monitor] RSS failed (${RSS_FEEDS[i].name}): ${r.reason?.message}`);
    }
  });

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

function deduplicateByUrl(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

function extractMentionsAndHeadlines(articles) {
  const mentions = {};
  const countryHeadlines = {};
  const countrySources = {};

  for (const article of articles) {
    const text = `${article.title ?? ''} ${article.description ?? ''}`;
    for (const { iso2, patterns } of index) {
      if (patterns.some(p => p.test(text))) {
        mentions[iso2] = (mentions[iso2] ?? 0) + 1;

        if (article.source) {
          if (!countrySources[iso2]) countrySources[iso2] = {};
          countrySources[iso2][article.source] = (countrySources[iso2][article.source] || 0) + 1;
        }

        if (!countryHeadlines[iso2]) countryHeadlines[iso2] = [];
        if (countryHeadlines[iso2].length < 8) {
          countryHeadlines[iso2].push({
            title:       article.title,
            url:         article.url,
            source:      article.source,
            publishedAt: article.publishedAt,
          });
        }
      }
    }
  }
  return { mentions, countryHeadlines, countrySources };
}

async function postUpdate(data, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/internal/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': SECRET },
        body: JSON.stringify(data),
      });
      if (res.ok) return;
    } catch {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  console.error('[monitor] Failed to reach server after retries');
}

async function run() {
  console.log('[monitor] Fetching all sources...');
  try {
    const [newsApiArticles, rssArticles] = await Promise.allSettled([
      fetchNewsApi(),
      fetchRssFeeds(),
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

    const articles = deduplicateByUrl([...newsApiArticles, ...rssArticles])
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    const { mentions, countryHeadlines, countrySources } = extractMentionsAndHeadlines(articles);
    const headlines = articles.slice(0, 25).map(a => ({
      title:       a.title,
      url:         a.url,
      source:      a.source,
      publishedAt: a.publishedAt,
    }));

    await postUpdate({ mentions, headlines, countryHeadlines, countrySources });
    console.log(`[monitor] Done — ${articles.length} articles, ${Object.keys(mentions).length} countries`);
  } catch (err) {
    console.error('[monitor] Error:', err.message);
  }
}

setTimeout(run, 2500);
cron.schedule('*/30 * * * *', run);