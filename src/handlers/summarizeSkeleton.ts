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
      let parsedItems: Item[] = [];
      let filteredItems: Item[] = [];
      let extractedTitle: string = "NoTitleDetected";

      // Parsing and summrization steps---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      const parsedItemsPath = path.join(fileNameDir, "parsedItems.json");
      fs.writeFileSync(parsedItemsPath, JSON.stringify(parsedItems, null, 2));
      console.log("Saved raw text extract to", parsedItemsPath);

      // Filtering and postprocessing steps---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

      const filteredItemsPath = path.join(fileNameDir, "filteredItems.json");
      fs.writeFileSync(
        filteredItemsPath,
        JSON.stringify(filteredItems, null, 2)
      );
      console.log("Saved filtered items to", filteredItemsPath);

      // S3 upload, Audio Generation and Other stuff---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

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
