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
import { getStructuredOpenAICompletionWithRetries } from "@utils/openai";
import { isTextCutoff } from "@utils/text";
import { removeBreaks } from "@utils/ssml";
import { processUnstructuredBuffer } from "@utils/unstructured";

const { db } = getDB();

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  //API RECEPTION----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { summarizationMethod, email, fileName, sendEmailToUser, link } =
    request.query;

  const shouldSendEmailToUser = sendEmailToUser === "true";

  let fileBuffer: Buffer;
  let cleanedFileName: string;

  const runId = uuidv4();
  const receivedTime = getCurrentTimestamp();

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

  uploadStatus(runId, "Received", {
    message: "Request received",
    receivedTime: receivedTime,
  });

  //PREPROCESSING-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

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
        errorType: "InvalidLink",
        message: "Failed to download PDF from link",
        receivedTime: receivedTime,
        errorTime: errorTime,
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
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      errorType: "FileSizeExceeded",
      message: "File size exceeds 100MB which is currently not supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
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
      viewportScale: 4.0,
      outputFolder: tempImageDir,
    });
  } catch (error) {
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      errorType: "InvalidPDFFormat",
      message: "File has invalid format",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
    });
    sendErrorEmail(email, cleanedFileName, runId);
    return;
  }

  if (pngPagesOriginal.length > 100) {
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      errorType: "FileNumberOfPagesExceeded",
      message: "pdf has more than 100 pages which is not currently supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
    });
    sendErrorEmail(email, cleanedFileName, runId);
    return;
  }

  const startedProcessingTime = getCurrentTimestamp();
  uploadStatus(runId, "Processing", {
    message: "Started processing",
    uploadedFileUrl: s3pdfFilePath,
    receivedTime: receivedTime,
    startedProcessingTime: startedProcessingTime,
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

      console.log("PASS 1: Using unstructured to get initial JSON");
      initialItems = await processUnstructuredBuffer(
        fileBuffer,
        `${cleanedFileName}.pdf`
      );

      //Grouping items by page
      const initialItemsByPage: Record<number, UnstructuredItem[]> =
        initialItems
          .filter(
            (item) => !["PageNumber", "Header", "Footer"].includes(item.type)
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

      // Type conversion and summarization steps---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      console.log("PASS 2: Converting unstructured types to our custom types");
      const TYPE_CONVERSION_CONCURRENCY = 20;
      const TYPE_CONVERSION_MODEL: Model = "gpt-4o-2024-08-06";
      const TYPE_CONVERSION_TEMPERATURE = 0.3;
      const TYPE_CONVERSION_SYSTEM_PROMPT = `For all the given items, accurately determine the new more specific item type. Look at the surrounding items for context. You must produce the correct element_id. And you must produce a new type for every item.`;
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
              "code_or_algorithm",
              "end_marker",
              "acknowledgements_heading",
              "references_heading",
              "references_item",
              "endnotes_item",
              "endnotes_heading",
              "JEL_classification",
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

      // console.log("PASS 3: Fixing the extracted item order");
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
          content: item.text,
          order: item.item_order,
        });
      }

      const parsedItemsPath = path.join(fileNameDir, "parsedItems.json");
      fs.writeFileSync(parsedItemsPath, JSON.stringify(parsedItems, null, 2));
      console.log("Saved raw text extract to", parsedItemsPath);

      // Filtering and postprocessing steps---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      console.log("Filtering unnecessary item types");
      filteredItems = parsedItems.filter((item) =>
        [
          "main_title",
          "author_info",
          "abstract_heading",
          "abstract_content",
          "heading",
          "text",
          "figure_image",
          "code_or_algorithm",
          "table_rows",
        ].includes(item.type)
      );

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

      const initialItemsFilePath = `${email}/${initialItemsFileName}`;
      const parsedItemsFilePath = `${email}/${parsedItemsFileName}`;
      const filteredItemsFilePath = `${email}/${filteredItemsFileName}`;

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

      await subscribeEmail(email, process.env.MAILCHIMP_AUDIENCE_ID || "");
      console.log("Subscribed user to mailing list");

      const { audioBuffer, audioMetadata } = await synthesizeSpeechInChunks(
        filteredItems
      );
      console.log("Generated audio file");

      const audioFileUrl = await uploadFile(audioBuffer, audioFilePath);
      const metadataFileUrl = await uploadFile(
        Buffer.from(JSON.stringify(audioMetadata, null, 2)),
        metadataFilePath
      );

      const completedTime = getCurrentTimestamp();
      uploadStatus(runId, "Completed", {
        message: "Generated audio output and metadata",
        uploadedFileUrl: s3pdfFilePath,
        audioFileUrl: s3encodedAudioFilePath,
        metadataFileUrl: s3metadataFilePath,
        extractedTitle,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        completedTime: completedTime,
      });

      if (shouldSendEmailToUser) {
        await sendSuccessEmail(email, cleanedFileName, s3encodedAudioFilePath);
      }
    } catch (error) {
      return;
      const errorFileUrl = await uploadFile(
        Buffer.from(JSON.stringify(error, Object.getOwnPropertyNames(error))),
        errorFilePath
      );

      const errorTime = getCurrentTimestamp();
      uploadStatus(runId, "Error", {
        errorType: "CoreSystemFailure",
        message: `Error: ${error}`,
        errorFileUrl: s3encodedErrorFilePath,
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        errorTime: errorTime,
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
    const errorTime = getCurrentTimestamp();
    uploadStatus(runId, "Error", {
      errorType: "SummarizationMethodNotSupported",
      message: "This summarization method is not supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
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
