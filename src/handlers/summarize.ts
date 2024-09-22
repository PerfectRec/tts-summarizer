import { FastifyRequest, FastifyReply } from "fastify";
import { fileURLToPath } from "url";
import { LlamaParseReader } from "llamaindex";
import Anthropic from "@anthropic-ai/sdk";
import FirecrawlApp, { FirecrawlDocument } from "@mendable/firecrawl-js";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { ImageBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import mime from "mime";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
}

//Types for the LlamaParse JSON output
interface BoundingBox {
  x: number | null;
  y: number;
  w: number;
  h: number;
}

interface Item {
  type: string;
  value?: string;
  md: string;
  bBox: BoundingBox;
  lvl?: number;
  [key: string]: any; // Allow for additional properties
}

interface Page {
  page: number;
  items: Item[];
  [key: string]: any; // Allow for additional properties
}

export interface Image {
  name: string;
  height: number;
  width: number;
  x: number;
  y: number;
  original_width: number;
  original_height: number;
  path: string;
  job_id: string;
  original_pdf_path: string;
  page_number: number;
}

type Pages = Page[];

type Model = "claude-3-5-sonnet-20240620";

const ANTHROPIC_TEMPERATURE = 0;
const ANTHROPIC_MODEL = "claude-3-5-sonnet-20240620";

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
  apiUrl: "https://api.firecrawl.dev/v0/",
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "anthropic-beta":
      "prompt-caching-2024-07-31,max-tokens-3-5-sonnet-2024-07-15",
  },
});

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod } = request.query;
  const fileBuffer = request.body;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const projectRoot = path.resolve(__dirname, "../..");

  // Create a temporary file path
  const tempFilePath = path.join(projectRoot, "tempfile.pdf");

  // Write the buffer to the temporary file
  if (typeof fileBuffer === "string" || fileBuffer instanceof Buffer) {
    fs.writeFileSync(tempFilePath, fileBuffer);
  } else {
    throw new Error("Invalid file buffer type");
  }

  const tempImageDir = path.join(projectRoot, "images-temp");

  // Ensure the image directory exists
  if (!fs.existsSync(tempImageDir)) {
    fs.mkdirSync(tempImageDir);
  }

  // Instantiate LlamaParseReader
  const reader = new LlamaParseReader({
    resultType: "json",
  });

  // Load data from the temporary file
  const json = await reader.loadJson(tempFilePath);
  const pages: Pages = json[0].pages;
  const images = await reader.getImages(json, tempImageDir);
  const imagesMap: Map<string, Image> = new Map(
    images.map((image: Image) => [image.name, image])
  );

  console.log("Converted to JSON and images");

  let ttsText;
  if (summarizationMethod === "ultimate") {
    let tableCounter = 0;
    let imageCounter = 0;

    //page processing loop
    for (const page of pages) {
      let title;
      let webContext = "";

      if (page.page === 1) {
        title = await getAnthropicCompletion(
          "Extract the title of the work from the following markdown content. Only return the title in <title></title>",
          page.md,
          ANTHROPIC_MODEL,
          ANTHROPIC_TEMPERATURE,
          "title"
        );

        console.log("Detected title: ", title);

        //webContext = await getWebContext(title + " signficance");

        console.log("Grabbed search results");
      }

      //item loop
      for (const item of page.items) {
        //generate the better abstract using the previously collected web context and title
        if (
          item.type === "heading" &&
          item.value?.toLocaleLowerCase().includes("abstract")
        ) {
          console.log("attempting to generate better abstract");
          const betterAbstract = await getAnthropicCompletion(
            "Based on the original extract and web context about the given work, generate a better and more contextual abstract that does a better job of introducing the reader to the work. Make sure to note if the paper is significant and why. Return the output in <betterAbstract></betterAbstract>",
            `Original abstract:\n${item.md}\n\nWeb context about ${title}:\n${webContext}`,
            ANTHROPIC_MODEL,
            ANTHROPIC_TEMPERATURE,
            "betterAbstract"
          );

          item.betterMd = betterAbstract;
          console.log("generated better abstract");
        }

        //process tables
        if (item.type === "table") {
          tableCounter++;
          console.log("Attempting to summarize table ", tableCounter);
          const tableSummary = await getAnthropicCompletion(
            "Summarize the following table content. Provide a concise summary that captures the key points and insights from the table. Use the entire page as context. Return the output in <tableSummary></tableSummary>",
            `Table:\n${item.md}\n\nEntire Page:\n${page.md}`,
            ANTHROPIC_MODEL,
            ANTHROPIC_TEMPERATURE,
            "tableSummary"
          );

          item.summary = tableSummary;
          item.tableNumber = tableCounter;
          console.log("Summarized table ", tableCounter);
        }
      }

      //image loop
      for (const image of page.images) {
        imageCounter++;
        console.log("attempting to summarize image ", imageCounter);
        const savedImage = imagesMap.get(image.name);
        if (savedImage) {
          const imagePath = savedImage.path;
          console.log(imagePath);
          const imageSummary = await getAnthropicCompletion(
            "Summarize the content of the following image. Provide a concise summary that captures the key points and insights from the image. Return the output in <imageSummary></imageSummary>",
            `Title: ${title}\n\nPage context:\n${page.md}`,
            ANTHROPIC_MODEL,
            ANTHROPIC_TEMPERATURE,
            "imageSummary",
            imagePath
          );
          image.summary = imageSummary;
        }
        image.imageNumber = imageCounter;
        console.log("Summarized image ", imageCounter);
      }
    }

    //page combination loop
    let combinedText = "";
    console.log("attempting to combine text for TTS");
    for (const page of pages) {
      for (const item of page.items) {
        if (
          item.type === "heading" &&
          item.value?.toLocaleLowerCase().includes("abstract")
        ) {
          combinedText += item.betterMd + "\n\n" || item.md + "\n\n";
        } else if (item.type === "table") {
          combinedText += item.summary
            ? `Table ${item.tableNumber}: ${item.summary}\n\n`
            : item.md + "\n\n";
        } else {
          combinedText += item.md + "\n\n";
        }
      }

      for (const image of page.images) {
        combinedText += image.summary
          ? `Image ${image.imageNumber}: ${image.summary}\n\n`
          : "\n\n";
      }
    }
    ttsText = combinedText;
    console.log("combined text for TTS");
  } else {
    return { message: "This summarization method is not supported yet!" };
  }

  // Clean up the temporary file
  //await fs.remove(tempFilePath);

  return { message: "Generated audio file", ttsText: ttsText };
}

async function getAnthropicCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  const messages: MessageParam[] = [
    {
      role: "user",
      content: userPrompt,
    },
  ];

  if (imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    messages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            data: imageBuffer.toString("base64"),
            media_type: mediaType,
            type: "base64",
          },
        } as ImageBlockParam,
      ],
    });
  }

  const completion = await anthropic.messages.create({
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt }],
    model: model,
    temperature: temperature,
    messages: messages,
  });

  const completionText = (completion.content[0] as Anthropic.TextBlock).text;
  const regex = new RegExp(`<${xmlTag}>(.*?)</${xmlTag}>`);
  const match = completionText.match(regex);
  const parsedCompletion = match ? match[1] : completionText;

  return parsedCompletion;
}

async function getWebContext(
  link: string
): Promise<{ url: string; markdown: string }[]> {
  const result = await firecrawl.search(link);

  if (result.data) {
    const data: { url: string; markdown: string }[] = [];

    result.data
      .filter((item: { url?: string }) => item.url && !item.url.includes("youtube"))
      .slice(0, 5)
      .forEach((item: FirecrawlDocument) => {
        if (item.markdown) {
        const cleanedMarkdown = item.markdown
          .replace(/<br\s*\/?>/gi, "")
          .replace(/\[.*?\]\(.*?\)/g, "")
          .replace(/\s{2,}/g, " ")
          .replace(/\n{2,}/g, "\n");
          if (item.url) {
            data.push({ url: item.url, markdown: cleanedMarkdown });
          }
        }
      });
    return data;
  } else {
    throw new Error("Failed to scrape content");
  }
}
