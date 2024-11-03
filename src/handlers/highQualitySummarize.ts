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
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { pdfToPng, PngPageOutput } from "pdf-to-png-converter";
import { timeStamp } from "console";
import { uploadFile, uploadStatus } from "@aws/s3";
import { sendEmail } from "@email/transactional";
import { subscribeEmail } from "@email/marketing";
import { v4 as uuidv4 } from "uuid";
import { parseBuffer } from "music-metadata";
import { getDB } from "db/db";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
  email: string;
  fileName: string;
  sendEmailToUser: string;
  link: string;
}

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

const { db } = getDB();

const modelConfig: { [task: string]: { temperature: number; model: Model } } = {
  pageClassifier: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
  },
  extraction: {
    temperature: 0.3,
    model: "gpt-4o-2024-08-06",
  },
  summarization: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
  },
  authorInfoExtractor: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
  },
  mathOptimization: {
    temperature: 0.4,
    model: "gpt-4o-2024-08-06",
  },
  citation: {
    temperature: 0,
    model: "gpt-4o-2024-08-06",
  },
};

const MAX_POLLY_CHAR_LIMIT = 2900;

type PollyLongFormVoices = "Ruth" | "Gregory" | "Danielle";
type PollyGenerativeVoices = "Ruth" | "Matthew" | "Stephen";

type OpenAIVoice = "alloy" | "onyx" | "echo" | "fable" | "shimmer" | "nova";

interface Author {
  authorName: string;
  affiliation: string;
}

interface Item {
  type: string;
  content: string;
  label?: { labelType: string; labelNumber: string };
  summary?: string;
  optimizedMath?: boolean;
  replacedCitations?: Boolean;
  repositioned?: Boolean;
  page: number;
  mathSymbolFrequency?: number;
  hasCitations?: boolean;
  isStartCutoff?: boolean;
  isEndCutOff?: boolean;
}

interface ItemAudioMetadata {
  type: string;
  startTime: number;
  itemDuration: number;
  transcript: string;
  page: number;
  index: number;
}

interface ItemAudioResult {
  itemAudioBuffer: Buffer;
  itemAudioMetadata: ItemAudioMetadata;
}

interface AudioResult {
  audioBuffer: Buffer;
  audioMetadata: ItemAudioMetadata[];
}

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
  const { summarizationMethod, email, fileName, sendEmailToUser, link } =
    request.query;

  const shouldSendEmailToUser = sendEmailToUser === "true";

  let fileBuffer: Buffer;
  let cleanedFileName: string;

  const runId = uuidv4();

  /* Supported Status
  - Received
  - Processing
  - Completed
  - Error
  */

  uploadStatus(runId, "Received", {
    message: "Request received",
  });

  console.log(`Created runStatus/${runId}.json in S3`);

  if (link && link !== "") {
    try {
      const url = new URL(link);

      // Special processing for arXiv links
      if (url.hostname === "arxiv.org" && url.pathname.startsWith("/abs/")) {
        url.pathname = url.pathname.replace("/abs/", "/pdf/");
      }
      // Download the PDF from the link using fetch
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error("Failed to download PDF from link");
      }
      const arrayBuffer = await response.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuffer);
      const pathParts = url.pathname.split("/");
      cleanedFileName = pathParts[pathParts.length - 1];

      if (cleanedFileName.endsWith(".pdf")) {
        cleanedFileName = cleanedFileName.slice(0, -4);
      }
    } catch (error) {
      return reply
        .status(400)
        .send({ message: "Failed to download PDF from link" });
    }
  } else {
    fileBuffer = request.body as Buffer;
    cleanedFileName = path.parse(fileName).name;
  }

  // console.log(cleanedFileName);
  // return;

  if (fileBuffer.length > 100 * 1024 * 1024) {
    throw new Error("File size exceeds 100MB which is currently not supported");
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const projectRoot = path.resolve(__dirname, "../..");
  const tempDir = path.join(projectRoot, "temp");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const tempImageDir = path.join(
    tempDir,
    "images",
    `${cleanedFileName}-${runId}`
  );
  const tempObjectsDir = path.join(tempDir, "objects");
  const fileNameDir = path.join(tempObjectsDir, `${cleanedFileName}-${runId}`);

  clearDirectory(tempImageDir);

  if (!fs.existsSync(tempImageDir)) {
    fs.mkdirSync(tempImageDir, { recursive: true });
  }

  if (!fs.existsSync(tempObjectsDir)) {
    fs.mkdirSync(tempObjectsDir);
  }

  if (!fs.existsSync(fileNameDir)) {
    fs.mkdirSync(fileNameDir, { recursive: true });
  }

  console.log("attempting to convert pdf pages to images");
  const pngPagesOriginal = await pdfToPng(fileBuffer, {
    viewportScale: 3.0,
    outputFolder: tempImageDir,
  });

  if (pngPagesOriginal.length > 100) {
    throw new Error(
      "pdf has more than 100 pages which is not currently supported"
    );
  }

  //Setting file names
  //PDF
  const pdfFileName = `${cleanedFileName}.pdf`;
  const pdfFilePath = `${email}/${pdfFileName}`;
  const s3pdfFilePath = `https://${process.env.AWS_BUCKET_NAME}/${pdfFilePath}`;
  const pdfFileUrl = await uploadFile(fileBuffer, pdfFilePath);

  //MP3
  const audioFileName = `${cleanedFileName}.mp3`;
  const audioFilePath = `${email}/${audioFileName}`;
  const encodedAudioFilePath = `${encodeURIComponent(
    email
  )}/${encodeURIComponent(audioFileName)}`;
  const s3encodedAudioFilePath = `https://${process.env.AWS_BUCKET_NAME}/${encodedAudioFilePath}`;

  //METADATA
  const metadataFileName = `${cleanedFileName}-metadata.json`;
  const metadataFilePath = `${email}/${metadataFileName}`;
  const s3metadataFilePath = `https://${process.env.AWS_BUCKET_NAME}/${metadataFilePath}`;

  //ERROR
  const errorFilePath = `${email}/${cleanedFileName}-error.json`;
  const encodedErrorFilePath = `${encodeURIComponent(
    email
  )}/${encodeURIComponent(cleanedFileName)}-error.json`;
  const s3encodedErrorFilePath = `https://${process.env.AWS_BUCKET_NAME}/${encodedErrorFilePath}`;

  uploadStatus(runId, "Processing", {
    message: "Started processing",
    uploadedFileUrl: s3pdfFilePath,
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

    reply.status(200).send({
      fileName: cleanedFileName,
      runId: runId,
    });

    //convert to JSON
    try {
      const batchSize = 20;
      let allItems: Item[] = [];
      let abstractDetected = false;
      let authorInfoContents = "";
      let allBatchResults: { index: number; relevant: boolean }[] = [];

      console.log(`PASS 0: Determining which pages are relevant`);

      // for (let i = 0; i < pngPagesOriginal.length; i += batchSize) {
      //   const batch = pngPagesOriginal.slice(i, i + batchSize);

      //   const batchResults = await Promise.all(
      //     batch.map(async (pngPageOriginal, index) => {
      //       const pageIsUseful = await classifyPageContent(
      //         pngPageOriginal.path
      //       );
      //       console.log(`Page ${i + index + 1} is relevant: `, pageIsUseful);
      //       return { index: index + i, relevant: pageIsUseful };
      //     })
      //   );

      //   allBatchResults = allBatchResults.concat(batchResults);
      // }

      const pngPages = pngPagesOriginal.filter((_, index) => {
        const result = allBatchResults.find((result) => result.index === index);
        return result?.relevant ?? true;
      });

      console.log(
        `Filtered out ${
          pngPagesOriginal.length - pngPages.length
        } irrelevant pages`
      );

      //return;

      console.log(
        `PASS 1: Extracting text from the images\n\nPASS 1.5: Summarizing special items`
      );
      for (let i = 0; i < pngPages.length; i += batchSize) {
        const batch = pngPages.slice(i, i + batchSize);

        const batchResults = await Promise.all(
          batch.map(async (pngPage, index) => {
            console.log("processing page ", i + index + 1);

            const EXTRACT_PROMPT = `Please extract all the items in the page in the correct order. 

            Please include math expressions.
            
            Include partial items cut off at the start or end of the page. 
            
            Combine all rows of a table into a single table_rows item.
            
            Please use your best judgement to determine the abstract even if it is not explicitly labeled as such.
            
            Usually, text item starting with a superscript number is an endnote.
            
            Score each item on a scale of 0-5 based on how many complex math symbols appear in it.`;

            const extractSchema = z.object({
              items: z.array(
                z.object({
                  type: z.enum([
                    "main_title",
                    "text",
                    "heading",
                    "figure_image",
                    "figure_caption_or_heading",
                    "figure_note",
                    "non_figure_image",
                    "table_rows",
                    "table_descrption_or_heading",
                    "table_note",
                    "author_info",
                    "footnotes",
                    "meta_or_publication_info",
                    "references_heading",
                    "references_item",
                    "math",
                    "table_of_contents_heading",
                    "table_of_contents_item",
                    "abstract_heading",
                    "abstract_content",
                    "page_number",
                    "code_or_algorithm",
                    "endnotes_item",
                    "endnotes_heading",
                    "JEL_classification",
                    "keywords",
                  ]),
                  content: z.string(),
                  mathSymbolFrequency: z.number(),
                  hasCitations: z.boolean(),
                })
              ),
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
              0.2
            );

            let items = pageItems?.items;

            console.log("processed page ", i + index + 1);

            //combining contiguous math items
            let combinedItems: any[] = [];
            for (let i = 0; i < items.length; i++) {
              if (items[i].type === "math") {
                let combinedContent = items[i].content;
                while (i + 1 < items.length && items[i + 1].type === "math") {
                  combinedContent += " " + items[i + 1].content;
                  i++;
                }
                combinedItems.push({
                  type: "math",
                  content: combinedContent,
                  mathSymbolFrequency: 5,
                });
              } else {
                combinedItems.push(items[i]);
              }
            }
            items = combinedItems;

            items.forEach((item: any) => {
              item.page = i + index + 1; // Set the page number
            });

            //console.log(JSON.stringify(items, null, 2));

            for (const item of items) {
              item.content = item.content.replace(
                /https?:\/\/[^\s]+/g,
                "See URL in paper."
              );

              if (item.type === "author_info" && i < 5) {
                authorInfoContents += `\n\n${item.content}`;
              }

              if (item.type.includes("heading")) {
                item.content = `[break0.7]${item.content}[break0.7]`;
              }

              if (item.type === "figure_image" || item.type === "table_rows") {
                console.log("summarizing figure/table on page ", i + index + 1);
                const summarizationSchema = z.object({
                  summarizedItem: z.object({
                    type: z.enum(["figure_image", "table_rows"]),
                    label: z.object({
                      labelType: z.string(),
                      labelNumber: z.string(),
                      panelNumber: z.string().optional(),
                    }),
                    content: z.string(),
                  }),
                });

                const FIGURE_SUMMARIZE_PROMPT = `Write a detailed explanation for the figures. Replace the content field with a detailed explanation. Summarize the size of changes / effects / estimates / results in the figures. To help understand them better, use context from the paper and any note below them.
                
                Add the label "Figure X" where X is the figure number indicated in the page. You need to extract the correct label type and label number. This is very important. Look for cues around the figure and use your best judgement to determine it. Possible label types can be Figure, Chart, Image etc.
                
                If there is no label or label number set the labelType as "Image" and labelNumber as "unlabeled".
                
                Do not use markdown. Use plain text.`;

                const TABLE_SUMMARIZE_PROMPT = `Write a concise and effective summary for the table. Replace the raw rows in the content field with the summary. Summarize the size of changes / effects / estimates / results in the tables. To help understand them better, use context from the paper and any note below them. The summary should capture the main point of the table. Try to use as few numbers as possible. Keep in mind that the user cannot see the table as they will be listening to your summary. 
                
                Add the label "Table X" where X is the table number indicated in the page. You need to extract the correct table number. This is very important. Look for cues around the table and use your best judgement to determine it. Add the panel number that is being summarized, if it is mentioned.
                
                Do not use markdown. Use plain text.`;

                const summarizePrompt =
                  item.type === "figure_image"
                    ? FIGURE_SUMMARIZE_PROMPT
                    : TABLE_SUMMARIZE_PROMPT;

                const summarizedItem = await getStructuredOpenAICompletion(
                  summarizePrompt,
                  `Item to summarize on this page:\n${JSON.stringify(
                    item
                  )}\n\nPage context:\n${JSON.stringify(items)}`,
                  modelConfig.summarization.model,
                  modelConfig.summarization.temperature,
                  summarizationSchema,
                  [pagePath]
                );

                item["label"] = summarizedItem?.summarizedItem.label;
                item.content = `${item.label.labelType} ${
                  item.label.labelNumber === "unlabeled"
                    ? ""
                    : item.label.labelNumber
                } ${
                  item.label.panelNumber &&
                  item.label.panelNumber !== "unlabeled"
                    ? `Panel ${item.label.panelNumber}`
                    : ""
                } summary:\n${summarizedItem?.summarizedItem.content}`;
              } else if (item.type === "code_or_algorithm") {
                console.log(
                  "summarizing code or algorithm on page ",
                  i + index + 1
                );
                const codeSummarizationSchema = z.object({
                  summarizedCode: z.object({
                    content: z.string(),
                    title: z.string(),
                  }),
                });

                const CODE_SUMMARIZE_PROMPT = `Summarize the given code or algorithm. Explain what the code or algorithm does in simple terms including its input and output. Do not include any code syntax in the summary.
                
                Also extract the title of the algorithm or code block. If no title is mentioned, then generate an appropriate one yourself.`;

                const summarizedCode = await getStructuredOpenAICompletion(
                  CODE_SUMMARIZE_PROMPT,
                  `Code or algorithm to summarize:\n${JSON.stringify(
                    item
                  )}\n\nPage context:\n${JSON.stringify(items)}`,
                  modelConfig.summarization.model,
                  modelConfig.summarization.temperature,
                  codeSummarizationSchema,
                  [],
                  1024
                );

                item.content = `Code or Algorithm, title: ${summarizedCode?.summarizedCode.title}, summary: ${summarizedCode?.summarizedCode.content}`;
              }

              //Some manual latex processing
              // item.content = item.content
              //   .replace(/\\geq/g, " greater than or equal to ")
              //   .replace(/\\leq/g, " less than or equal to ")
              //   .replace(/\\rightarrow/g, " approaches ")
              //   .replace(/\\infty/g, " infinity ")
              //   .replace(/\\mathbb/g, "")
              //   .replaceAll("\\(", "")
              //   .replaceAll("\\)", "")
              //   .replaceAll("\\", "");

              if (item.type === "text") {
                const { isStartCutoff, isEndCutoff } = isTextCutoff(
                  item.content
                );
                item.isStartCutoff = isStartCutoff;
                item.isEndCutoff = isEndCutoff;
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

      console.log("Improving author section");
      const IMPROVE_AUTHOR_INFO_PROMPT = `Extract all the author info to make. Keep only the author names and affiliations.
      
      If the affiliation is not available for a user leave it empty. Do not repeat the same author or affiliation multiple times.`;

      const authorExtractSchema = z.object({
        authors: z.array(
          z.object({
            authorName: z.string(),
            affiliation: z.string(),
          })
        ),
      });

      const improvedAuthorInfo = await getStructuredOpenAICompletion(
        IMPROVE_AUTHOR_INFO_PROMPT,
        `Here is the author info: ${authorInfoContents}`,
        modelConfig.authorInfoExtractor.model,
        modelConfig.authorInfoExtractor.temperature,
        authorExtractSchema,
        pngPages.slice(0, 5).map((page) => page.path)
      );

      const firstAuthorInfoIndex = allItems.findIndex(
        (item) => item.type === "author_info"
      );

      if (firstAuthorInfoIndex !== -1) {
        const authors = improvedAuthorInfo?.authors || [];
        const totalAuthors = authors.length;
        const maxAuthors = 5;
        const authorGroups: { [affiliation: string]: string[] } = {};

        // Group authors by affiliation
        authors
          .slice(0, maxAuthors)
          .forEach(({ authorName, affiliation }: Author) => {
            if (!authorGroups[affiliation]) {
              authorGroups[affiliation] = [];
            }
            authorGroups[affiliation].push(authorName);
          });

        // Compile the author info into the desired format
        let compiledAuthorInfo = Object.entries(authorGroups)
          .map(([affiliation, authorNames]) => {
            return `[break0.6]${authorNames.join(", ")} from ${affiliation}`;
          })
          .join(", ");

        // Add the total number of authors if more than 5
        if (totalAuthors > maxAuthors) {
          compiledAuthorInfo = `There are ${totalAuthors} authors, including ${compiledAuthorInfo}`;
        }

        allItems[firstAuthorInfoIndex].type = "improved_author_info";
        allItems[firstAuthorInfoIndex].content = compiledAuthorInfo;
      }

      const abstractExists = allItems.some(
        (item) =>
          item.type === "abstract_heading" ||
          item.type === "abstract_content" ||
          item.content.toLocaleLowerCase() === "abstract"
      );

      // for (const item of allItems) {
      //   if (item.type === "math") {
      //     const rephrasedMathMessage =
      //       "Rephrased math will use this voice.[break1]";
      //     item.content = `${rephrasedMathMessage}${item.content}`;
      //     break;
      //   }
      // }

      console.log("filtering unnecessary item types");
      const filteredItems = abstractExists
        ? allItems.filter((item: Item, index: number, array: any[]) => {
            if (!abstractDetected) {
              if (
                item.type === "abstract_heading" ||
                item.content.toLocaleLowerCase() === "abstract"
              ) {
                abstractDetected = true;
                item.type = "abstract_heading";
              } else if (item.type === "abstract_content") {
                abstractDetected = true;
              }
              return [
                "main_title",
                "improved_author_info",
                "abstract_heading",
                "abstract_content",
              ].includes(item.type);
            } else {
              // Check for math items between endnotes
              if (
                item.type === "math" &&
                index > 0 &&
                index < array.length - 1
              ) {
                const prevItem = array[index - 1];
                const nextItem = array[index + 1];
                if (
                  prevItem.type === "endnotes_item" &&
                  nextItem.type === "endnotes_item"
                ) {
                  return false; // Remove this math item
                }
              }
              return [
                "text",
                "heading",
                "figure_image",
                "table_rows",
                "math",
                "abstract_content",
                "code_or_algorithm",
              ].includes(item.type);
            }
          })
        : allItems.filter((item: Item, index: number, array: any[]) => {
            // Check for math items between endnotes
            if (item.type === "math" && index > 0 && index < array.length - 1) {
              const prevItem = array[index - 1];
              const nextItem = array[index + 1];
              if (
                prevItem.type === "endnotes_item" &&
                nextItem.type === "endnotes_item"
              ) {
                return false; // Remove this math item
              }
            }
            return [
              "main_title",
              "improved_author_info",
              "text",
              "heading",
              "figure_image",
              "table_rows",
              "math",
              "abstract_content",
              "abstract_heading",
              "code_or_algorithm",
            ].includes(item.type);
          });

      const specialItems = filteredItems.filter(
        (item) => item.type === "figure_image" || item.type === "table_rows"
      );
      console.log("repositioning images and figures");
      for (const item of specialItems) {
        if (item.repositioned || !item.label) {
          continue;
        }

        const { labelType, labelNumber } = item.label;
        console.log("repositioning ", labelType, " ", labelNumber);
        let mentionIndex = -1;
        let headingIndex = -1;

        if (labelNumber !== "unlabeled") {
          console.log("searching for matches for", labelType, labelNumber);
          let matchWords = [];
          if (labelType.toLocaleLowerCase() === "figure") {
            matchWords.push(
              `Figure ${labelNumber}`,
              `Fig. ${labelNumber}`,
              `Fig ${labelNumber}`,
              `FIGURE ${labelNumber}`,
              `FIG ${labelNumber}`,
              `FIG. ${labelNumber}`
            );
          } else if (labelType.toLocaleLowerCase() === "chart") {
            matchWords.push(
              `Chart ${labelNumber}`,
              `chart ${labelNumber}`,
              `CHART ${labelNumber}`
            );
          } else if (labelType === "Image") {
            matchWords.push(
              `Image ${labelNumber}`,
              `image ${labelNumber}`,
              `Img ${labelNumber}`,
              `Img. ${labelNumber}`,
              `IMAGE ${labelNumber}`,
              `IMG ${labelNumber}`,
              `IMG. ${labelNumber}`
            );
          } else if (labelType === "Table") {
            matchWords.push(`Table ${labelNumber}`, `Table. ${labelNumber}`);
          }

          for (let i = 0; i < filteredItems.length; i++) {
            if (
              i !== filteredItems.indexOf(item) &&
              matchWords.some((word) => filteredItems[i].content.includes(word))
            ) {
              mentionIndex = i;
              console.log(
                "found first mention in ",
                JSON.stringify(filteredItems[i])
              );
              break;
            }
          }
        }

        const startIndex =
          mentionIndex !== -1 ? mentionIndex : filteredItems.indexOf(item);

        for (let i = startIndex + 1; i < filteredItems.length; i++) {
          if (filteredItems[i].type.includes("heading")) {
            headingIndex = i;
            console.log(
              "found the first heading below mention in",
              JSON.stringify(filteredItems[i])
            );
            break;
          }
        }

        console.log("moving the item above the first heading or to the end");
        const currentIndex = filteredItems.indexOf(item);
        const insertIndex =
          headingIndex !== -1 && headingIndex > currentIndex
            ? headingIndex - 1
            : headingIndex;

        const [movedItem] = filteredItems.splice(currentIndex, 1);

        if (insertIndex !== -1) {
          filteredItems.splice(insertIndex, 0, movedItem);
        } else {
          filteredItems.push(movedItem);
        }

        item.repositioned = true;
      }

      const parsedItemsPath = path.join(fileNameDir, "parsedItems.json");
      fs.writeFileSync(parsedItemsPath, JSON.stringify(allItems, null, 2));
      console.log("Saved raw text extract to", parsedItemsPath);

      console.log("PASS 2: processing citations");

      const itemsWithCitations = filteredItems.filter(
        (item) => item.hasCitations
      );

      if (itemsWithCitations.length > 0) {
        const CITATION_REPLACEMENT_PROMPT = `Remove citations from the user text. 
        
        If the citation is part of a phrase like "such as <citations>" then remove the phrase.
        
        Please return the provided text as it is with only citations removed.`;

        const referenceSchema = z.object({
          textWithCitationsRemoved: z.string(),
        });

        // const referencesContent = referencesItems
        //   .map((refItem) => refItem.content)
        //   .join("\n");

        const MAX_CONCURRENT_ITEMS = 20;

        for (
          let i = 0;
          i < itemsWithCitations.length;
          i += MAX_CONCURRENT_ITEMS
        ) {
          const itemBatch = itemsWithCitations.slice(
            i,
            i + MAX_CONCURRENT_ITEMS
          );
          console.log(
            `processing text items ${i} through ${i + MAX_CONCURRENT_ITEMS}`
          );

          await Promise.all(
            itemBatch.map(async (item) => {
              if (item.type === "text") {
                const processedItem = await getStructuredOpenAICompletion(
                  CITATION_REPLACEMENT_PROMPT,
                  `User text:\n${item.content}`,
                  modelConfig.citation.model,
                  modelConfig.citation.temperature,
                  referenceSchema,
                  [],
                  16384,
                  0.2
                );

                item.content = processedItem?.textWithCitationsRemoved;
                item.replacedCitations = true;
              }
            })
          );
        }
      }

      //It is important to replace citations first and then optimize the math - but only in content with math.
      console.log("PASS 3: optimizing math for audio");
      const itemsThatCanIncludeMath = filteredItems.filter(
        (item) =>
          ["figure_image", "table_rows", "code_or_algorithm"].includes(
            item.type
          ) ||
          (item.mathSymbolFrequency && item.mathSymbolFrequency > 1)
      );

      if (itemsThatCanIncludeMath.length > 0) {
        const MATH_OPTIMIZATION_PROMPT = `The following text will be converted to audio for the user to listen to. Replace math notation and all LaTeX formatting with plain english words to make it more suitable for that purpose. Convert accurately. 
        
        Some examples includes changing "+" to "plus" and inserting a "times" when multiplication is implied. Use your best judgment to make the text as pleasant for audio as possible.
        
        Only convert math notation, do not alter the rest of the text.`;

        const mathOptimizationSchema = z.object({
          optimizedContent: z.string(),
        });

        const MAX_CONCURRENT_ITEMS = 20;

        for (
          let i = 0;
          i < itemsThatCanIncludeMath.length;
          i += MAX_CONCURRENT_ITEMS
        ) {
          const itemBatch = itemsThatCanIncludeMath.slice(
            i,
            i + MAX_CONCURRENT_ITEMS
          );
          console.log(
            `processing math items ${i} through ${i + MAX_CONCURRENT_ITEMS}`
          );

          await Promise.all(
            itemBatch.map(async (item) => {
              if (item.type === "math" || item.type === "text") {
                const processedItem = await getStructuredOpenAICompletion(
                  MATH_OPTIMIZATION_PROMPT,
                  `Text to optimize:\n${item.content}`,
                  modelConfig.mathOptimization.model,
                  modelConfig.mathOptimization.temperature,
                  mathOptimizationSchema,
                  [],
                  16384,
                  0.2
                );

                item.content = processedItem?.optimizedContent;
                item.optimizedMath = true;
              }
            })
          );
        }
      }

      const filteredItemsPath = path.join(fileNameDir, "filteredItems.json");
      fs.writeFileSync(
        filteredItemsPath,
        JSON.stringify(filteredItems, null, 2)
      );
      console.log("Saved filtered items to", filteredItemsPath);

      //return;

      const parsedItemsFileName = `${cleanedFileName}-parsedItems.json`;
      const filteredItemsFileName = `${cleanedFileName}-filteredItems.json`;
      const parsedItemsFilePath = `${email}/${parsedItemsFileName}`;
      const filteredItemsFilePath = `${email}/${filteredItemsFileName}`;

      const parsedItemsFileUrl = await uploadFile(
        fs.readFileSync(parsedItemsPath),
        parsedItemsFilePath
      );

      const filteredItemsFileUrl = await uploadFile(
        fs.readFileSync(filteredItemsPath),
        filteredItemsFilePath
      );

      await subscribeEmail(email, process.env.MAILCHIMP_AUDIENCE_ID || "");
      console.log("Subscribed user to mailing list");

      const { audioBuffer, audioMetadata } = await synthesizeSpeechInChunks(
        filteredItems
      );
      console.log("Generated audio file");

      const audioFileUrl = await uploadFile(audioBuffer, audioFilePath);
      const metadataFileUrl = await uploadFile(
        Buffer.from(JSON.stringify(audioMetadata)),
        metadataFilePath
      );

      let extractedTitle = "Title does not exist in processed doc";
      // Extract the title from the main_title item
      const mainTitleItem = filteredItems.find(
        (item) => item.type === "main_title"
      );
      if (mainTitleItem) {
        extractedTitle = mainTitleItem.content;
      }

      uploadStatus(runId, "Completed", {
        message: "Generated audio output and metadata",
        uploadedFileUrl: s3pdfFilePath,
        audioFileUrl: s3encodedAudioFilePath,
        metadataFileUrl: s3metadataFilePath,
        extractedTitle,
      });

      if (shouldSendEmailToUser) {
        const emailSubject = `Your audio paper ${cleanedFileName} is ready!`;
        const emailBody = `Download link:\n${s3encodedAudioFilePath}\n\nReply to this email to share feedback. We want your feedback. We will actually read it, work on addressing it, and if indicated by your reply, respond to your email.\n\nPlease share https://www.paper2audio.com with friends. We are looking for more feedback!\n\nKeep listening,\nJoe Golden`;

        await sendEmail(
          email,
          "",
          "joe@paper2audio.com",
          "paper2audio",
          emailSubject,
          emailBody
        );
        console.log("Email sent successfully to:", email);
      }
    } catch (error) {
      const errorFileUrl = await uploadFile(
        Buffer.from(JSON.stringify(error, Object.getOwnPropertyNames(error))),
        errorFilePath
      );

      uploadStatus(runId, "Error", {
        message: `Error: ${error}`,
        errorFileUrl: s3encodedErrorFilePath,
        uploadedFileUrl: s3pdfFilePath,
      });

      if (shouldSendEmailToUser) {
        const emailSubject = `Failed to generate audio paper ${cleanedFileName} for ${email}`;
        const emailBody = `Failed to generate audio paper for ${cleanedFileName}.pdf uploaded by ${email}. See error logs at ${s3encodedErrorFilePath} and send an updated email to the user.`;

        const userEmailBody = `Failed to generate audio paper for ${cleanedFileName}. We will take a look at the error and send you a follow up email with the audio file.`;

        await sendEmail(
          "joe@paper2audio.com",
          "",
          "joe@paper2audio.com",
          "paper2audio",
          emailSubject,
          emailBody
        );
        await sendEmail(
          "chandradeep@paper2audio.com",
          "",
          "joe@paper2audio.com",
          "paper2audio",
          emailSubject,
          emailBody
        );
        await sendEmail(
          email,
          "",
          "joe@paper2audio.com",
          "paper2audio",
          emailSubject,
          userEmailBody
        );
      }

      console.error("Error generating audio file:", error);
    }
  } else {
    reply
      .status(400)
      .send({ message: "This summarization method is not supported yet!" });
  }

  //cleanup temp subdirectories
  try {
    await fs.remove(tempImageDir);
    await fs.remove(fileNameDir);
    console.log("Temporary directories deleted");
  } catch (cleanupError) {
    console.error("Error during cleanup:", cleanupError);
  }

  return;
}

const classifyPageContent = async (pagePath: string): Promise<boolean> => {
  // Define criteria for useful content
  const USEFUL_CONTENT_PROMPT = `Determine if the following page is relevant and contains on topic information. If it contains meta information about journal or publisher or some other meta information, return false. For example if it a research paper anything that is not the main content of the paper is irrelevant. Accurately judge what is and what is not relevant`;

  const classificationSchema = z.object({
    isRelevant: z.boolean(),
  });

  try {
    const classificationResult = await getStructuredOpenAICompletion(
      USEFUL_CONTENT_PROMPT,
      ``,
      modelConfig.pageClassifier.model,
      modelConfig.pageClassifier.temperature,
      classificationSchema,
      [pagePath],
      64,
      0.7
    );

    return classificationResult?.isRelevant ?? true;
  } catch (error) {
    console.error("Error during classification", error);
    return true;
  }
};

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

async function synthesizeSpeechInChunks(items: Item[]): Promise<AudioResult> {
  const itemAudioResults: ItemAudioResult[] = [];
  const MAX_CONCURRENT_ITEMS = 10;

  const processItem = async (item: Item) => {
    const chunkAudioBuffers: Buffer[] = [];

    if (
      //Use Matthew for other generated content.
      ["code_or_algorithm", "figure_image", "table_rows"].includes(item.type)
    ) {
      const chunks = splitTextIntoChunks(item.content, MAX_POLLY_CHAR_LIMIT);
      for (const chunk of chunks) {
        const ssmlChunk = `<speak>${convertBreaks(
          escapeSSMLCharacters(chunk)
        )}</speak>`;
        const audioBuffer = await synthesizeSpeech(ssmlChunk, "Matthew", true);
        chunkAudioBuffers.push(audioBuffer);
      }
    } else {
      // Use "Ruth" for narrated content
      const chunks = splitTextIntoChunks(item.content, MAX_POLLY_CHAR_LIMIT);
      for (const chunk of chunks) {
        const ssmlChunk = `<speak>${convertBreaks(
          escapeSSMLCharacters(chunk)
        )}</speak>`;
        const audioBuffer = await synthesizeSpeech(ssmlChunk, "Ruth", true);
        chunkAudioBuffers.push(audioBuffer);
      }
    }

    const itemAudioBuffer = Buffer.concat(chunkAudioBuffers);

    const itemMetadata = await parseBuffer(itemAudioBuffer);

    const itemAudioMetadata: ItemAudioMetadata = {
      type: item.type,
      startTime: 0,
      itemDuration: itemMetadata.format.duration || 0,
      transcript: removeBreaks(item.content),
      page: item.page,
      index: 0,
    };

    return { itemAudioBuffer, itemAudioMetadata };
  };

  for (let i = 0; i < items.length; i += MAX_CONCURRENT_ITEMS) {
    const itemBatch = items.slice(i, i + MAX_CONCURRENT_ITEMS);
    console.log(
      `converting items ${i} through ${i + MAX_CONCURRENT_ITEMS} to audio`
    );
    const batchResults = await Promise.all(itemBatch.map(processItem));
    itemAudioResults.push(...batchResults);
  }

  const audioBuffer = Buffer.concat(
    itemAudioResults.map((itemAudioResult) => itemAudioResult.itemAudioBuffer)
  );

  const audioMetadata = itemAudioResults.map(
    (itemAudioResult) => itemAudioResult.itemAudioMetadata
  );

  //We need to adjust the start times here
  let startTime = 0;
  let index = 0;
  for (const itemMetadata of audioMetadata) {
    itemMetadata.startTime = startTime;
    itemMetadata.index = index;
    index += 1;
    startTime += itemMetadata.itemDuration;
  }

  return { audioBuffer: audioBuffer, audioMetadata: audioMetadata };
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
    } as ChatCompletionContentPart;
  });

  const messages: ChatCompletionMessageParam[] =
    imagePaths.length > 0
      ? [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }, ...imageUrls],
          },
        ]
      : [
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
    frequency_penalty: frequencyPenalty,
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

function escapeSSMLCharacters(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function convertBreaks(text: string): string {
  // Adjust the regex to match decimal numbers
  return text.replace(/\[break(\d+(\.\d+)?)\]/g, '<break time="$1s"/>');
}

function removeBreaks(text: string): string {
  // Adjust the regex to match decimal numbers
  return text.replace(/\[break\d+(\.\d+)?\]/g, "");
}

async function synthesizeOpenAISpeech(
  text: string,
  voice: OpenAIVoice
): Promise<Buffer> {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1-hd",
    voice: voice,
    input: text,
  });
  return Buffer.from(await mp3.arrayBuffer());
}

async function synthesizeSpeechInChunksOpenAI(items: Item[]): Promise<Buffer> {
  const audioBuffers: Buffer[] = [];
  const MAX_CONCURRENT_ITEMS = 20;

  const processItem = async (item: Item) => {
    let audioBuffer: Buffer;

    if (
      ["figure_image", "table_rows", "code_or_algorithm"].includes(item.type)
    ) {
      audioBuffer = await synthesizeOpenAISpeech(
        convertBreaks(item.content),
        "onyx"
      );
    } else {
      audioBuffer = await synthesizeOpenAISpeech(
        convertBreaks(item.content),
        "alloy"
      );
    }

    return audioBuffer;
  };

  for (let i = 0; i < items.length; i += MAX_CONCURRENT_ITEMS) {
    const itemBatch = items.slice(i, i + MAX_CONCURRENT_ITEMS);
    console.log(
      `converting items ${i} through ${i + MAX_CONCURRENT_ITEMS} to audio`
    );
    const batchResults = await Promise.all(itemBatch.map(processItem));
    audioBuffers.push(...batchResults);
  }

  return Buffer.concat(audioBuffers);
}

function isTextCutoff(text: string): {
  isStartCutoff: boolean;
  isEndCutoff: boolean;
} {
  // Check if the first sentence starts with a properly capitalized word
  const isStartCutoff = !/^[A-Z]/.test(text.trim());

  // Check if the last sentence ends with a proper terminating punctuation
  const isEndCutoff = !/(?<!\.)[.!?)\]]$/.test(text.trim());

  return { isStartCutoff, isEndCutoff };
}
