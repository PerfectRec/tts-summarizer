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
import {
  collapseConsecutiveLetters,
  isTextCutoff,
  replaceAbbreviations,
} from "@utils/text";
import { processUnstructuredBuffer } from "@utils/unstructured";

const { db } = getDB();

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  //API RECEPTION----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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

  // MAIN PROCESSING --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  if (summarizationMethod === "ultimate") {
    try {
      let initialItems: UnstructuredItem[] = [];
      let parsedItems: Item[] = [];
      let filteredItems: Item[] = [];
      let extractedTitle: string = "NoTitleDetected";
      const pngPages = pngPagesOriginal;

      // Get the initial items from Unstructured

      console.log("UNSTRUCTURED PASS: Using unstructured to get initial JSON");
      initialItems = await processUnstructuredBuffer(
        fileBuffer,
        `${cleanedFileName}.pdf`
      );

      //Grouping items by page
      const initialItemsByPage: Record<number, UnstructuredItem[]> =
        initialItems
          .filter(
            (item) =>
              !["PageNumber", "Header", "Footer", "UncategorizedText"].includes(
                item.type
              )
          )
          .reduce(
            (
              acc: Record<number, UnstructuredItem[]>,
              item: UnstructuredItem
            ) => {
              // Clean up the structure of the items
              const cleanedItem = {
                type: item.type,
                element_id: item.element_id,
                text: item.text,
                metadata: {
                  page_number: item.metadata.page_number,
                },
              };

              if (!acc[cleanedItem.metadata.page_number]) {
                acc[cleanedItem.metadata.page_number] = [];
              }
              acc[cleanedItem.metadata.page_number].push(cleanedItem);
              return acc;
            },
            {} as Record<number, UnstructuredItem[]>
          );

      const initialItemsPath = path.join(fileNameDir, "initialItems.json");
      fs.writeFileSync(initialItemsPath, JSON.stringify(initialItems, null, 2));
      console.log("Saved initial json to", initialItemsPath);

      // Type conversion and author info and main title extraction steps---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      console.log(
        "LLM PASS: Converting unstructured types to our custom types"
      );
      const TYPE_CONVERSION_CONCURRENCY = 20;
      const TYPE_CONVERSION_MODEL: Model = "gpt-4o-2024-08-06";
      const TYPE_CONVERSION_TEMPERATURE = 0.5;
      const TYPE_CONVERSION_SYSTEM_PROMPT = `For all the given items, accurately determine the new more specific item type. Look at the surrounding items for context. You must produce the correct element_id. And you must produce a new type for every item.
      
      Some helpful guidance:
      - Usually, text item starting with a superscript number is an endnote.
      - Text item in smaller font or seperate from the content of the page are usually footnotes.
      - It is possible that some code parts can be labeled as Title, please convert it to the correct code or algorithm type.
      - Always map existing Image types to figure_image or non_figure_image or code_or_algorithm. If it is a minor image with meta content, it is a non_figure_image otherwise it is almost always a figure_image. If it contains code it is a code_or_algorithm.
      `;
      const typeConversionSchema = z.object({
        itemsWithNewTypes: z.array(
          z.object({
            element_id: z.string(),
            old_type: z.string(),
            new_type: z.enum([
              "main_title",
              "author_info",
              "text",
              "heading",
              "figure_image",
              "table_rows",
              "abstract_content",
              "abstract_heading",
              "out_of_text_math",
              "math_equation_number",
              "code_or_algorithm",
              "end_marker",
              "acknowledgements_heading",
              "references_heading",
              "references_item",
              "endnotes_item",
              "endnotes_heading",
              "JEL_classification",
              "CCS_concepts",
              "keywords",
              "acknowledgements_content",
              "references_format_information",
              "footnotes",
              "meta_info",
              "publisher_info",
              "non_figure_image",
              "figure_heading",
              "figure_caption",
              "figure_note",
              "table_descrption",
              "table_heading",
              "table_notes",
              "author_info",
              "page_number",
              "table_of_contents_heading",
              "table_of_contents_item",
            ]),
          })
        ),
      });

      for (let i = 0; i < pngPages.length; i += TYPE_CONVERSION_CONCURRENCY) {
        const batch = pngPages.slice(i, i + TYPE_CONVERSION_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (pngPage, index) => {
            console.log("Type conversion for page ", i + index + 1);
            const initialItemsPage = initialItemsByPage[index + i + 1];
            const batchResult = await getStructuredOpenAICompletionWithRetries(
              runId,
              TYPE_CONVERSION_SYSTEM_PROMPT,
              `${JSON.stringify(initialItemsPage, null, 2)}`,
              TYPE_CONVERSION_MODEL,
              TYPE_CONVERSION_TEMPERATURE,
              typeConversionSchema,
              3,
              [pngPage.path],
              16384
            );
            const itemTypeConversionMap: {
              element_id: string;
              old_type: string;
              new_type: string;
            }[] = batchResult?.itemsWithNewTypes;
            itemTypeConversionMap.map((typeMap) => {
              const oldItem = initialItemsPage.find(
                (initialItem) => initialItem.element_id === typeMap.element_id
              );
              if (oldItem) {
                oldItem.new_type = typeMap.new_type;
              }
            });

            console.log("Type converted page ", i + index + 1);
          })
        );
      }

      // console.log("LLM PASS: Fixing the extracted item order");
      // const ORDER_CORRECTION_CONCURRENCY = 20;
      // const ORDER_CORRECTION_MODEL: Model = "gpt-4o-2024-08-06";
      // const ORDER_CORRECTION_TEMPERATURE = 0.4;
      // const ORDER_CORRECTION_SYSTEM_PROMPT = `Use the provided image and your best judgement to assign an item order starting from 0 to each item.

      // For papers with multiple columns, you must start ordering from the top left and then move down the column and then move to the top of the next column. Please look at all the items before ordering them.

      // Note that a heading does not need to be the first item in a page. It is possible that paragraphs from the previous page can continue into the current page. In that case, you should start from them. Always start from the top left.

      // Note that in the first page of the paper, the title and author info come first, followed by the abstract (if any) and then the rest of the paper follows.`;
      // const orderCorrectionSchema = z.object({
      //   itemsWithCorrectedOrder: z.array(
      //     z.object({
      //       element_id: z.string(),
      //       item_order: z.number(),
      //     })
      //   ),
      // });

      // for (let i = 0; i < pngPages.length; i += ORDER_CORRECTION_CONCURRENCY) {
      //   const batch = pngPages.slice(i, i + ORDER_CORRECTION_CONCURRENCY);
      //   const batchResults = await Promise.all(
      //     batch.map(async (pngPage, index) => {
      //       console.log("Order correction for page ", i + index + 1);
      //       const initialItemsPage = initialItemsByPage[index + i + 1];
      //       const batchResult = await getStructuredOpenAICompletionWithRetries(
      //         runId,
      //         ORDER_CORRECTION_SYSTEM_PROMPT,
      //         `${JSON.stringify(initialItemsPage, null, 2)}`,
      //         ORDER_CORRECTION_MODEL,
      //         ORDER_CORRECTION_TEMPERATURE,
      //         orderCorrectionSchema,
      //         3,
      //         [pngPage.path],
      //         16384
      //       );
      //       const itemOrderCorrectionMap: {
      //         element_id: string;
      //         item_order: number;
      //       }[] = batchResult?.itemsWithCorrectedOrder;
      //       itemOrderCorrectionMap.map((orderMap) => {
      //         const oldItem = initialItemsPage.find(
      //           (initialItem) => initialItem.element_id === orderMap.element_id
      //         );
      //         if (oldItem) {
      //           oldItem.item_order = orderMap.item_order;
      //         }
      //       });

      //       console.log("Order corrected page ", i + index + 1);
      //     })
      //   );
      // }

      // //sorting items by the generated order
      // Object.keys(initialItemsByPage).forEach((pageNumber) => {
      //   initialItemsByPage[parseInt(pageNumber)].sort(
      //     (a, b) => (a.item_order || 0) - (b.item_order || 0)
      //   );
      // });

      //flattening the grouped-by-page items
      const flattenedItems = Object.values(initialItemsByPage).flat();

      //creating the new simplfied item array
      for (const item of flattenedItems) {
        parsedItems.push({
          type: item.new_type || "",
          page: item.metadata.page_number,
          pageSpan: [item.metadata.page_number],
          content: item.text,
        });
      }

      //Author Info and Main Title Extraction
      console.log("LLM PASS: Collecting author info and extracting main title");
      const PAGES_TO_ANALYZE = 5;
      const AUTHOR_INFO_AND_MAIN_TITLE_EXTRACTION_MODEL: Model =
        "gpt-4o-2024-08-06";
      const AUTHOR_INFO_AND_MAIN_TITLE_EXTRACTION_TEMPERATURE = 0.2;
      const AUTHOR_INFO_AND_MAIN_TITLE_EXTRACTION_PROMPT = `Extract all the author info and the main title of the document.

      For main title: Use your judgement to accurately determine the main title.
      
      For author info: Keep only the author names and affiliations. If the affiliation is not available for a user leave it empty. Do not repeat the same author or affiliation multiple times.`;

      const authorInfoAndMainTitleExtractionSchema = z.object({
        mainTitle: z.string(),
        authors: z.array(
          z.object({
            authorName: z.string(),
            affiliation: z.string(),
          })
        ),
      });

      const improvedAuthorInfoAndExtractedTitle =
        await getStructuredOpenAICompletionWithRetries(
          runId,
          AUTHOR_INFO_AND_MAIN_TITLE_EXTRACTION_PROMPT,
          `Here are the first ${PAGES_TO_ANALYZE} pages of the document:`,
          AUTHOR_INFO_AND_MAIN_TITLE_EXTRACTION_MODEL,
          AUTHOR_INFO_AND_MAIN_TITLE_EXTRACTION_TEMPERATURE,
          authorInfoAndMainTitleExtractionSchema,
          3,
          pngPages.slice(0, PAGES_TO_ANALYZE).map((page) => page.path)
        );

      extractedTitle =
        improvedAuthorInfoAndExtractedTitle?.mainTitle || "NoTitleDetected";

      const firstAuthorInfoIndex = parsedItems.findIndex(
        (item) => item.type === "author_info"
      );

      if (firstAuthorInfoIndex !== -1) {
        const authors = improvedAuthorInfoAndExtractedTitle?.authors || [];
        const totalAuthors = authors.length;
        const MAX_AUTHORS = 5;
        const authorGroups: { [affiliation: string]: string[] } = {};

        // Group authors by affiliation
        authors
          .slice(0, MAX_AUTHORS)
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
        if (totalAuthors > MAX_AUTHORS) {
          compiledAuthorInfo = `There are ${totalAuthors} authors, including ${compiledAuthorInfo}`;
        }

        parsedItems[firstAuthorInfoIndex].type = "improved_author_info";
        parsedItems[firstAuthorInfoIndex].content = compiledAuthorInfo;
      }

      //Inserting end marker
      console.log("CODE PASS: inserting end marker");
      // Find the last references_heading index
      let lastReferencesHeadingIndex = -1;
      for (let i = parsedItems.length - 1; i >= 0; i--) {
        if (parsedItems[i].type === "references_heading") {
          lastReferencesHeadingIndex = i;
          break;
        }
      }

      // Update the type of all but the final references heading
      for (let i = 0; i < parsedItems.length; i++) {
        if (
          parsedItems[i].type === "references_heading" &&
          i !== lastReferencesHeadingIndex
        ) {
          parsedItems[i].type = "stray_references_heading";
        }
      }

      // Find the last references_heading or references_item
      let conclusionInsertionIndex = -1;
      let conclusionInsertionPage = 0;
      for (let i = parsedItems.length - 1; i >= 0; i--) {
        if (
          parsedItems[i].type === "references_heading" ||
          parsedItems[i].type === "references_item"
        ) {
          conclusionInsertionIndex = i;
          conclusionInsertionPage = parsedItems[i].page;
          break;
        }
      }

      // Insert the message if a suitable insertion point was found
      if (conclusionInsertionIndex !== -1) {
        parsedItems.splice(conclusionInsertionIndex + 1, 0, {
          type: "end_marker",
          content: "[break0.4]You have reached the end of the paper.[break0.4]",
          page: conclusionInsertionPage,
        });
      }

      const parsedItemsPath = path.join(fileNameDir, "parsedItems.json");
      fs.writeFileSync(parsedItemsPath, JSON.stringify(parsedItems, null, 2));
      console.log("Saved raw text extract to", parsedItemsPath);

      // Filtering, summarizing and other postprocessing steps---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      console.log("CODE PASS: Filtering unnecessary item types");
      filteredItems = parsedItems.filter((item) =>
        [
          "main_title",
          "improved_author_info",
          "abstract_heading",
          "abstract_content",
          "heading",
          "text",
          "code_or_algorithm",
          "figure_image",
          "table_rows",
          "out_of_text_math",
          "end_marker",
        ].includes(item.type)
      );

      const endMarkerIndex = filteredItems.findIndex(
        (item) => item.type === "end_marker"
      );

      if (endMarkerIndex !== -1 && endMarkerIndex < filteredItems.length - 1) {
        filteredItems[endMarkerIndex].content =
          "[break0.4]You have reached the end of the main paper. Appendix sections follow.[break0.4]";
      }

      // console.log("CODE PASS: Combining consecutive code_or_algorithm items");
      // const combinedItems: Item[] = [];
      // let previousItem: Item | null = null;

      // for (const item of filteredItems) {
      //   if (
      //     item.type === "code_or_algorithm" &&
      //     previousItem?.type === "code_or_algorithm"
      //   ) {
      //     // Combine content with the previous item
      //     previousItem.content += `\n${item.content}`;
      //     // Merge pageSpan
      //     if (previousItem.pageSpan && item.pageSpan) {
      //       previousItem.pageSpan = Array.from(
      //         new Set([...previousItem.pageSpan, ...item.pageSpan])
      //       );
      //     }
      //   } else {
      //     // Push the previous item to combinedItems if it's not null
      //     if (previousItem) {
      //       combinedItems.push(previousItem);
      //     }
      //     // Update previousItem to the current item
      //     previousItem = item;
      //   }
      // }
      // // Push the last item if it exists
      // if (previousItem) {
      //   combinedItems.push(previousItem);
      // }
      // // Replace filteredItems with combinedItems
      // filteredItems = combinedItems;

      //Detecting special items from the images
      console.log("LLM PASS: Labeling special items.");

      const itemsToBeLabeled = filteredItems.filter((item) =>
        ["figure_image", "table_rows", "code_or_algorithm"].includes(item.type)
      );

      const SPECIAL_ITEM_LABELING_CONCURRENCY = 20;
      const SPECIAL_ITEM_LABELING_MODEL: Model = "gpt-4o-2024-08-06";
      const SPECIAL_ITEM_LABELING_TEMPERATURE = 0.5;
      const SPECIAL_ITEM_LABELING_SYSTEM_PROMPT = `Accurately label the given item. First look for the item in the page image. Then carefully determine the label type and number by looking at the page. You must extract the correct label type and label number. Look for cues around the item and use your best judgement to determine it.
    
      If there is no label or label number or panel number set the labelType as "" and labelNumber as "unlabeled" and panelNumber as "unlabeled".
      
      It is very important that you do not label an item that does not have a label in the document.`;

      const specialItemLabelingSchema = z.object({
        label: z.object({
          labelType: z.string(),
          labelNumber: z.string(),
          panelNumber: z.string(),
        }),
      });

      for (
        let i = 0;
        i < itemsToBeLabeled.length;
        i += SPECIAL_ITEM_LABELING_CONCURRENCY
      ) {
        const itemBatch = itemsToBeLabeled.slice(
          i,
          i + SPECIAL_ITEM_LABELING_CONCURRENCY
        );

        console.log(
          `Labeling special items in pages ${i + 1} through ${
            i + SPECIAL_ITEM_LABELING_CONCURRENCY
          }`
        );

        await Promise.all(
          itemBatch.map(async (item, index) => {
            try {
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                SPECIAL_ITEM_LABELING_SYSTEM_PROMPT,
                `Item to label:${JSON.stringify(item, null, 2)}\n\nPage:`,
                SPECIAL_ITEM_LABELING_MODEL,
                SPECIAL_ITEM_LABELING_TEMPERATURE,
                specialItemLabelingSchema,
                3,
                [pngPages[item.page - 1].path]
              );

              const label: {
                labelType: string;
                labelNumber: string;
                panelNumber: string;
              } = result?.label;

              if (label) {
                item.label = label;
                item.labelString = `${
                  label.labelType !== "" ? label.labelType : ""
                }${
                  !["unlabeled", ""].includes(
                    label.labelNumber.toLocaleLowerCase()
                  )
                    ? ` ${label.labelNumber}`
                    : ""
                }`;
              }
            } catch (error) {
              console.error(
                "Non fatal error while detecting special items:",
                error
              );
            }
          })
        );
      }

      // Merging items with the same labelString
      console.log("CODE PASS: Merging items with the same labelString");

      const mergeableTypes = [
        "figure_image",
        "table_rows",
        "code_or_algorithm",
      ];

      const mergedItems: Item[] = [];
      const labelStringMap: Record<string, Item> = {};

      try {
        filteredItems.forEach((item) => {
          if (
            mergeableTypes.includes(item.type) &&
            item.labelString &&
            item.labelString.trim() !== ""
          ) {
            const labelKey = item.labelString.toLocaleLowerCase();
            if (labelStringMap[labelKey]) {
              // Merge content with the existing item
              console.log("Deduplicating ", item.labelString);
              labelStringMap[labelKey].content += `\n${item.content}`;
              // Merge pageSpan
              if (labelStringMap[labelKey].pageSpan) {
                labelStringMap[labelKey].pageSpan = Array.from(
                  new Set([...labelStringMap[labelKey].pageSpan, item.page])
                );
              }
              // Set panelNumber to an empty string
              labelStringMap[labelKey].label!.panelNumber = "";
            } else {
              // Add the item to the map
              labelStringMap[labelKey] = {
                ...item,
                pageSpan: [item.page], // Initialize pageSpan with the current page
              };
              mergedItems.push(labelStringMap[labelKey]);
            }
          } else {
            // Add non-mergeable items directly
            mergedItems.push(item);
          }
        });

        // Replace filteredItems with mergedItems
        filteredItems = mergedItems;
      } catch (error) {
        console.error(
          "Non fatal error while deduplicating special items",
          error
        );
      }

      //Summarizing special items
      console.log("LLM PASS: Summarizing special items");
      const SUMMARIZATION_CONCURRENCY = 20;
      const summarizationSchema = z.object({
        summarizedItem: z.object({
          type: z.enum(["figure_image", "table_rows", "code_or_algorithm"]),
          summary: z.string(),
        }),
      });

      const TABLE_SUMMARIZATION_MODEL: Model = "gpt-4o-2024-08-06";
      const TABLE_SUMMARIZATION_TEMPERATURE = 0.2;
      const TABLE_SUMMARIZATION_SYSTEM_PROMPT = `Write a concise and effective summary for the table. Replace the raw rows in the content field with the summary. Summarize the size of changes / effects / estimates / results in the tables. Be very accurate while doing this analysis. You must get the patterns correct. To help understand them better, use context from the paper and any note below them. The summary should capture the main point of the table. Try to use as few numbers as possible. Keep in mind that the user cannot see the table as they will be listening to your summary.

      If the table has multiple subitems, use the terminology that the author uses for them like "panel" or "part" if available otherwise use your own terminology to help the listener understand the table's structure. Then describe each subitem contents and draw inferences/conclusiosn from them.

      Do not use markdown. Use plain text.`;

      const FIGURE_SUMMARIZATION_MODEL: Model = "gpt-4o-2024-08-06";
      const FIGURE_SUMMARIZATION_TEMPERATURE = 0.3;
      const FIGURE_SUMMARIZATION_SYSTEM_PROMPT = `Write a detailed and effective summary for the figures. Replace the content field with the summary.

      Every summary must have three subsections:
      1. Physical description of the structure of the image
      2. Description of the content of the figure
      3. Accurate inferences and conclusions from the content of the figure.

      No need to explicitly mention each subsection.

      Do not use markdown. Use plain text.

      If the figure has multiple subitems, use the terminology that the author uses for them like "panel" or "part" if available otherwise use your own terminology to help the listener understand the figure's structure. Then describe each subitem contents and draw inferences/conclusiosn from them.

      The user cannot see the picture as they will be listening to the summary, so you must describe the image in sufficient detail before drawing inferences.`;
      const FIGURE_SUMMARIZATION_EXAMPLES = [
        {
          userImage: "./src/prompt/figures/AIAYN_FIG_1.png",
          assistantOutput: `{
                            type: "figure_image",
                            summary: "This figure is a diagram of the transformer model’s architecture, showing the steps take input tokens and produce output probabilities.  It has two components.  The left side is the encoder which begins with inputs, and the right side is the decoder which begins with outputs that are shifted right.  On the encoder side, first the input tokens are transformed into embeddings, which are then added to positional embeddings.  Then, there are 6 identical layers which include first a multi-head attention step, then a feed forward network. On the decoder side, the first steps are the same.  The input tokens are transformed into embeddings with positional embeddings added next.  Then, there are also 6 identical layers which are similar to this part of the encoder, but with an extra step.  The first step is masked multi-head attention, followed by multi-head attention over the output of the encoder stack.  Next comes the feed forward layer, just like in the encoder.  Finally, the last steps are a linear projection layer, and a softmax step which produces output probabilities."
                          }`,
        },
        {
          userImage: "./src/prompt/figures/ALHGALW_FIG_2.png",
          assistantOutput: `{
                            type: "figure_image",
                            summary: "This figure plots the fraction of correct next-token predictions for 4 language models during training on a subset of the Pile training set, as a function of the number of training steps.  The four models are: SLM, Baseline, RKD and SALT.  Over the 200K steps shown, accuracy increases from around 55% to 58-60% after 200K steps, with increases slowing down as steps increase.  SALT outperforms baseline slightly for any number of steps, whereas SLM performs worse.  RKD performs better than baseline at first, but after around 75 thousand steps, begins to perform worse."
                          }`,
        },
        {
          userImage: "./src/prompt/figures/COCD_FIG_1.png",
          assistantOutput: `{
                            type: "figure_image",
                            summary: "This figure plots settler mortality against GDP per capita adjusted for purchasing power parity, both on a log scale.  Each data point is a country and a downward sloping line represents the strong negative correlation.  Data points are generally close to the line, with a few outliers."
                          }`,
        },
        {
          userImage: "./src/prompt/figures/TYE_FIG_2.png",
          assistantOutput: `{
                            type: "figure_image",
                            summary: "This figure shows cognitive outcome scores over 10 years.  It has 3 panels, each showing a different outcome for each of the four arms of the experiment, treatments for memory, reasoning, and speed, along with the control group.  The outcomes are scores for memory, reasoning and speed.  Each panel shows that the treatment associated with the each outcome resulted in larger increases in the score for that outcome, especially so for speed.  Each score for each treatment generally increase within the first year, peaks, and then declines after 3 years, especially between years 5 and 10."
                          }`,
        },
        {
          userImage: "./src/prompt/figures/TYE_FIG_3.png",
          assistantOutput: `{
                            type: "figure_image",
                            summary: "This figure plots self-reported IADL scores over 10 years for each of the 4 experimental groups, the 3 treatments, memory, reasoning, speed, as well as the control group. All groups have similar, roughly flat IADL scores for the first 3 years, which decline after.  In years 5 and 10, the control group’s scores are substantially lower than each of the treatments."
                          }`,
        },
      ];

      const CODE_SUMMARIZATION_MODEL: Model = "gpt-4o-2024-08-06";
      const CODE_SUMMARIZATION_TEMPERATURE = 0.2;
      const CODE_SUMMARIZATION_SYSTEM_PROMPT = `Summarize the given code or algorithm. Explain what the code or algorithm does in simple terms including its input and output. Do not include any code syntax in the summary.`;

      const itemsToBeSummarized = filteredItems.filter((item) =>
        ["figure_image", "table_rows", "code_or_algorithm"].includes(item.type)
      );

      const summarizationMap: Record<
        string,
        {
          model: string;
          temperature: number;
          systemPrompt: string;
          examples: any[];
        }
      > = {
        figure_image: {
          model: FIGURE_SUMMARIZATION_MODEL,
          temperature: FIGURE_SUMMARIZATION_TEMPERATURE,
          systemPrompt: FIGURE_SUMMARIZATION_SYSTEM_PROMPT,
          examples: FIGURE_SUMMARIZATION_EXAMPLES,
        },
        table_rows: {
          model: TABLE_SUMMARIZATION_MODEL,
          temperature: TABLE_SUMMARIZATION_TEMPERATURE,
          systemPrompt: TABLE_SUMMARIZATION_SYSTEM_PROMPT,
          examples: [],
        },
        code_or_algorithm: {
          model: CODE_SUMMARIZATION_MODEL,
          temperature: CODE_SUMMARIZATION_TEMPERATURE,
          systemPrompt: CODE_SUMMARIZATION_SYSTEM_PROMPT,
          examples: [],
        },
      };

      for (
        let i = 0;
        i < itemsToBeSummarized.length;
        i += SUMMARIZATION_CONCURRENCY
      ) {
        const itemBatch = itemsToBeSummarized.slice(
          i,
          i + SUMMARIZATION_CONCURRENCY
        );

        console.log(
          `Summarizing items ${i + 1} through ${i + SUMMARIZATION_CONCURRENCY}`
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            try {
              console.log(`Summarizing ${item.type} on page ${item.page}`);
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                summarizationMap[item.type].systemPrompt,
                `Item to summarize: ${JSON.stringify(item)}`,
                summarizationMap[item.type].model,
                summarizationMap[item.type].temperature,
                summarizationSchema,
                3,
                item.pageSpan
                  ? item.pageSpan.map((page) => pngPages[page - 1].path)
                  : [pngPages[item.page - 1].path],
                16384,
                0.1,
                summarizationMap[item.type].examples
              );

              if (item.labelString) {
                item.content = `${item.labelString} summary: ${result?.summarizedItem.summary}`;
              } else {
                item.content = result?.summarizedItem.summary;
              }
            } catch (error) {
              console.error(
                "Non fatal error while summarizing special items:",
                error
              );
            }
          })
        );
      }
      // console.log("LLM PASS: Detecting illegible items");

      // const ILLEGIBILITY_DETECTION_CONCURRENCY = 20;
      // const ILLEGIBILITY_DETECTION_MODEL: Model = "gpt-4o-2024-08-06";
      // const ILLEGIBILITY_DETECTION_TEMPERATURE = 0.3;
      // const ILLEGIBILITY_DETECTION_SYSTEM_PROMPT = `Analyze the following item and determine if it is illegible. An item is illegible if it the text content does not make any sense in the context.

      // Be very conservative while classifying an item as illegible. Only do so if you are sure the item makes no sense in the context.

      // It is okay if an item has start or end cut off. Do not use that as a reason to classify an item as illegible.`;

      // const illegibilityDetectionSchema = z.object({
      //   isIllegible: z.boolean(),
      // });

      // const itemsToBeCheckedForIllegibility = filteredItems.filter((item) =>
      //   ["text", "abstract_content", "heading"].includes(item.type)
      // );

      // for (
      //   let i = 0;
      //   i < itemsToBeCheckedForIllegibility.length;
      //   i += ILLEGIBILITY_DETECTION_CONCURRENCY
      // ) {
      //   const itemBatch = itemsToBeCheckedForIllegibility.slice(
      //     i,
      //     i + ILLEGIBILITY_DETECTION_CONCURRENCY
      //   );

      //   console.log(
      //     `Checking illegibility for items ${i + 1} through ${
      //       i + ILLEGIBILITY_DETECTION_CONCURRENCY
      //     }`
      //   );

      //   await Promise.all(
      //     itemBatch.map(async (item) => {
      //       try {
      //         const currentIndex = filteredItems.indexOf(item);
      //         const contextItems = filteredItems.slice(
      //           Math.max(0, currentIndex - 5),
      //           Math.min(filteredItems.length, currentIndex + 6)
      //         );
      //         const result = await getStructuredOpenAICompletionWithRetries(
      //           runId,
      //           ILLEGIBILITY_DETECTION_SYSTEM_PROMPT,
      //           `Item:\n${JSON.stringify(item)}\n\nContext:\n${JSON.stringify(
      //             contextItems
      //           )}`,
      //           ILLEGIBILITY_DETECTION_MODEL,
      //           ILLEGIBILITY_DETECTION_TEMPERATURE,
      //           illegibilityDetectionSchema,
      //           3
      //         );

      //         item.isIllegible = result?.isIllegible;
      //       } catch (error) {
      //         console.error(
      //           "Non fatal error while detecting illegible items:",
      //           error
      //         );
      //       }
      //     })
      //   );
      // }

      //Tagging items for postpreprocessing
      console.log("LLM PASS: Tagging items for postprocessing");

      const POSTPROCESSING_TAGGING_CONCURRENCY = 20;
      const POSTPROCESSING_TAGGING_MODEL: Model = "gpt-4o-2024-08-06";
      const POSTPROCESSING_TAGGING_TEMPERATURE = 0.2;
      const POSTPROCESSING_TAGGING_SYSTEM_PROMPT = `Analyze the following text and
      
      1. Determine the frequency of complex math symbols and numbers. Provide a score between 0 and 5, where 0 means no complex math symbols and numbers and 5 means a high frequency of complex math symbols and numbers.
      2. Determine if the text contains citations to other papers. Ignore citations to figures or images in this paper.
      3. Determine if the text contains many hyphenated words.`;

      const postProcessingTaggingSchema = z.object({
        mathSymbolFrequency: z.number(),
        hasCitations: z.boolean(),
        hasHyphenatedWords: z.boolean(),
      });

      const itemsThatShouldBeTagged = filteredItems.filter((item) =>
        [
          "text",
          "abstract_content",
          "out_of_text_math",
          "figure_image",
          "table_rows",
        ].includes(item.type)
      );

      for (
        let i = 0;
        i < itemsThatShouldBeTagged.length;
        i += POSTPROCESSING_TAGGING_CONCURRENCY
      ) {
        const itemBatch = itemsThatShouldBeTagged.slice(
          i,
          i + POSTPROCESSING_TAGGING_CONCURRENCY
        );

        console.log(
          `Tagging items ${i + 1} through ${
            i + POSTPROCESSING_TAGGING_CONCURRENCY
          }`
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            try {
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                POSTPROCESSING_TAGGING_SYSTEM_PROMPT,
                `Text:\n${item.content}`,
                POSTPROCESSING_TAGGING_MODEL,
                POSTPROCESSING_TAGGING_TEMPERATURE,
                postProcessingTaggingSchema,
                3
              );

              item.mathSymbolFrequency = result?.mathSymbolFrequency;
              item.hasCitations = result?.hasCitations;
              item.hasHyphenatedWords = result?.hasHyphenatedWords;
            } catch (error) {
              console.error(
                "Non fatal error while tagging items for postprocessing:",
                error
              );
            }
          })
        );
      }

      //Removing Citations
      console.log("LLM PASS: optimizing citations");
      const CITATION_OPTIMIZATION_CONCURRENCY = 20;
      const CITATION_OPTIMIZATION_MODEL: Model = "gpt-4o-2024-08-06";
      const CITATION_OPTIMIZATION_TEMPERATURE = 0.2;
      const CITATION_OPTIMIZATION_SYSTEM_PROMPT = `Remove citations elements from the user text.
      
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

      const citationOptimizationSchema = z.object({
        originalText: z.string(),
        textWithCitationsRemoved: z.string(),
      });

      const itemsWithCitations = filteredItems.filter(
        (item) => item.hasCitations && item.type === "text"
      );

      for (
        let i = 0;
        i < itemsWithCitations.length;
        i += CITATION_OPTIMIZATION_CONCURRENCY
      ) {
        const itemBatch = itemsWithCitations.slice(
          i,
          i + CITATION_OPTIMIZATION_CONCURRENCY
        );

        console.log(
          `Optimizing citations for items ${i + 1} through ${
            i + CITATION_OPTIMIZATION_CONCURRENCY
          }`
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            try {
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                CITATION_OPTIMIZATION_SYSTEM_PROMPT,
                `Text:\n${item.content}`,
                CITATION_OPTIMIZATION_MODEL,
                CITATION_OPTIMIZATION_TEMPERATURE,
                citationOptimizationSchema,
                3,
                [],
                16384
              );
              item.citationReplacement = {
                originalText: result?.originalText,
                textWithCitationsRemoved: result?.textWithCitationsRemoved,
              };

              if (result?.textWithCitationsRemoved) {
                item.content = result?.textWithCitationsRemoved;
              }
            } catch (error) {
              console.error(
                "Non fatal error while optimizing citations:",
                error
              );
            }
          })
        );
      }

      //Rewording math notation
      console.log("LLM PASS: optimizing math");
      const MATH_OPTIMIZATION_CONCURRENCY = 20;
      const MATH_OPTIMIZATION_MODEL: Model = "gpt-4o-2024-08-06";
      const MATH_OPTIMIZATION_TEMPERATURE = 0;
      const MATH_OPTIMIZATION_SYSTEM_PROMPT = `The following text will be converted to audio for the user to listen to. Replace math notation and all LaTeX formatting with plain english words to make it more suitable for that purpose. Convert accurately. 
      
      Some examples includes changing "+" to "plus" and inserting a "times" when multiplication is implied. Use your best judgment to make the text as pleasant for audio as possible.
      
      Only convert math notation, do not alter the rest of the text. Return the entire original text and the worded replacement.`;

      const mathOptimizationSchema = z.object({
        originalText: z.string(),
        wordedReplacement: z.string(),
      });

      const itemsWithComplexMath = filteredItems.filter(
        (item) =>
          item.mathSymbolFrequency &&
          item.mathSymbolFrequency > 0 &&
          ["text", "abstract_content", "out_of_text_math"].includes(item.type)
      );

      for (
        let i = 0;
        i < itemsWithComplexMath.length;
        i += MATH_OPTIMIZATION_CONCURRENCY
      ) {
        const itemBatch = itemsWithComplexMath.slice(
          i,
          i + MATH_OPTIMIZATION_CONCURRENCY
        );

        console.log(
          `Optimzing math for items ${i + 1} through ${
            i + MATH_OPTIMIZATION_CONCURRENCY
          }`
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            try {
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                MATH_OPTIMIZATION_SYSTEM_PROMPT,
                `Text:\n${item.content}`,
                MATH_OPTIMIZATION_MODEL,
                MATH_OPTIMIZATION_TEMPERATURE,
                mathOptimizationSchema,
                3,
                [],
                16384,
                0.1
              );
              item.mathReplacement = {
                originalText: result?.originalText,
                wordedReplacement: result?.wordedReplacement,
              };

              if (result?.wordedReplacement) {
                item.content = result?.wordedReplacement;
              }
            } catch (error) {
              console.error("Non fatal error while optimizing math:", error);
            }
          })
        );
      }

      // Add a new pass for processing hyphenated words
      console.log("LLM PASS: optimizing hyphenated words");
      const HYPHENATION_OPTIMIZATION_CONCURRENCY = 20;
      const HYPHENATION_OPTIMIZATION_MODEL: Model = "gpt-4o-2024-08-06";
      const HYPHENATION_OPTIMIZATION_TEMPERATURE = 0.2;
      const HYPHENATION_OPTIMIZATION_SYSTEM_PROMPT = `Remove hyphens from words in the text where appropriate. Join the words if both parts are in the text. If only one part is in the tex, then remove the hyphen and keep the word as it is without completing it. Return the original text and the text with hyphens removed.`;

      const hyphenationReplacementSchema = z.object({
        originalText: z.string(),
        textWithHyphensRemoved: z.string(),
      });

      // Filter items that have hyphenated words
      const itemsWithHyphenatedWords = filteredItems.filter(
        (item) =>
          item.hasHyphenatedWords &&
          ["abstract_content", "text"].includes(item.type)
      );

      for (
        let i = 0;
        i < itemsWithHyphenatedWords.length;
        i += HYPHENATION_OPTIMIZATION_CONCURRENCY
      ) {
        const itemBatch = itemsWithHyphenatedWords.slice(
          i,
          i + HYPHENATION_OPTIMIZATION_CONCURRENCY
        );

        console.log(
          `Optimizing hyphenated words for items ${i + 1} through ${
            i + HYPHENATION_OPTIMIZATION_CONCURRENCY
          }`
        );

        await Promise.all(
          itemBatch.map(async (item) => {
            try {
              const result = await getStructuredOpenAICompletionWithRetries(
                runId,
                HYPHENATION_OPTIMIZATION_SYSTEM_PROMPT,
                `Text:\n${item.content}`,
                HYPHENATION_OPTIMIZATION_MODEL,
                HYPHENATION_OPTIMIZATION_TEMPERATURE,
                hyphenationReplacementSchema,
                3,
                [],
                16384
              );
              item.hyphenationReplacement = {
                originalText: result?.originalText,
                textWithHyphensRemoved: result?.textWithHyphensRemoved,
              };

              if (result?.textWithHyphensRemoved) {
                item.content = result?.textWithHyphensRemoved;
              }
            } catch (error) {
              console.error(
                "Non fatal error while optimizing hyphenated words:",
                error
              );
            }
          })
        );
      }

      console.log("CODE PASS: Collapse consecutive letters");
      filteredItems.forEach((item) => {
        item.content = collapseConsecutiveLetters(item.content);
      });

      console.log("CODE PASS: Optimzing known abbreviations");
      const specialAbbreviations: Abbreviation[] = [
        {
          abbreviation: "CI",
          replacement: "C.I.",
          type: "initialism",
          expansion: "confidence interval",
        },
      ];

      filteredItems.forEach((item) => {
        item.content = replaceAbbreviations(item.content, specialAbbreviations);
      });

      console.log("CODE PASS: Tagging items with start and end cut off");
      //Tagging items with end and start cut off
      filteredItems.forEach((item) => {
        if (["abstract_content", "text"].includes(item.type)) {
          const { isStartCutOff, isEndCutOff } = isTextCutoff(item.content);
          item.isStartCutOff = isStartCutOff;
          item.isEndCutOff = isEndCutOff;
        }
      });

      //Repositioning Special Items
      console.log("CODE PASS: Repositioning summarized items");
      const itemsTobeRepositioned = filteredItems.filter((item) =>
        ["figure_image", "table_rows", "code_or_algorithm"].includes(item.type)
      );

      for (const item of itemsTobeRepositioned) {
        if (item.repositioned || !item.label) {
          continue;
        }

        const { labelType, labelNumber } = item.label;
        console.log("repositioning ", labelType, " ", labelNumber);
        let mentionIndex = -1;
        let headingIndex = -1;
        let textWithoutEndCutoffIndex = -1;

        if (labelNumber !== "unlabeled" && labelNumber !== "") {
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

      console.log("CODE PASS: Adding small breaks where necessary");
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

      const filteredItemsPath = path.join(fileNameDir, "filteredItems.json");
      fs.writeFileSync(
        filteredItemsPath,
        JSON.stringify(filteredItems, null, 2)
      );
      console.log("Saved filtered items to", filteredItemsPath);

      // S3 upload, Audio Generation and Other stuff---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      return;

      const initialItemsFileName = `${cleanedFileName}-initialItems.json`;
      const parsedItemsFileName = `${cleanedFileName}-parsedItems.json`;
      const filteredItemsFileName = `${cleanedFileName}-filteredItems.json`;

      const initialItemsFilePath = `${userBucketName}/${initialItemsFileName}`;
      const parsedItemsFilePath = `${userBucketName}/${parsedItemsFileName}`;
      const filteredItemsFilePath = `${userBucketName}/${filteredItemsFileName}`;

      const initialItemsFileUrl = await uploadFile(
        fs.readFileSync(initialItemsPath),
        initialItemsFilePath
      );

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
