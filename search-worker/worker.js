// pb-ask-search — PoorBoyAI's own tiny web-search proxy for the Ask PB
// hackathon app. The app fetches live results here, feeds them to the
// model as context, and lists the real pages it checked under the
// answer. No vendor search API, no key: plain fetches of public search
// result pages, parsed in-house.
//
// GET /?q=<query>  ->  { query, source, results: [{ title, url, snippet }] }
//
// Relevance law (added 2026-11-26 after a live failure): raw engine
// output is NEVER trusted. DuckDuckGo's html endpoint intermittently
// serves an anomaly/challenge page (HTTP 202, zero parseable results),
// which used to drop us into an unfiltered Bing fallback — and Bing
// happily returned Priceline / Booking.com / a bike-tire article for
// "What is the price of ETH right now?", which the app then listed as
// PB's sources. Every result now has to EARN its place: it must share
// query terms with the question (ticker/name aliases count), price
// questions get a rewritten, price-biased query plus a boost for known
// price sources, and Bing's click-redirect URLs are unwrapped to the
// real pages. If nothing relevant survives, results is empty and the
// app fails open — PB answers without sources and still will not
// invent a number the results did not carry.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=60",
    },
  });
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function unwrapDdg(href) {
  try {
    const u = new URL(href.startsWith("//") ? "https:" + href : href);
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : u.toString();
  } catch {
    return href;
  }
}

// Bing wraps result links in bing.com/ck/a?...&u=a1<base64-of-real-url>.
// Decode it so the app lists (and the model cites) the real page.
function unwrapBing(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)bing\.com$/i.test(u.hostname) || !u.pathname.startsWith("/ck/")) {
      return href;
    }
    const enc = u.searchParams.get("u");
    if (!enc || !enc.startsWith("a1")) return href;
    let b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = atob(b64);
    return decoded.startsWith("http") ? decoded : href;
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(q) {
  const res = await fetch(
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q),
    { headers: { "User-Agent": UA }, cf: { cacheTtl: 60 } },
  );
  if (!res.ok) return [];
  const html = await res.text();
  const results = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 10) {
    const url = unwrapDdg(decodeEntities(m[1]));
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (url && title) results.push({ title, url, snippet, engine: "duckduckgo" });
  }
  return results;
}

async function searchBing(q) {
  const res = await fetch(
    "https://www.bing.com/search?q=" + encodeURIComponent(q),
    { headers: { "User-Agent": UA }, cf: { cacheTtl: 60 } },
  );
  if (!res.ok) return [];
  const html = await res.text();
  const results = [];
  const re =
    /<li class="b_algo"[\s\S]*?<h2><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 10) {
    const url = unwrapBing(decodeEntities(m[1]));
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (url && title) results.push({ title, url, snippet, engine: "bing" });
  }
  return results;
}

/* ---------------- relevance ---------------- */

const STOPWORDS = new Set([
  "what", "is", "the", "a", "an", "of", "right", "now", "today",
  "me", "tell", "please", "how", "much", "does", "do", "did", "in",
  "on", "for", "to", "and", "or", "at", "by", "was", "were", "are",
  "it", "its", "this", "that", "with", "from", "about", "who",
  "when", "where", "why", "which", "can", "you", "i",
]);

// Ticker <-> full name, both directions count as a match.
const TICKER_NAMES = {
  eth: "ethereum", btc: "bitcoin", sol: "solana", xrp: "xrp",
  doge: "dogecoin", ada: "cardano", ltc: "litecoin", avax: "avalanche",
  dot: "polkadot", link: "chainlink", matic: "polygon", bnb: "bnb",
  atom: "cosmos", uni: "uniswap", near: "near", apt: "aptos",
  arb: "arbitrum", op: "optimism", sui: "sui", pepe: "pepe",
  shib: "shiba inu",
};
const NAME_TO_TICKER = {};
for (const [t, n] of Object.entries(TICKER_NAMES)) {
  if (!NAME_TO_TICKER[n]) NAME_TO_TICKER[n] = t;
}

const PRICE_DOMAINS = [
  "coinmarketcap.com", "coingecko.com", "coindesk.com",
  "finance.yahoo.com", "binance.com", "tradingview.com",
  "coinbase.com", "kraken.com", "livecoinwatch.com",
  "coinlore.com", "messari.io", "cryptocompare.com",
];

function tokenize(q) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Distinct content terms of the question, each with its alias set
// (a ticker and its full name are interchangeable for matching).
function queryTerms(q) {
  const raw = tokenize(q);
  const seen = new Set();
  const terms = [];
  for (const w of raw) {
    if (STOPWORDS.has(w) || w.length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    const aliases = new Set([w]);
    if (TICKER_NAMES[w]) aliases.add(TICKER_NAMES[w]);
    if (NAME_TO_TICKER[w]) aliases.add(NAME_TO_TICKER[w]);
    terms.push({ word: w, aliases: [...aliases] });
  }
  return terms;
}

function isPriceQuery(q) {
  return /\b(price|cost|worth|value|trading|quote|how much)\b/i.test(q);
}

// For a price question naming a known ticker, search the unambiguous
// form ("ethereum price USD") instead of the conversational sentence.
function priceRewrite(q) {
  const words = tokenize(q);
  for (const w of words) {
    if (TICKER_NAMES[w]) return `${TICKER_NAMES[w]} price USD`;
    if (NAME_TO_TICKER[w]) return `${w} price USD`;
  }
  return null;
}

// Conversational "how do I change a tire?" phrasing makes some
// engines answer a different question entirely (Bing once returned
// dictionary entries for the word "do"). The "how to …" form is the
// same question in the shape engines handle reliably.
function howToRewrite(q) {
  const m = q.match(
    /^\s*how\s+(?:do|can|could|should)\s+(?:i|you|we|one)\s+(.+?)\s*\??\s*$/i,
  );
  return m ? `how to ${m[1]}` : null;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function scoreResult(r, terms, price) {
  const hay = `${r.title} ${r.snippet} ${hostnameOf(r.url)}`.toLowerCase();
  let matched = 0;
  for (const t of terms) {
    if (t.aliases.some((a) => hay.includes(a))) matched++;
  }
  let score = matched * 10;
  if (price) {
    const host = hostnameOf(r.url);
    if (PRICE_DOMAINS.some((d) => host === d || host.endsWith("." + d))) {
      score += 5;
    }
    if (/\$\s?[\d,]+(\.\d+)?/.test(r.snippet)) score += 2;
  }
  return { matched, score };
}

// Keep only results that actually talk about the question, best first.
// A result must match at least 2 distinct query terms — or all of them
// when the question has just one — or, for a price question, match at
// least 1 term while sitting on a known price source.
function filterRelevant(results, terms, price) {
  if (terms.length === 0) return [];
  const kept = [];
  const seenHosts = new Set();
  for (const r of results) {
    const { matched, score } = scoreResult(r, terms, price);
    const host = hostnameOf(r.url);
    const ok =
      matched >= 2 ||
      matched === terms.length ||
      (price && matched >= 1 && score >= 15);
    if (!ok) continue;
    const key = host + "|" + r.title.toLowerCase();
    if (seenHosts.has(key)) continue;
    seenHosts.add(key);
    kept.push({ r, score });
  }
  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, 5).map((k) => k.r);
}

/* ---------------- handler ---------------- */

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      });
    }
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
    if (q.length < 3) {
      return json({ query: q, results: [], error: "query too short" }, 400);
    }
    const terms = queryTerms(q);
    if (terms.length === 0) {
      // Nothing factual to ground (a greeting, small talk): no sources.
      return json({ query: q, source: "none", results: [] });
    }
    const price = isPriceQuery(q);
    const rewritten = price ? priceRewrite(q) : null;

    // Query forms, best first: the rewritten price query when we have
    // one, then the original question. For each form, BOTH engines are
    // fetched and their raw pools merged, then the merged pool is
    // relevance-filtered and ranked as one list — a single engine
    // having a bad minute (DDG's challenge page, Bing answering a
    // different question than the one asked) can no longer poison or
    // starve the answer on its own.
    const forms = [];
    if (rewritten && rewritten.toLowerCase() !== q.toLowerCase()) {
      forms.push(rewritten);
    }
    forms.push(q);
    const howTo = howToRewrite(q);
    if (howTo && howTo.toLowerCase() !== q.toLowerCase()) {
      forms.push(howTo);
    }

    for (const form of forms) {
      const pools = await Promise.all([
        searchDuckDuckGo(form).catch(() => []),
        searchBing(form).catch(() => []),
      ]);
      const relevant = filterRelevant(pools.flat(), terms, price);
      if (relevant.length > 0) {
        const source = relevant[0].engine || "duckduckgo";
        const results = relevant.map(({ title, url, snippet }) => ({
          title,
          url,
          snippet,
        }));
        return json({ query: q, source, results });
      }
    }
    // Fail open: no relevant results anywhere — the app answers
    // without live sources rather than hanging or inventing.
    return json({ query: q, source: "none", results: [] });
  },
};
