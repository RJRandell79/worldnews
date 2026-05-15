require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const cron = require('node-cron');
const Parser = require('rss-parser');
const countries = require('../data/countries.json');

const API_KEY    = process.env.NEWS_API_KEY;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const SECRET     = process.env.INTERNAL_SECRET || 'newslocator-internal';

const rssParser = new Parser({ timeout: 10000 });

const CATEGORIES = {
  conflict: ['war','attack','killed','airstrike','military','troops','bomb','missile','fighting','forces','siege','ceasefire','hostage','rebel','coup','drone','casualties','violence','offensive'],
  politics: ['election','vote','parliament','president','minister','government','treaty','diplomacy','sanctions','protest','summit','opposition','prime minister','resign','senate','congress'],
  economy: ['economy','trade','inflation','oil','gas','market','bank','debt','investment','tariff','recession','currency','stock','unemployment','budget','gdp','economic growth','interest rate','wage','supply chain','commerce','economics','exports','imports'],
  disaster: ['earthquake','flood','hurricane','typhoon','wildfire','tsunami','volcano','drought','storm','landslide','cyclone','disaster','evacuate'],
  health: ['virus','pandemic','disease','outbreak','hospital','vaccine','epidemic','covid','infection','health','medical'],
  crime: ['arrested','trial','convicted','sentenced','murder','fraud','corruption','trafficking','terrorism','suspect','charged','court','prison','criminal','indictment','extradited','gang','cartel','robbery','shooter','gunman'],
  weather: ['heatwave','temperature','snow','frost','blizzard','rainfall','flooding','climate','forecast','cold snap','humidity','monsoon','ice storm','hail','drought warning'],
  science: ['research','study','scientists','discovery','species','fossil','genome','laboratory','experiment','findings','breakthrough','physics','biology','archaeology','genetics','quantum'],
  space: ['nasa','spacex','rocket','satellite','orbit','astronaut','moon','mars','planet','telescope','launch','iss','galaxy','spacecraft','asteroid','cosmos','solar','webb','asteroid'],
  legal: ['ruling','verdict','lawsuit','appeal','prosecution','judge','jury','indicted','pleaded','settlement','injunction','tribunal','hearing','testimony','acquitted','bail','litigation','supreme court','appeals court','court of appeal'],
  sport: ['football','soccer','cricket','tennis','rugby','basketball','baseball','athletics','olympics','championship','tournament','league','cup','match','player','team','coach','transfer','fifa','uefa','formula 1','f1','cycling','swimming','boxing','golf', 't20','wimbledon','world cup','super bowl','nba','nfl','mlb','uefa','champions league', 't20i', 'grand slam'],
};

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

function categorise(title, description) {
  const text = `${title ?? ''} ${description ?? ''}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORIES)) {
    const score = words.filter(w => text.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best; // null if nothing matched
}

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
  const articleCountries = {};

  for (const article of articles) {
    const text = `${article.title ?? ''} ${article.description ?? ''}`;
    for (const { iso2, patterns } of index) {
      if (patterns.some(p => p.test(text))) {
        mentions[iso2] = (mentions[iso2] ?? 0) + 1;

        if (article.url) {
          if (!articleCountries[article.url]) articleCountries[article.url] = [];
          if (!articleCountries[article.url].includes(iso2))
            articleCountries[article.url].push(iso2);
        }

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
            category:    article.category
          });
        }
      }
    }
  }
  return { mentions, countryHeadlines, countrySources, articleCountries };
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
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .map(a => ({ ...a, category: categorise(a.title, a.description) }));

    const { mentions, countryHeadlines, countrySources, articleCountries } = extractMentionsAndHeadlines(articles);
    const headlines = articles.slice(0, 25).map(a => ({
      title:       a.title,
      url:         a.url,
      source:      a.source,
      publishedAt: a.publishedAt,
      countries:    (articleCountries[a.url] || []).slice(0, 3), // For top headlines, include up to 3 mentioned countries
      category:     a.category
    }));

    await postUpdate({ mentions, headlines, countryHeadlines, countrySources, totalArticles: articles.length });
    console.log(`[monitor] Done — ${articles.length} articles, ${Object.keys(mentions).length} countries`);
  } catch (err) {
    console.error('[monitor] Error:', err.message);
  }
}

setTimeout(run, 2500);
cron.schedule('*/30 * * * *', run);