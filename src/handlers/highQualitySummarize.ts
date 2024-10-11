import { FastifyRequest, FastifyReply } from "fastify";
import { fileURLToPath } from "url";
import { LlamaParseReader } from "llamaindex";
import Anthropic from "@anthropic-ai/sdk";
import FirecrawlApp, { FirecrawlDocument } from "@mendable/firecrawl-js";
import "dotenv/config";
import fs from "fs-extra";
import path, { parse } from "path";
import os from "os";
import { ImageBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import mime from "mime";
import { synthesizeSpeech } from "@aws/polly";
import { OpenAI } from "openai";
import { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { pdfToPng } from "pdf-to-png-converter";
import { timeStamp } from "console";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
}

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

const modelConfig: {[task: string]: {temperature: number, model: Model}} = {
  extraction: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06"
  },
  summarization: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06"
  },
  authorInfoEditor: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06"
  },
  mathExplainer: {
    temperature: 0,
    model: "gpt-4o-2024-08-06"
  }
}

const MAX_POLLY_CHAR_LIMIT = 3000;

type PollyLongFormVoices = "Ruth" | "Gregory" | "Danielle"
type PollyGenerativeVoices = "Ruth" | "Matthew"

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

  const tempImageDir = path.join(tempDir, "images");
  const audioOutputDir = path.join(tempDir, "audio");
  const ttsTextDir = path.join(tempDir, "text");
  const tempObjectsDir = path.join(tempDir, "objects");
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const timestampedDir = path.join(tempObjectsDir, timestamp);

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

  if (!fs.existsSync(timestampedDir)) {
    fs.mkdirSync(timestampedDir, { recursive: true });
  }

  console.log("attempting to convert pdf pages to images");
  const pngPagesOriginal = await pdfToPng(fileBuffer, {
    viewportScale: 2.0,
    outputFolder: tempImageDir,
  });
  console.log("converted pdf pages to images");

  if (summarizationMethod === "ultimate") {
    /* Algorithm:
    - Convert the pdf pages to custom JSON (LLM)
    - Process the pages again to process images and tables to generate better summaries (LLM)
    - Try to place the image/figure entry above the text entry where it is mentioned for the first time. (code)
    - Remove redundant items. Replace math with disclaimer. (code)
      - Remove everything before the abstract heading that is not author_info or main_title
    - Process items again to make them audio optimized. (LLM)
    - Join the items. (code)
    */
    
    //convert to JSON
    const batchSize = 10;
    let allItems: any[] = [];
    let abstractDetected = false;
    let authorInfoContents = ""
    const pngPages = pngPagesOriginal

    for (let i = 0; i < pngPages.length; i += batchSize) {
      const batch = pngPages.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (pngPage, index) => {
          console.log("processing page ", i + index + 1);

          const EXTRACT_PROMPT = `Please extract all the items in the page in the correct order. 

          Include math expressions in plain text. Do not use LaTeX or any other special formatting for math. Instead using the english version, for example "\\geq" means "greater than or equal to". Include partial items cut off at the start or end of the page. Combine all rows of a table into a single table_rows item.
          
          Please use your best judgement to determine the abstract even if it is not explicitly labeled as such.`;

          const extractSchema = z.object({
            items: z.array(z.object({
              type: z.enum(["main_title", "text", "heading", "figure_image", "figure_caption_or_heading", "figure_note", "table_rows", "table_descrption_or_heading", "author_info",  "footnotes", "meta_or_publication_info",  "references_heading", "references_item", "math", "table_of_contents_heading", "table_of_contents_item", "abstract_heading", "abstract_content", "page_number", "code_or_algorithm"]),
              content: z.string()
            }))
          });

          const pagePath = pngPage.path;
          const pageItems = await getStructuredOpenAICompletion(
            EXTRACT_PROMPT,
            ``,
            modelConfig.extraction.model,
            modelConfig.extraction.temperature,
            extractSchema,
            [pagePath],
            16384,
            0.1
          );

          const items = pageItems?.items;

          console.log("processed page ", i + index + 1);

          for (const item of items) {
            item.content = item.content.replace(/https?:\/\/[^\s]+/g, 'See URL in paper.');

            if (item.type === "author_info" && i < 5) {
              authorInfoContents += `\n\n${item.content}`;
            }

            if (item.type === "figure_image" || item.type === "table_rows") {
              console.log("summarizing figure/table on page ", i + index + 1);
              const summarizationSchema = z.object({
                summarizedItem: z.object({
                  type: z.enum(["figure_image", "table_rows"]),
                  label: z.object({
                    labelType: z.string(),
                    labelNumber: z.string()
                  }),
                  content: z.string()
                })
              });

              const SUMMARIZE_PROMPT = `Write a detailed explanation for the figures and tables. For figures, replace the content field with a detailed explanation. For tables, replace the raw rows in the content field with a detailed explanation. Summarize the size of changes / effects / estimates / results in the tables or figures. To help understand them better, use context from the paper and any note below them.
              
              Add the label "Figure X" or "Table X" where X is the figure or table number indicated in the page. You need to extract the correct figure or table number. This is very important. Look for cues around the figure or table and use your best judgement to determine it. 
              
              Do not use markdown. Use plain text.`;

              const summarizedItem = await getStructuredOpenAICompletion(
                SUMMARIZE_PROMPT,
                `Item to summarize on this page:\n${JSON.stringify(item)}\n\nPage context:\n${JSON.stringify(items)}`,
                modelConfig.summarization.model,
                modelConfig.summarization.temperature,
                summarizationSchema,
                [pagePath]
              );

              item["label"] = summarizedItem?.summarizedItem.label;
              item.content = `${item.label.labelType} ${item.label.labelNumber} summary:\n${summarizedItem?.summarizedItem.content}`;
            } else if (item.type === "math") {
              console.log("summarizing math on page ", i + index + 1);
              const mathSummarizationSchema = z.object({
                summarizedMath: z.object({
                  content: z.string()
                })
              });

              const MATH_SUMMARIZE_PROMPT = `Explain the given math item using the page context in English. Explain what the math is, not what it is used for. Do not write more than two sentences. Do not include any math terms in the summary.`;

              const summarizedMath = await getStructuredOpenAICompletion(
                MATH_SUMMARIZE_PROMPT,
                `Math to summarize:\n${JSON.stringify(item)}\n\nPage context:\n${JSON.stringify(items)}`,
                modelConfig.mathExplainer.model,
                modelConfig.mathExplainer.temperature,
                mathSummarizationSchema,
                [],
                1024
              );

              item.content = `Math summary: ${summarizedMath?.summarizedMath.content}`;
            } else if (item.type === "code_or_algorithm") {
              console.log("summarizing code or algorithm on page ", i + index + 1);
              const codeSummarizationSchema = z.object({
                summarizedCode: z.object({
                  content: z.string()
                })
              });

              const CODE_SUMMARIZE_PROMPT = `Summarize the given code or algorithm. Explain what the code or algorithm does in simple terms including its input and output. Do not include any code syntax in the summary.`;

              const summarizedCode = await getStructuredOpenAICompletion(
                CODE_SUMMARIZE_PROMPT,
                `Code or algorithm to summarize:\n${JSON.stringify(item)}\n\nPage context:\n${JSON.stringify(items)}`,
                modelConfig.summarization.model,
                modelConfig.summarization.temperature,
                codeSummarizationSchema,
                [],
                1024
              );

              item.content = `Code or Algorithm summary: ${summarizedCode?.summarizedCode.content}`;
            }

            //Some manual latex processing
            item.content = item.content.replaceAll("\\", "").replaceAll("rightarrow", "approaches").replaceAll("infty","infinity").replaceAll("geq"," greater than or equal to ").replaceAll("leq", " less than or equal to ").replaceAll("mathbb","")

            if (item.type === "text") {
              item.content === item.content.replace(" - ", " minus ")
            }
          }

          return { index: i + index, items };
        })
      );

      // Sort batch results by index to maintain order
      batchResults.sort((a, b) => a.index - b.index);

      // Add sorted items to allItems
      for (const result of batchResults) {
        allItems.push(...result.items);
      }
    }

    console.log("Improving author section")
    const IMPROVE_AUTHOR_INFO_PROMPT  = `Rearrange all the author info to make it more readable. Keep only the author names and affiliations. Each author's name and affiliation should be on one line followed by the next author in the next line.
    
    Example:
    Author1, Affiliation1
    Author2, Affiliation2
    .....
    
    If the affiliation is not available leave it empty. Do not repeat the same author multiple times.`

    const improveAuthorInfoSchema = z.object({
      authorInfo: z.string()
    })

    const improvedAuthorInfo = await getStructuredOpenAICompletion(
      IMPROVE_AUTHOR_INFO_PROMPT,
      `Here is the author info: ${authorInfoContents}`,
      modelConfig.authorInfoEditor.model,
      modelConfig.authorInfoEditor.temperature,
      improveAuthorInfoSchema,
      pngPages.slice(0,5).map((page)=>page.path)
    )

    const firstAuthorInfoIndex = allItems.findIndex(item => item.type === "author_info")
    if (firstAuthorInfoIndex !== -1) {
      allItems[firstAuthorInfoIndex].type = "improved_author_info"
      allItems[firstAuthorInfoIndex].content = improvedAuthorInfo?.authorInfo;
    }

    const abstractExists = allItems.some(item => 
      item.type === "abstract_heading" || item.type === "abstract_content" || item.content.toLocaleLowerCase() === 'abstract'
    );

    console.log("filtering unnecessary item types")
    const filteredItems = abstractExists ? allItems.filter((item: {type: string, content:string}) => {
      if (!abstractDetected) {
        if (item.type === "abstract_heading" || item.content.toLocaleLowerCase() === 'abstract') {
          abstractDetected = true;
          item.type = "abstract_heading"
        } else if (item.type === "abstract_content") {
          abstractDetected = true;
        }
        return ["main_title", "improved_author_info", "abstract_heading", "abstract_content"].includes(item.type);
      } else {
        return ["text", "heading", "figure_image", "table_rows", "math", "abstract_content", "code_or_algorithm"].includes(item.type);
      }
    }) : allItems.filter((item: {type: string, content:string}) => ["main_title", "improved_author_info","text","heading","figure_image","table_rows","math","abstract_content","abstract_heading", "code_or_algorithm"].includes(item.type));


    const specialItems = filteredItems.filter((item) => (item.type === "figure_image" || item.type === "table_rows"))
    console.log("repositioning images and figures")
    for (const item of specialItems) {
      if (item.processed){
        continue;
      }

      const {labelType, labelNumber} = item.label;
      console.log("repositioning ", labelType, " ",labelNumber)
      let mentionIndex = -1;
      let headingIndex = -1;

      let matchWords = []
      if (labelType === "Figure") {
        matchWords.push(`Figure ${labelNumber}`, `Fig. ${labelNumber}`, `Fig ${labelNumber}`)
      } else if (labelType === "Table") {
        matchWords.push(`Table ${labelNumber}`, `Table. ${labelNumber}`)
      }

      for (let i = 0; i < filteredItems.length; i++) {
        if (i !== filteredItems.indexOf(item) && matchWords.some(word => filteredItems[i].content.includes(word))) {
          mentionIndex = i;
          console.log("found first mention in ", JSON.stringify(filteredItems[i]))
          break;
        }
      }

      const startIndex = mentionIndex !== -1 ? mentionIndex : filteredItems.indexOf(item);

      for (let i = startIndex + 1; i < filteredItems.length; i++) {
        if (filteredItems[i].type.includes("heading")) {
          headingIndex = i;
          console.log("found the first heading below mention in", JSON.stringify(filteredItems[i]))
          break;
        }
      }

      console.log("moving the item above the first heading or to the end")
      const [movedItem] = filteredItems.splice(filteredItems.indexOf(item), 1);
      if (headingIndex !== -1) {
        filteredItems.splice(headingIndex - 1, 0, movedItem);
      } else {
        filteredItems.push(movedItem);
      }

      item["processed"] = true
    }


    const parsedItemsPath = path.join(timestampedDir, "parsedItems.json");
    fs.writeFileSync(parsedItemsPath, JSON.stringify(allItems, null, 2));
    console.log("Saved raw text extract to", parsedItemsPath);

    const filteredItemsPath = path.join(timestampedDir, "filteredItems.json");
    fs.writeFileSync(filteredItemsPath, JSON.stringify(filteredItems, null, 2));
    console.log("Saved filtered items to", filteredItemsPath);

    // const ttsText = filteredItems.map(item => item.content).join('\n\n');
    // console.log("combined text for TTS");
    // const ttsTextFilePath = path.join(ttsTextDir, "tts-text.txt");
    // fs.writeFileSync(ttsTextFilePath, ttsText)
    // const ttsText = fs.readFileSync(ttsTextFilePath, "utf-8");

    try {
      throw new Error("Audio generation skipped");
      const audioBuffer = await synthesizeSpeechInChunks(filteredItems);
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
  if (text.length <= maxLength) {
    return [text];
  }
  
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

async function synthesizeSpeechInChunks(items: {type: string, content: string, label?: string}[]): Promise<Buffer> {
  const audioBuffers: Buffer[] = [];
  const MAX_CONCURRENT_ITEMS = 10;

  const processItem = async (item: {type: string, content: string, label?: string}) => {
    const voiceId = ["figure_image", "table_rows", "math", "code_or_algorithm"].includes(item.type) ? "Matthew" : "Ruth";
    const chunks = splitTextIntoChunks(item.content + "\n\n", MAX_POLLY_CHAR_LIMIT);
    const itemAudioBuffer: Buffer[] = []

    for (const chunk of chunks) {
      const audioBuffer = await synthesizeSpeech(chunk, voiceId);
      itemAudioBuffer.push(audioBuffer);
    }

    return Buffer.concat(itemAudioBuffer)
  };

  for (let i = 0; i < items.length; i += MAX_CONCURRENT_ITEMS) {
    const itemBatch = items.slice(i, i + MAX_CONCURRENT_ITEMS);
    console.log(`converting items ${i} through ${i + MAX_CONCURRENT_ITEMS} to audio`)
    const batchResults = await Promise.all(itemBatch.map(processItem));
    audioBuffers.push(...batchResults)
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
  schema: z.AnyZodObject,
  imagePaths: string[] = [],
  maxTokens: number = 16384,
  frequencyPenalty: number = 0
) {
  const imageUrls = imagePaths.map((imagePath) => {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    const base64Image = imageBuffer.toString("base64");
    return {
          type: "image_url",
          image_url: {
            url: `data:${mediaType};base64,${base64Image}`,
          },
        } as ChatCompletionContentPart
});

  const messages: ChatCompletionMessageParam[] = imagePaths.length > 0 ? [
    {
      role: "user",
      content: [
        { type: "text", text: userPrompt },
        ...imageUrls,
      ],
    },
  ] : [
    {
      role: "user",
      content: userPrompt,
    },
  ];

  const completion = await openai.beta.chat.completions.parse({
    model: model,
    temperature: temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...messages,
    ],
    response_format: zodResponseFormat(schema, "schema"),
    max_tokens: maxTokens,
    frequency_penalty: frequencyPenalty
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