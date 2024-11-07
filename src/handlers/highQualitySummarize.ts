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
import { clearDirectory } from "@utils/io";
import { synthesizeSpeechInChunks } from "@utils/polly";
import { getStructuredOpenAICompletionWithRetries } from "@utils/openai";
import { isTextCutoff } from "@utils/text";
import { removeBreaks } from "@utils/ssml";

const { db } = getDB();

const modelConfig: ModelConfig = {
  pageClassifier: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
  },
  extraction: {
    temperature: 0.3,
    model: "gpt-4o-2024-08-06",
  },
  figureSummarization: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
  },
  tableSummarization: {
    temperature: 0.2,
    model: "gpt-4o-2024-08-06",
  },
  codeSummarization: {
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

  reply.status(200).send({
    runId: runId,
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
      uploadStatus(runId, "Error", {
        errorType: "InvalidLink",
        message: "Failed to download PDF from link",
      });
      sendErrorEmail(email, link, runId);
      return;
    }
  } else {
    fileBuffer = request.body as Buffer;
    cleanedFileName = path.parse(fileName).name;
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

  // console.log(cleanedFileName);
  // return;

  if (fileBuffer.length > 100 * 1024 * 1024) {
    uploadStatus(runId, "Error", {
      errorType: "FileSizeExceeded",
      message: "File size exceeds 100MB which is currently not supported",
      uploadedFileUrl: s3pdfFilePath,
    });
    sendErrorEmail(email, cleanedFileName, runId);
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
      viewportScale: 3.0,
      outputFolder: tempImageDir,
    });
  } catch (error) {
    uploadStatus(runId, "Error", {
      errorType: "InvalidPDFFormat",
      message: "File has invalid format",
      uploadedFileUrl: s3pdfFilePath,
    });
    sendErrorEmail(email, cleanedFileName, runId);
    return;
  }

  if (pngPagesOriginal.length > 100) {
    uploadStatus(runId, "Error", {
      errorType: "FileNumberOfPagesExceeded",
      message: "pdf has more than 100 pages which is not currently supported",
      uploadedFileUrl: s3pdfFilePath,
    });
    sendErrorEmail(email, cleanedFileName, runId);
    return;
  }

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
        `PASS 1: Extracting text from the images\n\nPASS 1.5: Summarizing special items`
      );
      for (let i = 0; i < pngPages.length; i += batchSize) {
        const batch = pngPages.slice(i, i + batchSize);

        const batchResults = await Promise.all(
          batch.map(async (pngPage, index) => {
            console.log("processing page ", i + index + 1);

            const EXTRACT_PROMPT = `Please extract all the items in the page in the correct order. 

            One paragraph should always be one single item.

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
                    "keywords",
                    "acknowledgements_heading",
                    "acknowledgements_content",
                  ]),
                  content: z.string(),
                  mathSymbolFrequency: z.number(),
                  hasCitations: z.boolean(),
                  allAbbreviations: z.array(
                    z.object({
                      abbreviation: z.string(),
                      expansion: z.string().optional(),
                      type: z
                        .enum([
                          "pronounced_as_a_single_word",
                          "pronounced_with_initials",
                        ])
                        .optional(),
                    })
                  ),
                })
              ),
            });

            const pagePath = pngPage.path;
            const pageItems = await getStructuredOpenAICompletionWithRetries(
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
                
                Do not use markdown. Use plain text.`;

                const summarizedItem =
                  await getStructuredOpenAICompletionWithRetries(
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

                Add the label "Figure X" where X is the figure number indicated in the page. You need to extract the correct label type and label number. This is very important. Look for cues around the figure and use your best judgement to determine it. Possible label types can be Figure, Chart, Image etc.
                
                If there is no label or label number set the labelType as "Image" and labelNumber as "unlabeled".
                
                Do not use markdown. Use plain text.
                
                Remember that the user is going to listen to the output and cannot see the figure. Take that into account while producing the summary.`;

                const summarizedItem =
                  await getStructuredOpenAICompletionWithRetries(
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
                    content: z.string(),
                    title: z.string(),
                  }),
                });

                const CODE_SUMMARIZE_PROMPT = `Summarize the given code or algorithm. Explain what the code or algorithm does in simple terms including its input and output. Do not include any code syntax in the summary.
                
                Also extract the title of the algorithm or code block. If no title is mentioned, then generate an appropriate one yourself.`;

                const summarizedCode =
                  await getStructuredOpenAICompletionWithRetries(
                    CODE_SUMMARIZE_PROMPT,
                    `Code or algorithm to summarize:\n${JSON.stringify(
                      item
                    )}\n\nPage context:\n${JSON.stringify(items)}`,
                    modelConfig.codeSummarization.model,
                    modelConfig.codeSummarization.temperature,
                    codeSummarizationSchema,
                    3,
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
                const { isStartCutOff, isEndCutOff } = isTextCutoff(
                  item.content
                );
                item.isStartCutOff = isStartCutOff;
                item.isEndCutOff = isEndCutOff;
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

      const improvedAuthorInfo = await getStructuredOpenAICompletionWithRetries(
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

      let inAcknowledgementsSection = false;
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
              // Check for acknowledgements section
              if (item.type === "acknowledgements_heading") {
                inAcknowledgementsSection = true;
              } else if (item.type.includes("heading")) {
                inAcknowledgementsSection = false;
              }

              if (inAcknowledgementsSection) {
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
              ].includes(item.type);
            }
          })
        : allItems.filter((item: Item, index: number, array: any[]) => {
            // Check for acknowledgements section
            if (item.type === "acknowledgements_heading") {
              inAcknowledgementsSection = true;
            } else if (item.type.includes("heading")) {
              inAcknowledgementsSection = false;
            }

            if (inAcknowledgementsSection) {
              return false; // Skip items in the acknowledgements section
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
          mentionIndex !== -1 ? mentionIndex : filteredItems.indexOf(item) + 1;

        for (let i = startIndex; i < filteredItems.length; i++) {
          if (filteredItems[i].type.includes("heading")) {
            headingIndex = i;
            console.log(
              "found the first heading below mention in",
              JSON.stringify(filteredItems[i])
            );
            break;
          }
          if (
            filteredItems[i].type === "text" &&
            !filteredItems[i].isEndCutOff
          ) {
            textWithoutEndCutoffIndex = i;
            console.log(
              "found the first text without end cutoff below mention in",
              JSON.stringify(filteredItems[i])
            );
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

        // Check if the item at the insert index is the same type and has the same label
        // while (
        //   insertIndex < filteredItems.length &&
        //   filteredItems[insertIndex].type === movedItem.type &&
        //   filteredItems[insertIndex].label &&
        //   filteredItems[insertIndex].label?.labelType ===
        //     movedItem.label?.labelType &&
        //   filteredItems[insertIndex].label?.labelNumber ===
        //     movedItem.label?.labelNumber
        // ) {
        //   insertIndex += 1; // Move below the item
        // }

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
        (item) => item.hasCitations && !item.isEndCutOff
      );

      if (itemsWithCitations.length > 0) {
        const CITATION_REPLACEMENT_PROMPT = `Remove citations from the user text. 
        
        If the citation is part of a phrase like "such as <citations>" then remove the phrase.

        Keep references to tables and figures.
        
        Please return the provided text as it is with only citations removed. Do not attempt to complete the text.`;

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
              try {
                if (item.type === "text") {
                  const processedItem =
                    await getStructuredOpenAICompletionWithRetries(
                      CITATION_REPLACEMENT_PROMPT,
                      `User text:\n${item.content}`,
                      modelConfig.citation.model,
                      modelConfig.citation.temperature,
                      referenceSchema,
                      3,
                      [],
                      16384,
                      0.1
                    );

                  item.content = processedItem?.textWithCitationsRemoved;
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
              try {
                if (item.type === "math" || item.type === "text") {
                  const processedItem =
                    await getStructuredOpenAICompletionWithRetries(
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

                  item.content = processedItem?.optimizedContent;
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
      console.log("Processing abbreviations");

      const abbreviationMap: {
        [key: string]: { expansion: string; type: string };
      } = {};
      const abbreviationOccurrences: { [key: string]: number } = {};

      filteredItems.forEach((item) => {
        if (item.allAbbreviations) {
          item.allAbbreviations.forEach((abbr) => {
            try {
              const abbrKey = abbr.abbreviation.toLowerCase().replace(/s$/, "");
              const expansion = abbr.expansion || "";

              // Track occurrences
              abbreviationOccurrences[abbrKey] =
                (abbreviationOccurrences[abbrKey] || 0) + 1;

              // Store the first expansion found
              if (!abbreviationMap[abbrKey] && expansion) {
                abbreviationMap[abbrKey] = { expansion, type: abbr.type || "" };
              }

              // Check first two appearances
              if (
                abbreviationOccurrences[abbrKey] <= 2 &&
                !item.content.includes(expansion)
              ) {
                item.content = item.content.replace(
                  new RegExp(`\\b${abbr.abbreviation}\\b`, "g"),
                  expansion
                );
              }

              //Add periods for "pronounced_with_initials"
              if (
                abbr.type === "pronounced_with_initials" &&
                !abbr.abbreviation.includes(".")
              ) {
                const baseAbbr = abbr.abbreviation.replace(/s$/, "");
                const withPeriods = baseAbbr.split("").join(".");

                // Create a regex to match both singular and plural forms
                const regex = new RegExp(`\\b(${baseAbbr})(s?)\\b`, "g");

                // Replace based on whether the matched item has 's' or not
                item.content = item.content.replace(regex, (match, p1, p2) => {
                  return p2 ? `${withPeriods}s` : withPeriods;
                });
              }
            } catch (error) {
              console.log("Error while processing abbreviations: ", error);
            }
          });
        }
      });

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
        await sendSuccessEmail(email, cleanedFileName, s3encodedAudioFilePath);
      }
    } catch (error) {
      const errorFileUrl = await uploadFile(
        Buffer.from(JSON.stringify(error, Object.getOwnPropertyNames(error))),
        errorFilePath
      );

      uploadStatus(runId, "Error", {
        errorType: "CoreSystemFailure",
        message: `Error: ${error}`,
        errorFileUrl: s3encodedErrorFilePath,
        uploadedFileUrl: s3pdfFilePath,
      });

      if (shouldSendEmailToUser) {
        await sendErrorEmail(
          email,
          cleanedFileName,
          runId,
          s3encodedErrorFilePath
        );
      }

      console.error("Error generating audio file:", error);
    }
  } else {
    uploadStatus(runId, "Error", {
      errorType: "SummarizationMethodNotSupported",
      message: "This summarization method is not supported",
      uploadedFileUrl: s3pdfFilePath,
    });

    if (shouldSendEmailToUser) {
      await sendErrorEmail(
        email,
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
