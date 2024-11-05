import FirecrawlApp, { FirecrawlDocument } from "@mendable/firecrawl-js";
import "dotenv/config";

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
});

export async function getWebContext(link: string): Promise<string> {
  console.log("Searching the web for: ", link);
  const result = await firecrawl.search(link);

  //console.log(JSON.stringify(result, null, 2));

  if (result.data) {
    let combinedData = "";

    result.data
      .filter(
        (item: { url?: string }) => item.url && !item.url.includes("youtube")
      )
      .slice(0, 5)
      .forEach((item: FirecrawlDocument) => {
        if (item.markdown) {
          const cleanedMarkdown = item.markdown
            .replace(/<br\s*\/?>/gi, "")
            .replace(/\[.*?\]\(.*?\)/g, "")
            .replace(/\s{2,}/g, " ")
            .replace(/\n{2,}/g, "\n");
          if (item.url) {
            combinedData += `${item.url}\n${cleanedMarkdown}\n\n`;
          }
        }
      });
    return combinedData.trim();
  } else {
    throw new Error("Failed to scrape content");
  }
}
