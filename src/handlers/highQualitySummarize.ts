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
import { synthesizeSpeech } from "@aws/polly";
import { OpenAI } from "openai";
import { ChatCompletionMessageParam } from "openai/resources";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { pdfToPng } from "pdf-to-png-converter";

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

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

const EDITING_MODEL_TEMPERATURE = 0;
const EDITING_MODEL = "claude-3-5-sonnet-20240620";

const IMAGE_PROCESSING_MODEL_TEMPERATURE = 0;
const IMAGE_PROCESSING_MODEL = "claude-3-5-sonnet-20240620";

const MAX_POLLY_CHAR_LIMIT = 1500;

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
});

const anthropic = new Anthropic({
  baseURL: "https://anthropic.helicone.ai",
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15",
    "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
  },
});

const openai = new OpenAI({
  baseURL: "https://oai.helicone.ai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
  },
});

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod } = request.query;
  const fileBuffer = request.body as Buffer;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const projectRoot = path.resolve(__dirname, "../..");
  const tempDir = path.join(projectRoot, "temp");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const tempImageDir = path.join(tempDir, "images-temp");
  const audioOutputDir = path.join(tempDir, "audio-output");
  const ttsTextDir = path.join(tempDir, "tts-text");
  const tempObjectsDir = path.join(tempDir, "objects");

  clearDirectory(tempImageDir);

  if (!fs.existsSync(tempImageDir)) {
    fs.mkdirSync(tempImageDir);
  }

  if (!fs.existsSync(audioOutputDir)) {
    fs.mkdirSync(audioOutputDir);
  }

  if (!fs.existsSync(ttsTextDir)) {
    fs.mkdirSync(ttsTextDir);
  }

  if (!fs.existsSync(tempObjectsDir)) {
    fs.mkdirSync(tempObjectsDir);
  }

  console.log("attempting to convert pdf pages to images");
  const pngPages = await pdfToPng(fileBuffer, {
    viewportScale: 1.0,
    outputFolder: tempImageDir,
  });
  console.log("converted pdf pages to images");

  if (summarizationMethod === "ultimate") {
    let pageText: string[] = [];
    for (const [index, pngPage] of pngPages.entries()) {
      console.log("processing page ", index + 1);
      const pagePath = pngPage.path;
      const pageContent = await getCompletion(
        PAGE_IMAGE_PARSING_PROMPT,
        `Here is the page`,
        IMAGE_PROCESSING_MODEL,
        IMAGE_PROCESSING_MODEL_TEMPERATURE,
        "page",
        pagePath
      );
      pageText.push(pageContent);
      console.log("processed page ", index + 1);
    }

    console.log("attempting to combine text for TTS");
    const ttsText = pageText.join("\n");
    console.log("combined text for TTS");
    const ttsTextFilePath = path.join(ttsTextDir, "tts-text.txt");
    fs.writeFileSync(ttsTextFilePath, ttsText);

    try {
      throw new Error("Audio generation skipped");
      const audioBuffer = await synthesizeSpeechInChunks(ttsText);
      console.log("Generated audio file");

      const audioFilePath = path.join(audioOutputDir, "output.mp3");
      fs.writeFileSync(audioFilePath, audioBuffer);
      console.log("Saved audio file to", audioFilePath);

      // Send the audio file as a response
      return reply.type("audio/mpeg").send(audioBuffer);
    } catch (error) {
      console.error("Error generating audio file:", error);
      return reply.status(500).send({ message: "Error generating audio file" });
    }
  } else {
    return reply
      .status(400)
      .send({ message: "This summarization method is not supported yet!" });
  }
}

async function getWebContext(link: string): Promise<string> {
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

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function synthesizeSpeechInChunks(text: string): Promise<Buffer> {
  const chunks = splitTextIntoChunks(text, MAX_POLLY_CHAR_LIMIT);
  const audioBuffers: Buffer[] = [];

  for (const chunk of chunks) {
    const audioBuffer = await synthesizeSpeech(chunk);
    audioBuffers.push(audioBuffer);
  }

  return Buffer.concat(audioBuffers);
}

async function getAnthropicCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  let messages: MessageParam[];

  if (imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    messages = [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image",
            source: {
              data: imageBuffer.toString("base64"),
              media_type: mediaType,
              type: "base64",
            },
          } as ImageBlockParam,
        ],
      },
    ];
  } else {
    messages = [
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  const completion = await anthropic.messages.create({
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt }],
    model: model,
    temperature: temperature,
    messages: messages,
  });

  const completionText = (completion.content[0] as Anthropic.TextBlock).text;
  const regex = new RegExp(`<${xmlTag}>([\\s\\S]*?)</${xmlTag}>`);
  const match = completionText.match(regex);
  const parsedCompletion = match ? match[1] : completionText;

  return parsedCompletion;
}

async function getOpenAICompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  let messages: ChatCompletionMessageParam[];

  if (imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    const base64Image = imageBuffer.toString("base64");
    messages = [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${mediaType};base64,${base64Image}`,
            },
          },
        ],
      },
    ];
  } else {
    messages = [
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...messages,
    ],
    model: model,
    temperature: temperature,
  });

  const completionText = completion.choices[0].message.content!;
  const regex = new RegExp(`<${xmlTag}>([\\s\\S]*?)</${xmlTag}>`);
  const match = completionText.match(regex);
  const parsedCompletion = match ? match[1] : completionText;

  return parsedCompletion;
}

async function getCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  if (model.includes("gpt")) {
    return getOpenAICompletion(
      systemPrompt,
      userPrompt,
      model,
      temperature,
      xmlTag,
      imagePath
    );
  } else if (model.includes("claude")) {
    return getAnthropicCompletion(
      systemPrompt,
      userPrompt,
      model,
      temperature,
      xmlTag,
      imagePath
    );
  } else {
    throw new Error("Unsupported model type");
  }
}

async function getStructuredOpenAICompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  schema: z.AnyZodObject
) {
  const completion = await openai.beta.chat.completions.parse({
    model: model,
    temperature: temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    response_format: zodResponseFormat(schema, "schema"),
  });

  const response = completion.choices[0].message;

  if (response.refusal) {
    throw new Error(response.refusal);
  } else {
    return response.parsed;
  }
}

function clearDirectory(directoryPath: string) {
  if (fs.existsSync(directoryPath)) {
    fs.readdirSync(directoryPath).forEach((file) => {
      const filePath = path.join(directoryPath, file);
      if (fs.lstatSync(filePath).isDirectory()) {
        clearDirectory(filePath);
        fs.rmdirSync(filePath);
      } else {
        fs.unlinkSync(filePath);
      }
    });
  }
}

/*PROMPTS*/

const PAGE_IMAGE_PARSING_PROMPT = `Extract the text of this page one to one. I want the entire text. 

For images, figures and tables, instead of the raw content, write a summary in <image-x>, <table-x> or <figure-x> xml tags where x is the number given to the image, table or figure in the original doc. The summary should be detailed and describe what the image or table is trying to convey. Do not include the caption/note below or above the figure,image or table written by the author as it does not make sense along with the summary. 

For papers, before the abstract, only the title, authors' names and affiliations are important. Each author's name should be followed by their affiliation instead of grouping all the author names together.

Include cut off sentences or words at the edge. Do not include the page numbers.

Equations must be written in a way that is pleasant to hear. For example, implied multiplication must be written as "times". Make any other changes you think are necessary.

Put the entire output in <page> xml tags.`;
