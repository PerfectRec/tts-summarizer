import { FastifyRequest, FastifyReply } from "fastify";
import { fileURLToPath } from "url";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { z } from "zod";
import { pdfToPng, PngPageOutput } from "pdf-to-png-converter";
import { uploadFile, uploadStatus } from "@aws/s3";
import { subscribeEmail } from "@email/marketing";
import { v4 as uuidv4 } from "uuid";
import { getDB } from "db/db";
import { sendErrorEmail, sendSuccessEmail } from "@utils/email";
import { clearDirectory, getCurrentTimestamp } from "@utils/io";
import { synthesizeSpeechInChunks } from "@utils/polly";
import {
  getStructuredOpenAICompletionWithRetries,
  synthesizeSpeechInChunksOpenAI,
} from "@utils/openai";
import { isTextCutoff, replaceAbbreviations } from "@utils/text";
import { removeBreaks } from "@utils/ssml";

const { db } = getDB();

const modelConfig: ModelConfig = {
  pageClassifier: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  extraction: {
    temperature: 0.5,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  figureSummarization: {
    temperature: 0.4,
    model: "gpt-4o-2024-08-06",
    concurrency: 0,
  },
  tableSummarization: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
    concurrency: 0,
  },
  codeSummarization: {
    temperature: 0.3,
    model: "gpt-4o-2024-08-06",
    concurrency: 0,
  },
  authorInfoExtractor: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
    concurrency: 0,
  },
  mainTitleExtractor: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
    concurrency: 0,
  },
  mathSymbolFrequencyAssignment: {
    temperature: 0.1,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  mathOptimization: {
    temperature: 0.3,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  citationDetection: {
    temperature: 0.1,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  abbreviationExtraction: {
    temperature: 0.4,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  citationOptimization: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
  audioPleasantnessCheck: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
    concurrency: 20,
  },
};

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod, email, fileName, sendEmailToUser, link, id } =
    request.query;

  const receivedEmail = email && email !== "" ? email : "";

  const shouldSendEmailToUser =
    sendEmailToUser === "true" && email && email !== "";

  const userBucketName =
    id && id !== "" ? id : email && email !== "" ? email : "NoEmailOrId";

  let fileBuffer: Buffer;
  let cleanedFileName: string;

  const runId = uuidv4();
  const receivedTime = getCurrentTimestamp();

  await uploadStatus(runId, "Received", {
    message: "Request received",
    receivedTime: receivedTime,
    email: receivedEmail,
    id: id,
  });

  reply.status(200).send({
    runId: runId,
    receivedTime: receivedTime,
  });

  /* Supported Status
  - Received
  - Processing
  - Completed
  - Error types:
    - FileSizeExceeded
    - FileNumberOfPagesExceeded
    - InvalidPDF
    - CorruptedFile
    - MissingFile
    - CoreSystemFailure
  */

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
      const errorTime = getCurrentTimestamp();
      uploadStatus(runId, "Error", {
        email: receivedEmail,
        id: id,
        errorType: "InvalidLink",
        message: "Failed to download PDF from link",
        receivedTime: receivedTime,
        errorTime: errorTime,
      });
      if (shouldSendEmailToUser) {
        sendErrorEmail(receivedEmail, link, runId);
      }
      return;
    }
  } else {
    fileBuffer = request.body as Buffer;
    cleanedFileName = path.parse(fileName).name;
  }

  //Setting file names
  //PDF
  const pdfFileName = `${cleanedFileName}.pdf`;
  const pdfFilePath = `${userBucketName}/${pdfFileName}`;
  const s3pdfFilePath = `https://${process.env.AWS_BUCKET_NAME}/${pdfFilePath}`;
  const pdfFileUrl = await uploadFile(fileBuffer, pdfFilePath);

  //MP3
  const audioFileName = `${cleanedFileName}.mp3`;
  const audioFilePath = `${userBucketName}/${audioFileName}`;
  const encodedAudioFilePath = `${encodeURIComponent(
    userBucketName
  )}/${encodeURIComponent(audioFileName)}`;
  const s3encodedAudioFilePath = `https://${process.env.AWS_BUCKET_NAME}/${encodedAudioFilePath}`;

  //METADATA
  const metadataFileName = `${cleanedFileName}-metadata.json`;
  const metadataFilePath = `${userBucketName}/${metadataFileName}`;
  const s3metadataFilePath = `https://${process.env.AWS_BUCKET_NAME}/${metadataFilePath}`;

  //ERROR
  const errorFilePath = `${userBucketName}/${cleanedFileName}-error.json`;
  const encodedErrorFilePath = `${encodeURIComponent(
    userBucketName
  )}/${encodeURIComponent(cleanedFileName)}-error.json`;
  const s3encodedErrorFilePath = `https://${process.env.AWS_BUCKET_NAME}/${encodedErrorFilePath}`;

  // console.log(cleanedFileName);
  // return;

  if (fileBuffer.length > 100 * 1024 * 1024) {
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "FileSizeExceeded",
      message: "File size exceeds 100MB which is currently not supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
    });
    if (shouldSendEmailToUser) {
      sendErrorEmail(receivedEmail, cleanedFileName, runId);
    }
    return;
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

  let pngPagesOriginal: PngPageOutput[] = [];
  try {
    pngPagesOriginal = await pdfToPng(fileBuffer, {
      viewportScale: 5.0,
      outputFolder: tempImageDir,
    });
  } catch (error) {
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "InvalidPDFFormat",
      message: "File has invalid format",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
    });
    if (shouldSendEmailToUser) {
      sendErrorEmail(receivedEmail, cleanedFileName, runId);
    }
    return;
  }

  if (pngPagesOriginal.length > 100) {
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "FileNumberOfPagesExceeded",
      message: "pdf has more than 100 pages which is not currently supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
    });
    if (shouldSendEmailToUser) {
      sendErrorEmail(receivedEmail, cleanedFileName, runId);
    }
    return;
  }

  const startedProcessingTime = getCurrentTimestamp();
  uploadStatus(runId, "Processing", {
    email: receivedEmail,
    id: id,
    message: "Started processing",
    uploadedFileUrl: s3pdfFilePath,
    receivedTime: receivedTime,
    startedProcessingTime: startedProcessingTime,
    cleanedFileName: cleanedFileName,
  });

  console.log("converted pdf pages to images");

  if (summarizationMethod === "ultimate") {
    try {
      let allItems: Item[] = [];
      let abstractDetected = false;
      let authorInfoContents = "";
      let mainTitleContents = "";
      let allBatchResults: { index: number; relevant: boolean }[] = [];

      console.log(`PASS 0: Determining which pages are relevant`);

      // for (let i = 0; i < pngPagesOriginal.length; i += batchSize) {
      //   const batch = pngPagesOriginal.slice(i, i + batchSize);

      //   const batchResults = await Promise.all(
      //     batch.map(async (pngPageOriginal, index) => {
      //       // Replacing classifyPageContent with the new logic
      //       const USEFUL_CONTENT_PROMPT = `Determine if the following page is relevant and contains on topic information. If it contains meta information about journal or publisher or some other meta information, return false. For example if it a research paper anything that is not the main content of the paper is irrelevant. Accurately judge what is and what is not relevant`;

      //       const classificationSchema = z.object({
      //         isRelevant: z.boolean(),
      //       });

      //       try {
      //         const classificationResult = await getStructuredOpenAICompletion(
      //           USEFUL_CONTENT_PROMPT,
      //           ``,
      //           modelConfig.pageClassifier.model,
      //           modelConfig.pageClassifier.temperature,
      //           classificationSchema,
      //           [pngPageOriginal.path],
      //           64,
      //           0.7
      //         );

      //         const pageIsUseful = classificationResult?.isRelevant ?? true;
      //         console.log(`Page ${i + index + 1} is relevant: `, pageIsUseful);
      //         return { index: index + i, relevant: pageIsUseful };
      //       } catch (error) {
      //         console.error("Error during classification", error);
      //         return { index: index + i, relevant: true };
      //       }
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
        `PASS 1-1: Extracting text from the images\nPASS 1-2: Summarizing special items`
      );
      for (
        let i = 0;
        i < pngPages.length;
        i += modelConfig.extraction.concurrency
      ) {
        const batch = pngPages.slice(i, i + modelConfig.extraction.concurrency);

        const batchResults = await Promise.all(
          batch.map(async (pngPage, index) => {
            console.log("processing page ", i + index + 1);

            const EXTRACT_PROMPT = `Please extract all the items in the page in the correct order. Do not exclude any text.

            The text of one paragraph should always be one single text item.

            Please include math expressions.
            
            Include partial text cut off at the start or end of the page. 
            
            Combine all rows of a table into a single table_rows item.

            Make sure to detect code and algorithms as seperate items out of text.
            
            Please use your best judgement to determine the abstract even if it is not explicitly labeled as such.
            
            Usually, text item starting with a superscript number is an endnote.`;

            // Score each item on a scale of 0-5 based on how many complex math symbols appear in it.;

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
                    "table_notes",
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
                    "JSTOR_meta_information",
                    "CCS_concepts",
                    "keywords",
                    "acknowledgements_heading",
                    "acknowledgements_content",
                    "references_format_information",
                  ]),
                  content: z.string(),
                })
              ),
            });

            const pagePath = pngPage.path;
            const pageItems = await getStructuredOpenAICompletionWithRetries(
              runId,
              EXTRACT_PROMPT,
              ``,
              modelConfig.extraction.model,
              modelConfig.extraction.temperature,
              extractSchema,
              3,
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

              if (item.type === "main_title" && i < 5) {
                mainTitleContents += `\n\n${item.content}`;
              }

              if (item.type.includes("heading")) {
                item.content = `[break0.7]${item.content}[break0.7]`;
              }

              if (item.type === "table_rows") {
                console.log("summarizing table on page ", i + index + 1);
                const summarizationSchema = z.object({
                  summarizedItem: z.object({
                    type: z.enum(["table_rows"]),
                    label: z.object({
                      labelType: z.string(),
                      labelNumber: z.string(),
                      panelNumber: z.string().optional(),
                    }),
                    content: z.string(),
                  }),
                });

                const TABLE_SUMMARIZE_PROMPT = `Write a concise and effective summary for the table. Replace the raw rows in the content field with the summary. Summarize the size of changes / effects / estimates / results in the tables. Be very accurate while doing this analysis. You must get the patterns correct. To help understand them better, use context from the paper and any note below them. The summary should capture the main point of the table. Try to use as few numbers as possible. Keep in mind that the user cannot see the table as they will be listening to your summary. 
                
                Add the label "Table X" where X is the table number indicated in the page. You need to extract the correct table number. This is very important. Look for cues around the table and use your best judgement to determine it. Add the panel number that is being summarized, if it is mentioned.
                
                It is possible that a table can be part of a figure and labeled as a figure, in that case label it as a figure.
                
                Do not use markdown. Use plain text.`;

                const summarizedItem =
                  await getStructuredOpenAICompletionWithRetries(
                    runId,
                    TABLE_SUMMARIZE_PROMPT,
                    `Table to summarize on this page:\n${JSON.stringify(
                      item
                    )}\n\nPage context:\n${JSON.stringify(items)}`,
                    modelConfig.tableSummarization.model,
                    modelConfig.tableSummarization.temperature,
                    summarizationSchema,
                    3,
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
              }

              if (item.type === "figure_image") {
                console.log("summarizing figure on page ", i + index + 1);
                const summarizationSchema = z.object({
                  summarizedItem: z.object({
                    type: z.enum(["figure_image"]),
                    label: z.object({
                      labelType: z.string(),
                      labelNumber: z.string(),
                      panelNumber: z.string().optional(),
                    }),
                    content: z.string(),
                  }),
                });

                const examplePairs = [
                  {
                    userImage: "./src/prompt/figures/AIAYN_FIG_1.png",
                    assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                            "This figure is a diagram of the transformer model’s architecture, showing the steps take input tokens and produce output probabilities.  It has two components.  The left side is the encoder which begins with inputs, and the right side is the decoder which begins with outputs that are shifted right.  On the encoder side, first the input tokens are transformed into embeddings, which are then added to positional embeddings.  Then, there are 6 identical layers which include first a multi-head attention step, then a feed forward network. On the decoder side, the first steps are the same.  The input tokens are transformed into embeddings with positional embeddings added next.  Then, there are also 6 identical layers which are similar to this part of the encoder, but with an extra step.  The first step is masked multi-head attention, followed by multi-head attention over the output of the encoder stack.  Next comes the feed forward layer, just like in the encoder.  Finally, the last steps are a linear projection layer, and a softmax step which produces output probabilities."
                          }`,
                  },
                  {
                    userImage: "./src/prompt/figures/ALHGALW_FIG_2.png",
                    assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "2",
                              panelNumber: ""
                            }
                            content: "This figure plots the fraction of correct next-token predictions for 4 language models during training on a subset of the Pile training set, as a function of the number of training steps.  The four models are: SLM, Baseline, RKD and SALT.  Over the 200K steps shown, accuracy increases from around 55% to 58-60% after 200K steps, with increases slowing down as steps increase.  SALT outperforms baseline slightly for any number of steps, whereas SLM performs worse.  RKD performs better than baseline at first, but after around 75 thousand steps, begins to perform worse."
                          }`,
                  },
                  {
                    userImage: "./src/prompt/figures/COCD_FIG_1.png",
                    assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                            content: "This figure plots settler mortality against GDP per capita adjusted for purchasing power parity, both on a log scale.  Each data point is a country and a downward sloping line represents the strong negative correlation.  Data points are generally close to the line, with a few outliers."
                          }`,
                  },
                  {
                    userImage: "./src/prompt/figures/TYE_FIG_2.png",
                    assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                            content: "This figure shows cognitive outcome scores over 10 years.  It has 3 panels, each showing a different outcome for each of the four arms of the experiment, treatments for memory, reasoning, and speed, along with the control group.  The outcomes are scores for memory, reasoning and speed.  Each panel shows that the treatment associated with the each outcome resulted in larger increases in the score for that outcome, especially so for speed.  Each score for each treatment generally increase within the first year, peaks, and then declines after 3 years, especially between years 5 and 10."
                          }`,
                  },
                  {
                    userImage: "./src/prompt/figures/TYE_FIG_3.png",
                    assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                            content: "This figure plots self-reported IADL scores over 10 years for each of the 4 experimental groups, the 3 treatments, memory, reasoning, speed, as well as the control group. All groups have similar, roughly flat IADL scores for the first 3 years, which decline after.  In years 5 and 10, the control group’s scores are substantially lower than each of the treatments."
                          }`,
                  },
                ];

                const FIGURE_SUMMARIZE_PROMPT = `Write a detailed and effective summary for the figures. Replace the content field with the summary. 

                Every summary must have three subsections:
                1. Physical description of the image
                2. Description of the content of the figure
                3. Accurate inferences and conclusions from the content of the figure. 

                No need to explicitly mention each subsection.

                Add the label "Figure X" where X is the figure number indicated in the page. You need to extract the correct label type and label number. This is VERY IMPORTANT. Look for cues around the figure and use your best judgement to determine it. Possible label types can be Figure, Chart, Image etc.
                
                If there is no label or label number set the labelType as "Image" and labelNumber as "unlabeled".
                
                Do not use markdown. Use plain text.
                
                Remember that the user is going to listen to the output and cannot see the figure. Take that into account while producing the summary.`;

                const summarizedItem =
                  await getStructuredOpenAICompletionWithRetries(
                    runId,
                    FIGURE_SUMMARIZE_PROMPT,
                    `Figure to summarize on this page:\n${JSON.stringify(
                      item
                    )}\n\nPage context:\n${JSON.stringify(items)}`,
                    modelConfig.figureSummarization.model,
                    modelConfig.figureSummarization.temperature,
                    summarizationSchema,
                    3,
                    [pagePath],
                    16384,
                    0,
                    examplePairs
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
              }

              if (item.type === "code_or_algorithm") {
                console.log(
                  "summarizing code or algorithm on page ",
                  i + index + 1
                );
                const codeSummarizationSchema = z.object({
                  summarizedCode: z.object({
                    type: z.string(z.enum(["code_or_algorithm"])),
                    content: z.string(),
                    title: z.string(),
                    label: z.object({
                      labelType: z.string(),
                      labelNumber: z.string(),
                      panelNumber: z.string().optional(),
                    }),
                  }),
                });

                const CODE_SUMMARIZE_PROMPT = `Summarize the given code or algorithm. Explain what the code or algorithm does in simple terms including its input and output. Do not include any code syntax in the summary.
                
                Also extract the title of the algorithm or code block. If no title is mentioned, then generate an appropriate one yourself.
                
                Usually codeblocks do not have labels. If there is no label or label number set the labelType as "" and labelNumber as "unlabeled". If there is no panel number set the panelNumber as "unlabeled"

                Sometimes codeblocks can be labeled. If the codeblock is labeled as a "Figure", then try to detect the "Figure X" label where X is the number assigned to the figure. Look around for cuees to help you determine this.`;

                const summarizedCode =
                  await getStructuredOpenAICompletionWithRetries(
                    runId,
                    CODE_SUMMARIZE_PROMPT,
                    `Code or algorithm to summarize:\n${JSON.stringify(
                      item
                    )}\n\nPage context:\n${JSON.stringify(items)}`,
                    modelConfig.codeSummarization.model,
                    modelConfig.codeSummarization.temperature,
                    codeSummarizationSchema,
                    3,
                    [pagePath],
                    16384,
                    0
                  );

                item.label = summarizedCode?.summarizedCode?.label;
                item.title = summarizedCode?.summarizedCode?.title;
                item.content = `${item.label.labelType} ${
                  item.label.labelNumber === "unlabeled"
                    ? ""
                    : item.label.labelNumber
                } ${
                  item.label.panelNumber &&
                  item.label.panelNumber !== "unlabeled"
                    ? `Panel ${item.label.panelNumber}`
                    : ""
                } code explanation:\n${summarizedCode?.summarizedCode.content}`;
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

      console.log(
        "PASS 1-3: Improving author section and detecting main title."
      );
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

      const improvedAuthorInfo = await getStructuredOpenAICompletionWithRetries(
        runId,
        IMPROVE_AUTHOR_INFO_PROMPT,
        `Here is the author info: ${authorInfoContents}`,
        modelConfig.authorInfoExtractor.model,
        modelConfig.authorInfoExtractor.temperature,
        authorExtractSchema,
        3,
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
            return affiliation && affiliation !== ""
              ? `[break0.3]${authorNames.join(", ")} from ${affiliation}`
              : `[break0.3]${authorNames.join(", ")}`;
          })
          .join(", ");

        // Add the total number of authors if more than 5
        if (totalAuthors > maxAuthors) {
          compiledAuthorInfo = `There are ${totalAuthors} authors, including ${compiledAuthorInfo}`;
        }

        allItems[firstAuthorInfoIndex].type = "improved_author_info";
        allItems[firstAuthorInfoIndex].content = compiledAuthorInfo;
      }

      const MAIN_TITLE_EXTRACTION_PROMPT = `Extract the main title of the document from the following text. Use your judgement to accurately determine the main title.`;

      const mainTitleSchema = z.object({
        mainTitle: z.string(),
      });

      const extractedMainTitle = await getStructuredOpenAICompletionWithRetries(
        runId,
        MAIN_TITLE_EXTRACTION_PROMPT,
        `Here is the text from the first 5 pages: ${mainTitleContents}`,
        modelConfig.mainTitleExtractor.model,
        modelConfig.mainTitleExtractor.temperature,
        mainTitleSchema,
        3,
        pngPages.slice(0, 5).map((page) => page.path)
      );

      const extractedTitle = extractedMainTitle?.mainTitle || "NoTitleDetected";

      console.log("\nThe main title is:\n\n", extractedTitle);

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

      console.log(
        "PASS 1-4: Fixing potential issues with references and acknowledgements"
      );

      //processing to correct some important headings
      for (const item of allItems) {
        if (item.type === "heading") {
          const normalizedContent = removeBreaks(item.content).toLowerCase();
          if (
            normalizedContent.includes("acknowledgment") ||
            normalizedContent.includes("acknowledgments") ||
            normalizedContent.includes("acknowledgements") ||
            normalizedContent.includes("acknowledgement")
          ) {
            item.type = "acknowledgements_heading";
          } else if (
            normalizedContent.includes("reference") ||
            normalizedContent.includes("references")
          ) {
            item.type = "references_heading";
          }
        }
      }

      let lastReferencesHeadingIndex = -1;

      // Find the last references_heading index
      for (let i = allItems.length - 1; i >= 0; i--) {
        if (allItems[i].type === "references_heading") {
          lastReferencesHeadingIndex = i;
          break;
        }
      }

      // Update the type of all but the final references heading
      for (let i = 0; i < allItems.length; i++) {
        if (
          allItems[i].type === "references_heading" &&
          i !== lastReferencesHeadingIndex
        ) {
          allItems[i].type = "stray_references_heading";
        }
      }

      let conclusionInsertionIndex = -1;
      let conclusionInsertionPage = 0;

      // Find the last references_heading or references_item
      for (let i = allItems.length - 1; i >= 0; i--) {
        if (
          allItems[i].type === "references_heading" ||
          allItems[i].type === "references_item"
        ) {
          conclusionInsertionIndex = i;
          conclusionInsertionPage = allItems[i].page;
          break;
        }
      }

      // Insert the message if a suitable insertion point was found
      if (conclusionInsertionIndex !== -1) {
        allItems.splice(conclusionInsertionIndex + 1, 0, {
          type: "end_marker",
          content: "[break0.4]You have reached the end of the paper.[break0.4]",
          page: conclusionInsertionPage,
        });
      }
      console.log("PASS 1-5: filtering unnecessary item types");

      let inAcknowledgementsSection = false;
      let inReferencesSection = false;
      let mainTitleDetected = false;
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
              if (item.type === "end_marker") {
                return true;
              }
              // Check for acknowledgements section
              if (item.type === "acknowledgements_heading") {
                inAcknowledgementsSection = true;
              } else if (item.type.includes("heading")) {
                inAcknowledgementsSection = false;
              }

              // Check for references section
              if (item.type === "references_heading") {
                inReferencesSection = true;
              } else if (item.type.includes("heading")) {
                inReferencesSection = false;
              }

              if (inAcknowledgementsSection || inReferencesSection) {
                return false; // Skip items in the acknowledgements section
              }
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

              if (
                !removeBreaks(item.content).trim() ||
                removeBreaks(item.content).trim() === ""
              ) {
                return false;
              }

              return [
                "text",
                "heading",
                "figure_image",
                "table_rows",
                "math",
                "abstract_content",
                "code_or_algorithm",
                "end_marker",
              ].includes(item.type);
            }
          })
        : allItems.filter((item: Item, index: number, array: any[]) => {
            if (item.type === "end_marker") {
              return true;
            }

            // Check for acknowledgements section
            if (item.type === "acknowledgements_heading") {
              inAcknowledgementsSection = true;
            } else if (item.type.includes("heading")) {
              inAcknowledgementsSection = false;
            }

            // Check for references section
            if (item.type === "references_heading") {
              inReferencesSection = true;
            } else if (item.type.includes("heading")) {
              inReferencesSection = false;
            }

            if (inAcknowledgementsSection || inReferencesSection) {
              return false; // Skip items in the acknowledgements or references section
            }
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

            if (
              !removeBreaks(item.content).trim() ||
              removeBreaks(item.content).trim() === ""
            ) {
              return false;
            }

            if (item.type === "main_title") {
              if (mainTitleDetected) {
                return false; // Skip subsequent main_title items
              }
              mainTitleDetected = true;
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
              "end_marker",
            ].includes(item.type);
          });

      const endMarkerIndex = filteredItems.findIndex(
        (item) => item.type === "end_marker"
      );

      if (endMarkerIndex !== -1 && endMarkerIndex < filteredItems.length - 1) {
        filteredItems[endMarkerIndex].content =
          "[break0.4]You have reached the end of the main paper. Appendix sections follow.[break0.4]";
      }

      const parsedItemsPath = path.join(fileNameDir, "parsedItems.json");
      fs.writeFileSync(parsedItemsPath, JSON.stringify(allItems, null, 2));
      console.log("Saved raw text extract to", parsedItemsPath);

      console.log("PASS 2-1: detecting citations");
      const CITATION_DETECTION_PROMPT = `Analyze the following text and determine if the text contains citations to other papers. Ignore citations to figures or images in this paper`;

      const citationDetectionSchema = z.object({
        hasCitations: z.boolean(),
      });

      for (
        let i = 0;
        i < filteredItems.length;
        i += modelConfig.citationDetection.concurrency
      ) {
        const itemBatch = filteredItems.slice(
          i,
          i + modelConfig.citationDetection.concurrency
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            try {
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                CITATION_DETECTION_PROMPT,
                `Text to analyze:\n${item.content}`,
                modelConfig.citationDetection.model,
                modelConfig.citationDetection.temperature,
                citationDetectionSchema,
                3,
                [],
                256,
                0.1
              );

              item.hasCitations = result?.hasCitations || false;
            } catch (error) {
              console.error(
                "Non fatal error while detecting citations:",
                error
              );
              item.hasCitations = false; // Default to false if there's an error
            }
          })
        );
      }

      console.log("PASS 2-2: optimzing citations");

      const itemsWithCitations = filteredItems.filter(
        (item) => item.hasCitations
      );

      if (itemsWithCitations.length > 0) {
        const CITATION_REPLACEMENT_PROMPT = `Remove citations elements from the user text.
      
        Examples of citation elements:
        - [10, 38, ....]
        - (Author et al., YYYY; Author et al., YYYY;......)
        - ^number
        - (Author, year, page number) or Author (year, page number)
        - (10, 28,...)
        - Author (page number)

        Do not remove entire sentences just remove the citation element. If the citation is part of a phrase like "such as <citation element>" then remove the phrase from the sentence. However if the citation is part of a phrase like "such as <Noun> <citation element>" then keep the phrase "such as <Noun>" and only remove the citation element.
        
        However if the citation is like "Author <citation element> suggests that..." then only remove the citation element do not remove the author name.

        Do not remove citations to tables and figures in the paper.
        
        Return the original text and the text with citations removed.`;

        const referenceSchema = z.object({
          originalText: z.string(),
          textWithCitationsRemoved: z.string(),
        });

        // const referencesContent = referencesItems
        //   .map((refItem) => refItem.content)
        //   .join("\n");

        for (
          let i = 0;
          i < itemsWithCitations.length;
          i += modelConfig.citationOptimization.concurrency
        ) {
          const itemBatch = itemsWithCitations.slice(
            i,
            i + modelConfig.citationOptimization.concurrency
          );
          console.log(
            `processing text items ${i} through ${
              i + modelConfig.citationOptimization.concurrency
            }`
          );

          await Promise.all(
            itemBatch.map(async (item) => {
              try {
                if (item.type === "text") {
                  const processedItem =
                    await getStructuredOpenAICompletionWithRetries(
                      runId,
                      CITATION_REPLACEMENT_PROMPT,
                      `User text:\n${item.content}`,
                      modelConfig.citationOptimization.model,
                      modelConfig.citationOptimization.temperature,
                      referenceSchema,
                      3,
                      [],
                      16384,
                      0.1
                    );

                  item.citationReplacement = {
                    originalText: processedItem?.originalText || "",
                    textWithCitationsRemoved:
                      processedItem?.textWithCitationsRemoved || "",
                  };

                  item.content =
                    item.citationReplacement.textWithCitationsRemoved;
                  item.replacedCitations = true;
                }
              } catch (error) {
                console.log(
                  `Non fatal error while processing citations: ${error}`
                );
              }
            })
          );
        }
      }

      //It is important to replace citations first and then optimize the math - but only in content with math.
      console.log("PASS 3-1: detecting math symbol frequency");

      const MATH_SYMBOL_FREQUENCY_PROMPT = `Analyze the following text and determine the frequency of complex math symbols and numbers. Provide a score between 0 and 5, where 0 means no complex math symbols and numbers and 5 means a high frequency of complex math symbols and numbers.`;

      const mathSymbolFrequencySchema = z.object({
        mathSymbolFrequency: z.number(),
      });

      for (
        let i = 0;
        i < filteredItems.length;
        i += modelConfig.mathSymbolFrequencyAssignment.concurrency
      ) {
        const itemBatch = filteredItems.slice(
          i,
          i + modelConfig.mathSymbolFrequencyAssignment.concurrency
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            if (item.type === "math") {
              item.mathSymbolFrequency = 5;
            } else {
              try {
                const result = await getStructuredOpenAICompletionWithRetries(
                  runId,
                  MATH_SYMBOL_FREQUENCY_PROMPT,
                  `Text to analyze:\n${item.content}`,
                  modelConfig.mathSymbolFrequencyAssignment.model,
                  modelConfig.mathSymbolFrequencyAssignment.temperature,
                  mathSymbolFrequencySchema,
                  3,
                  [],
                  256,
                  0.1
                );

                item.mathSymbolFrequency = result?.mathSymbolFrequency || 0;
              } catch (error) {
                console.error(
                  "Non fatal error while assigning math symbol frequency:",
                  error
                );
                item.mathSymbolFrequency = 0; // Default to 0 if there's an error
              }
            }
          })
        );
      }

      console.log("PASS 3-2: optimizing items with high math symbol frequency");

      const itemsThatCanIncludeMath = filteredItems.filter(
        (item) => item.mathSymbolFrequency && item.mathSymbolFrequency > 0
      );

      if (itemsThatCanIncludeMath.length > 0) {
        const MATH_OPTIMIZATION_PROMPT = `The following text will be converted to audio for the user to listen to. Replace math notation and all LaTeX formatting with plain english words to make it more suitable for that purpose. Convert accurately. 
        
        Some examples includes changing "+" to "plus" and inserting a "times" when multiplication is implied. Use your best judgment to make the text as pleasant for audio as possible.
        
        Only convert math notation, do not alter the rest of the text. Return the entire original text and the worded replacement.`;

        const mathOptimizationSchema = z.object({
          originalText: z.string(),
          wordedReplacement: z.string(),
        });

        for (
          let i = 0;
          i < itemsThatCanIncludeMath.length;
          i += modelConfig.mathOptimization.concurrency
        ) {
          const itemBatch = itemsThatCanIncludeMath.slice(
            i,
            i + modelConfig.mathOptimization.concurrency
          );
          console.log(
            `processing math items ${i} through ${
              i + modelConfig.mathOptimization.concurrency
            }`
          );

          await Promise.all(
            itemBatch.map(async (item) => {
              try {
                if (item.type === "math" || item.type === "text") {
                  const processedItem =
                    await getStructuredOpenAICompletionWithRetries(
                      runId,
                      MATH_OPTIMIZATION_PROMPT,
                      `Text to optimize:\n${item.content}`,
                      modelConfig.mathOptimization.model,
                      modelConfig.mathOptimization.temperature,
                      mathOptimizationSchema,
                      3,
                      [],
                      16384,
                      0.2
                    );

                  item.mathReplacement = {
                    originalText: processedItem?.originalText || "",
                    wordedReplacement: processedItem?.wordedReplacement || "",
                  };

                  item.content = item.mathReplacement.wordedReplacement;

                  item.optimizedMath = true;
                }
              } catch (error) {
                console.log(`Non fatal error while processing math: ${error}`);
              }
            })
          );
        }
      }

      //Process abbreviations
      console.log("PASS 4-1: Detecting abbreviations");
      const specialAbbreviations: Abbreviation[] = [
        {
          abbreviation: "CI",
          replacement: "C.I.",
          type: "initialism",
          expansion: "confidence interval",
        },
        {
          abbreviation: "ROC",
          replacement: "R.O.C.",
          type: "initialism",
          expansion: "receiver operating curve",
        },
      ];

      console.log("PASS 4-2: Replacing known abbreviations");
      filteredItems.forEach((item) => {
        item.content = replaceAbbreviations(item.content, specialAbbreviations);
      });

      console.log("PASS 4-3: Tagging items with start and end cut off");
      //Tagging items with end and start cut off
      filteredItems.forEach((item) => {
        if (["abstract_content", "text"].includes(item.type)) {
          const { isStartCutOff, isEndCutOff } = isTextCutoff(item.content);
          item.isStartCutOff = isStartCutOff;
          item.isEndCutOff = isEndCutOff;
        }
      });

      const specialItems = filteredItems.filter(
        (item) =>
          item.type === "figure_image" ||
          item.type === "table_rows" ||
          item.type === "code_or_algorithm"
      );
      console.log("PASS 4-4: repositioning images and figures and code");
      for (const item of specialItems) {
        if (item.repositioned || !item.label) {
          continue;
        }

        const { labelType, labelNumber } = item.label;
        console.log("repositioning ", labelType, " ", labelNumber);
        let mentionIndex = -1;
        let headingIndex = -1;
        let textWithoutEndCutoffIndex = -1;

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
          } else if (labelType.toLocaleLowerCase() === "image") {
            matchWords.push(
              `Image ${labelNumber}`,
              `image ${labelNumber}`,
              `Img ${labelNumber}`,
              `Img. ${labelNumber}`,
              `IMAGE ${labelNumber}`,
              `IMG ${labelNumber}`,
              `IMG. ${labelNumber}`
            );
          } else if (labelType.toLocaleLowerCase() === "table") {
            matchWords.push(`Table ${labelNumber}`, `Table. ${labelNumber}`);
          } else if (labelType.toLocaleLowerCase() === "algorithm") {
            matchWords.push(
              `Algorithm ${labelNumber}`,
              `Algo ${labelNumber}`,
              `Algo. ${labelNumber}`,
              `Alg. ${labelNumber}`,
              `ALGORITHM ${labelNumber}`
            );
          } else {
            matchWords.push(`${labelType} ${labelNumber}`);
          }

          for (let i = 0; i < filteredItems.length; i++) {
            if (
              i !== filteredItems.indexOf(item) &&
              matchWords.some((word) => filteredItems[i].content.includes(word))
            ) {
              mentionIndex = i;
              // console.log(
              //   "found first mention in ",
              //   JSON.stringify(filteredItems[i])
              // );
              break;
            }
          }
        }

        const startIndex =
          mentionIndex !== -1 ? mentionIndex : filteredItems.indexOf(item) + 1;

        for (let i = startIndex; i < filteredItems.length; i++) {
          if (filteredItems[i].type.includes("heading")) {
            headingIndex = i;
            // console.log(
            //   "found the first heading below mention in",
            //   JSON.stringify(filteredItems[i])
            // );
            break;
          }
          if (
            filteredItems[i].type === "text" &&
            !filteredItems[i].isEndCutOff
          ) {
            textWithoutEndCutoffIndex = i;
            // console.log(
            //   "found the first text without end cutoff below mention in",
            //   JSON.stringify(filteredItems[i])
            // );
            break;
          }
        }

        console.log(
          "moving the item based on end cutoff logic or above the first heading or to the end"
        );
        const currentIndex = filteredItems.indexOf(item);
        let insertIndex;

        if (textWithoutEndCutoffIndex !== -1) {
          insertIndex =
            textWithoutEndCutoffIndex +
            (currentIndex < textWithoutEndCutoffIndex ? 0 : 1);
        } else if (headingIndex !== -1) {
          insertIndex = headingIndex + (currentIndex < headingIndex ? -1 : 0);
        } else {
          insertIndex = filteredItems.length; // Default to end if no suitable position is found
        }

        const [movedItem] = filteredItems.splice(currentIndex, 1);

        while (
          insertIndex < filteredItems.length &&
          filteredItems[insertIndex].type === movedItem.type
        ) {
          insertIndex += 1; // Move below the item
        }

        if (insertIndex !== -1) {
          filteredItems.splice(insertIndex, 0, movedItem);
        } else {
          filteredItems.push(movedItem);
        }

        item.repositioned = true;
      }

      console.log("PASS 4-5: Adding breaks where needed");

      filteredItems.forEach((item) => {
        if (
          [
            "text",
            "figure_image",
            "code_or_algorithm",
            "table_rows",
            "abstract_content",
          ].includes(item.type) &&
          !item.isEndCutOff
        ) {
          item.content += "[break0.4]";
        }
      });

      // console.log("PASS 5-1: Checking audio pleasantness");

      // const AUDIO_PLEASANTNESS_PROMPT = `Analyze the following item and detect issues that would make the content suboptimal as audio. For example, a text item could be marked as heading.`;

      // const audioPleasantnessSchema = z.object({
      //   audioIssues: z.array(
      //     z.enum([
      //       "too_much_math_notation",
      //       "very_long_list",
      //       "high_repetition",
      //       "too_many_citations",
      //     ])
      //   ),
      // });

      // for (
      //   let i = 0;
      //   i < filteredItems.length;
      //   i += modelConfig.audioPleasantnessCheck.concurrency
      // ) {
      //   const itemBatch = filteredItems.slice(
      //     i,
      //     i + modelConfig.audioPleasantnessCheck.concurrency
      //   );

      //   await Promise.all(
      //     itemBatch.map(async (item) => {
      //       try {
      //         const result = await getStructuredOpenAICompletionWithRetries(
      //           runId,
      //           AUDIO_PLEASANTNESS_PROMPT,
      //           `Item to analyze:\n${JSON.stringify(
      //             {
      //               type: item.type,
      //               content: removeBreaks(item.content),
      //             },
      //             null,
      //             2
      //           )}`,
      //           modelConfig.audioPleasantnessCheck.model,
      //           modelConfig.audioPleasantnessCheck.temperature,
      //           audioPleasantnessSchema,
      //           3,
      //           [],
      //           256,
      //           0.1
      //         );

      //         item.audioIssues = result?.audioIssues || [];
      //       } catch (error) {
      //         console.error(
      //           "Non fatal error checking audio pleasantness:",
      //           error
      //         ); // Default to false if there's an error
      //         item.audioIssues = [];
      //       }
      //     })
      //   );
      // }

      const filteredItemsPath = path.join(fileNameDir, "filteredItems.json");
      fs.writeFileSync(
        filteredItemsPath,
        JSON.stringify(filteredItems, null, 2)
      );
      console.log("Saved filtered items to", filteredItemsPath);

      //return;

      const parsedItemsFileName = `${cleanedFileName}-parsedItems.json`;
      const filteredItemsFileName = `${cleanedFileName}-filteredItems.json`;
      const parsedItemsFilePath = `${userBucketName}/${parsedItemsFileName}`;
      const filteredItemsFilePath = `${userBucketName}/${filteredItemsFileName}`;

      const parsedItemsFileUrl = await uploadFile(
        fs.readFileSync(parsedItemsPath),
        parsedItemsFilePath
      );

      const filteredItemsFileUrl = await uploadFile(
        fs.readFileSync(filteredItemsPath),
        filteredItemsFilePath
      );

      await subscribeEmail(
        receivedEmail,
        process.env.MAILCHIMP_AUDIENCE_ID || ""
      );
      console.log("Subscribed user to mailing list");

      const { audioBuffer, audioMetadata, tocAudioMetadata } =
        await synthesizeSpeechInChunksOpenAI(filteredItems);
      console.log("Generated audio file");

      const audioFileUrl = await uploadFile(audioBuffer, audioFilePath);
      const metadataFileUrl = await uploadFile(
        Buffer.from(
          JSON.stringify(
            { segments: audioMetadata, tableOfContents: tocAudioMetadata },
            null,
            2
          )
        ),
        metadataFilePath
      );

      const completedTime = getCurrentTimestamp();
      uploadStatus(runId, "Completed", {
        email: receivedEmail,
        id: id,
        message: "Generated audio output and metadata",
        uploadedFileUrl: s3pdfFilePath,
        audioFileUrl: s3encodedAudioFilePath,
        metadataFileUrl: s3metadataFilePath,
        extractedTitle,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        completedTime: completedTime,
        cleanedFileName,
      });

      if (shouldSendEmailToUser) {
        await sendSuccessEmail(
          receivedEmail,
          cleanedFileName,
          s3encodedAudioFilePath
        );
      }
    } catch (error) {
      const errorFileUrl = await uploadFile(
        Buffer.from(JSON.stringify(error, Object.getOwnPropertyNames(error))),
        errorFilePath
      );

      const errorTime = getCurrentTimestamp();
      uploadStatus(runId, "Error", {
        email: receivedEmail,
        id: id,
        errorType: "CoreSystemFailure",
        message: `Error: ${error}`,
        errorFileUrl: s3encodedErrorFilePath,
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        errorTime: errorTime,
        cleanedFileName,
      });

      if (shouldSendEmailToUser) {
        await sendErrorEmail(
          receivedEmail,
          cleanedFileName,
          runId,
          s3encodedErrorFilePath
        );
      }

      console.error("Error generating audio file:", error);
    }
  } else {
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "SummarizationMethodNotSupported",
      message: "This summarization method is not supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
    });

    if (shouldSendEmailToUser) {
      await sendErrorEmail(
        receivedEmail,
        cleanedFileName,
        runId,
        s3encodedErrorFilePath
      );
    }
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
