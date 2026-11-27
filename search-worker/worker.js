// pb-ask-search — PoorBoyAI's own tiny web-search proxy for the Ask PB
// hackathon app. The app fetches live results here, feeds them to the
// model as context, and lists the real pages it checked under the
// answer. No vendor search API, no key: plain fetches of public search
// result pages, parsed in-house.
//
// GET /?q=<query>  ->  { query, results: [{ title, url, snippet }] }

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
  while ((m = re.exec(html)) !== null && results.length < 5) {
    const url = unwrapDdg(decodeEntities(m[1]));
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (url && title) results.push({ title, url, snippet });
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
  while ((m = re.exec(html)) !== null && results.length < 5) {
    const url = decodeEntities(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

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
    let results = [];
    let source = "duckduckgo";
    try {
      results = await searchDuckDuckGo(q);
    } catch {
      results = [];
    }
    if (results.length === 0) {
      source = "bing";
      try {
        results = await searchBing(q);
      } catch {
        results = [];
      }
    }
    return json({ query: q, source, results });
  },
};
