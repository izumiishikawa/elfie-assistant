// Tavily-backed web tools — self-contained (only depends on TAVILY_API_KEY), so both
// the text-chat agent (chats.controller.js) and the Inworld voice bridge
// (inworldRealtime.js) import the same functions instead of duplicating them.
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

export async function executeWebSearch(query) {
  if (!TAVILY_API_KEY) {
    console.warn("[web_search] TAVILY_API_KEY not set");
    return [];
  }
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: 5 }),
    });
    const data = await res.json();
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 300) ?? "",
    }));
  } catch (err) {
    console.error("[web_search] failed:", err);
    return [];
  }
}

export async function executeWebFetch(url) {
  if (!TAVILY_API_KEY) {
    console.warn("[web_fetch] TAVILY_API_KEY not set");
    return null;
  }
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        urls: url,
        format: "markdown",
      }),
    });
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) {
      const failure = data.failed_results?.[0];
      console.warn("[web_fetch] extraction failed:", failure?.error ?? "unknown error");
      return null;
    }
    return { url: result.url, content: result.raw_content ?? "" };
  } catch (err) {
    console.error("[web_fetch] failed:", err);
    return null;
  }
}

export async function executeProductSearch(query) {
  if (!TAVILY_API_KEY) {
    console.warn("[search_products] TAVILY_API_KEY not set");
    return [];
  }
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: 6,
        include_images: true,
        search_depth: "advanced",
      }),
    });
    const data = await res.json();
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 200) ?? "",
      image: r.images?.[0] ?? null,
    }));
  } catch (err) {
    console.error("[search_products] failed:", err);
    return [];
  }
}
