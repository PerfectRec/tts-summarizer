import { FastifyRequest, FastifyReply } from "fastify";
import { fileURLToPath } from "url";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import { pdfToPng, PngPageOutput } from "pdf-to-png-converter";
import { uploadFile, uploadStatus } from "@aws/s3";
import { subscribeEmail } from "@email/marketing";
import { v4 as uuidv4 } from "uuid";
import { getDB } from "db/db";
import { sendErrorEmail, sendSuccessEmail } from "@utils/email";
import { clearDirectory, getCurrentTimestamp } from "@utils/io";
import {
  synthesizeOpenAISpeechWithRetries,
  synthesizeSpeechInChunksOpenAI,
} from "@utils/openai";
import {
  determineRelevantPages,
  extractJsonFromImages,
  extractMainTitle,
  improveAuthorInfo,
  processAuthorInfo,
  detectCitations,
  optimizeCitations,
  detectMathSymbolFrequency,
  optimizeItemsWithMath,
  processReferencesAndAcknowledgements,
  filterUnnecessaryItemTypes,
  replaceKnownAbbreviations,
  tagItemsWithCutOffs,
  repositionSpecialItems,
  addSSMLBreaks,
  summarizeItemGroup,
} from "@utils/core";

const { db } = getDB();

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod, email, fileName, sendEmailToUser, link, id } =
    request.query;

  const logBuffer: string[] = [];

  const receivedEmail = email && email !== "" ? email : "";

  const shouldSendEmailToUser =
    sendEmailToUser === "true" && email && email !== "";

  const userBucketName =
    id && id !== "" ? id : email && email !== "" ? email : "NoEmailOrId";

  let fileBuffer: Buffer;
  let cleanedFileName: string;
  let addMethod: "link" | "file" = "file";
  let fullSourceName: String = "";

  const runId = uuidv4();
  const receivedTime = getCurrentTimestamp();

  await uploadStatus(runId, "Received", {
    message: "Request received",
    receivedTime: receivedTime,
    email: receivedEmail,
    id: id,
    progress: "0.1",
    logBuffer: logBuffer.join("________________"),
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
  logBuffer.push(`Created runStatus/${runId}.json in S3`);

  if (link && link !== "") {
    try {
      addMethod = "link";
      fullSourceName = link;
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
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });
      if (shouldSendEmailToUser) {
        sendErrorEmail(receivedEmail, link, runId);
      }
      return;
    }
  } else {
    addMethod = "file";
    fullSourceName = fileName;
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

  //FIRSTPAGE
  const firstPageFileName = `${cleanedFileName}-page1.png`;
  const firstPageFilePath = `${userBucketName}/${firstPageFileName}`;
  const s3firstPageFilePath = `https://${process.env.AWS_BUCKET_NAME}/${firstPageFilePath}`;

  // SUMMARY-JSON
  const summaryJsonFileName = `${cleanedFileName}-summary.json`;
  const summaryJsonFilePath = `${userBucketName}/${summaryJsonFileName}`;
  const s3summaryJsonFilePath = `https://${process.env.AWS_BUCKET_NAME}/${summaryJsonFilePath}`;

  // SUMMARY-AUDIO
  const summaryAudioFileName = `${cleanedFileName}-summary.mp3`;
  const summaryAudioFilePath = `${userBucketName}/${summaryAudioFileName}`;
  const s3summaryAudioFilePath = `https://${process.env.AWS_BUCKET_NAME}/${summaryAudioFilePath}`;

  // console.log(cleanedFileName);
  // return;

  if (fileBuffer.length > 100 * 1024 * 1024) {
    const errorTime = getCurrentTimestamp();
    await uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "FileSizeExceeded",
      message: "File size exceeds 100MB which is currently not supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
      addMethod,
      fullSourceName,
      logBuffer: logBuffer.join("________________"),
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
  logBuffer.push("attempting to convert pdf pages to images");

  let pngPagesOriginal: PngPageOutput[] = [];
  try {
    pngPagesOriginal = await pdfToPng(fileBuffer, {
      viewportScale: 5.0,
      outputFolder: tempImageDir,
    });
  } catch (error) {
    const errorTime = getCurrentTimestamp();
    console.log(error);
    logBuffer.push(`${error}`);
    await uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "InvalidPDFFormat",
      message: "File has invalid format",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
      addMethod,
      fullSourceName,
      logBuffer: logBuffer.join("________________"),
    });
    if (shouldSendEmailToUser) {
      sendErrorEmail(receivedEmail, cleanedFileName, runId);
    }
    return;
  }

  if (pngPagesOriginal.length > 0) {
    const firstPagePath = pngPagesOriginal[0].path;
    const firstPageBuffer = await fs.readFile(firstPagePath);
    const firstPageUrl = await uploadFile(firstPageBuffer, firstPageFilePath);

    await uploadStatus(runId, "Received", {
      message: "Request received",
      receivedTime: receivedTime,
      email: receivedEmail,
      id: id,
      firstPageUrl: s3firstPageFilePath, // Add this line
      progress: "0.2",
      addMethod,
      fullSourceName,
      logBuffer: logBuffer.join("________________"),
    });
  }

  if (pngPagesOriginal.length > 100) {
    const errorTime = getCurrentTimestamp();
    await uploadStatus(runId, "Error", {
      email: receivedEmail,
      id: id,
      errorType: "FileNumberOfPagesExceeded",
      message: "pdf has more than 100 pages which is not currently supported",
      uploadedFileUrl: s3pdfFilePath,
      receivedTime: receivedTime,
      errorTime: errorTime,
      cleanedFileName,
      firstPageUrl: s3firstPageFilePath,
      addMethod,
      fullSourceName,
      logBuffer: logBuffer.join("________________"),
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
    firstPageUrl: s3firstPageFilePath,
    progress: "0.3",
    addMethod,
    fullSourceName,
    logBuffer: logBuffer.join("________________"),
  });

  console.log("converted pdf pages to images");
  logBuffer.push("converted pdf pages to images");

  if (summarizationMethod === "ultimate") {
    try {
      let allItems: Item[] = [];
      let authorInfoContents = "";
      let mainTitleContents = "";

      console.log(`PASS 0 LLM: Determining which pages are relevant`);
      logBuffer.push(`PASS 0 LLM: Determining which pages are relevant`);

      const pngPages = pngPagesOriginal;

      console.log(
        `Filtered out ${
          pngPagesOriginal.length - pngPages.length
        } irrelevant pages`
      );
      logBuffer.push(
        `Filtered out ${
          pngPagesOriginal.length - pngPages.length
        } irrelevant pages`
      );

      //return;

      console.log(
        `PASS 1 LLM: Extracting text from the images and summarizing special items`
      );
      logBuffer.push(
        `PASS 1 LLM: Extracting text from the images and summarizing special items`
      );

      await extractJsonFromImages(
        runId,
        logBuffer,
        allItems,
        pngPages,
        authorInfoContents,
        mainTitleContents
      );

      uploadStatus(runId, "Processing", {
        email: receivedEmail,
        id: id,
        message: "Finished first extraction",
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        cleanedFileName: cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        progress: "0.4",
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });

      console.log(
        "PASS 2 LLM: Improving author section and detecting main title."
      );
      logBuffer.push(
        "PASS 2 LLM: Improving author section and detecting main title."
      );

      const { extractedTitle, extractedMonth, extractedYear, formattedDate } =
        await extractMainTitle(runId, logBuffer, mainTitleContents, pngPages);

      const improvedAuthorInfo = await improveAuthorInfo(
        runId,
        logBuffer,
        allItems,
        pngPages,
        extractedTitle,
        authorInfoContents
      );

      //Note this also updates allItems in place
      const minifiedAuthorInfo = await processAuthorInfo(
        allItems,
        improvedAuthorInfo
      );

      console.log(
        `Extracted info: ${extractedTitle}, ${formattedDate}, ${minifiedAuthorInfo}`
      );
      logBuffer.push(
        `Extracted info: ${extractedTitle}, ${formattedDate}, ${minifiedAuthorInfo}`
      );

      console.log(
        "PASS 3 CODE: Fixing potential issues with references and acknowledgements"
      );
      logBuffer.push(
        "PASS 3 CODE: Fixing potential issues with references and acknowledgements"
      );

      processReferencesAndAcknowledgements(allItems);

      console.log("PASS 4 CODE: filtering unnecessary item types");
      logBuffer.push("PASS 4 CODE: filtering unnecessary item types");

      const filteredItems = filterUnnecessaryItemTypes(allItems);

      const parsedItemsPath = path.join(fileNameDir, "parsedItems.json");
      fs.writeFileSync(parsedItemsPath, JSON.stringify(allItems, null, 2));
      console.log("Saved parsedItems to", parsedItemsPath);
      logBuffer.push(`Saved parsedItems to ${parsedItemsPath}`);

      uploadStatus(runId, "Processing", {
        email: receivedEmail,
        id: id,
        message: "Finished main title and author extraction",
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        cleanedFileName: cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        progress: "0.5",
        extractedTitle,
        publishedMonth: formattedDate,
        minifiedAuthorInfo,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });

      console.log("PASS 5 LLM: detecting citations");
      logBuffer.push("PASS 5 LLM: detecting citations");

      await detectCitations(runId, logBuffer, filteredItems);

      console.log("PASS 6 LLM: optimzing citations");
      logBuffer.push("PASS 6 LLM: optimzing citations");

      await optimizeCitations(runId, logBuffer, filteredItems);

      uploadStatus(runId, "Processing", {
        email: receivedEmail,
        id: id,
        message: "Finished citation processing",
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        cleanedFileName: cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        progress: "0.6",
        extractedTitle,
        publishedMonth: formattedDate,
        minifiedAuthorInfo,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });

      //It is important to replace citations first and then optimize the math - but only in content with math.
      console.log("PASS 7 LLM: detecting math symbol frequency");
      logBuffer.push("PASS 7 LLM: detecting math symbol frequency");

      await detectMathSymbolFrequency(runId, logBuffer, filteredItems);

      console.log(
        "PASS 8 LLM: optimizing items with high math symbol frequency"
      );
      logBuffer.push(
        "PASS 8 LLM: optimizing items with high math symbol frequency"
      );

      await optimizeItemsWithMath(runId, logBuffer, filteredItems);

      uploadStatus(runId, "Processing", {
        email: receivedEmail,
        id: id,
        message: "Finished processing math",
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        cleanedFileName: cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        progress: "0.7",
        extractedTitle,
        publishedMonth: formattedDate,
        minifiedAuthorInfo,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });

      //Process abbreviations
      console.log("PASS 9 CODE: Replacing known abbreviations");
      logBuffer.push("PASS 9 CODE: Replacing known abbreviations");

      replaceKnownAbbreviations(filteredItems);

      console.log("PASS 10 CODE: Tagging items with start and end cut off");
      logBuffer.push("PASS 10 CODE: Tagging items with start and end cut off");

      tagItemsWithCutOffs(filteredItems);

      console.log("PASS 11 CODE: Repositioning images and figures and code");
      logBuffer.push("PASS 11 CODE: Repositioning images and figures and code");

      repositionSpecialItems(logBuffer, filteredItems);

      console.log("PASS 12 CODE: Adding SSML breaks where needed");
      logBuffer.push("PASS 12 CODE: Adding SSML breaks where needed");

      addSSMLBreaks(filteredItems);

      uploadStatus(runId, "Processing", {
        email: receivedEmail,
        id: id,
        message: "Finished abbreviations and repositioning",
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        cleanedFileName: cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        progress: "0.8",
        extractedTitle,
        publishedMonth: formattedDate,
        minifiedAuthorInfo,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });

      console.log("PASS 13 LLM: Summarizing the entire paper");
      logBuffer.push("PASS 13 LLM: Summarizing the entire paper");

      const summaryJson = await summarizeItemGroup(
        runId,
        logBuffer,
        filteredItems
      );

      const filteredItemsPath = path.join(fileNameDir, "filteredItems.json");
      fs.writeFileSync(
        filteredItemsPath,
        JSON.stringify(filteredItems, null, 2)
      );
      console.log("Saved filtered items to", filteredItemsPath);
      logBuffer.push(`Saved filtered items to ${filteredItemsPath}`);

      const summaryPath = path.join(fileNameDir, "summary.json");
      fs.writeFileSync(summaryPath, JSON.stringify(summaryJson, null, 2));
      console.log("Saved summary to", summaryPath);
      logBuffer.push(`Saved summary to ${summaryPath}`);

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

      const summaryJsonFileUrl = await uploadFile(
        fs.readFileSync(summaryPath),
        summaryJsonFilePath
      );

      uploadStatus(runId, "Processing", {
        email: receivedEmail,
        id: id,
        message: "Finished generating summary",
        uploadedFileUrl: s3pdfFilePath,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        cleanedFileName: cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        summaryJsonUrl: s3summaryJsonFilePath,
        progress: "0.85",
        extractedTitle,
        publishedMonth: formattedDate,
        minifiedAuthorInfo,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
      });

      await subscribeEmail(
        receivedEmail,
        process.env.MAILCHIMP_AUDIENCE_ID || ""
      );
      console.log("Subscribed user to mailing list");
      logBuffer.push("Subscribed user to mailing list");

      console.log("PASS 14 LLM: Synthesizing speech for paper and summary");
      logBuffer.push("PASS 14 LLM: Synthesizing speech for paper and summary");

      const { audioBuffer, audioMetadata, audioDuration, tocAudioMetadata } =
        await synthesizeSpeechInChunksOpenAI(filteredItems);

      const summaryAudioBuffer = await synthesizeOpenAISpeechWithRetries(
        summaryJson.summary,
        "onyx",
        1.0
      );

      console.log("Generated audio file for paper and summary");
      logBuffer.push("Generated audio file for paper and summary");

      const audioFileUrl = await uploadFile(audioBuffer, audioFilePath);

      const summaryAudioFileUrl = await uploadFile(
        summaryAudioBuffer,
        summaryAudioFilePath
      );

      const metadataFileUrl = await uploadFile(
        Buffer.from(
          JSON.stringify(
            {
              extractedTitle: extractedTitle,
              extractedPublishedMonth: formattedDate,
              extractedMinifiedAuthorInfo: minifiedAuthorInfo,
              tableOfContents: tocAudioMetadata,
              segments: audioMetadata,
              audioDuration: audioDuration,
            },
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
        message: "Generated audio output for paper and summary",
        uploadedFileUrl: s3pdfFilePath,
        audioFileUrl: s3encodedAudioFilePath,
        metadataFileUrl: s3metadataFilePath,
        extractedTitle,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        completedTime: completedTime,
        cleanedFileName,
        firstPageUrl: s3firstPageFilePath,
        summaryJsonFileUrl: s3summaryJsonFilePath,
        summaryAudioFileUrl: s3summaryAudioFilePath,
        progress: "0.95",
        publishedMonth: formattedDate,
        minifiedAuthorInfo,
        audioDuration: `${audioDuration}`,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
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
        firstPageUrl: s3firstPageFilePath,
        addMethod,
        fullSourceName,
        logBuffer: logBuffer.join("________________"),
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
      logBuffer.push(`Error generating audio file: ${error}`);
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
      firstPageUrl: s3firstPageFilePath,
      addMethod,
      fullSourceName,
      logBuffer: logBuffer.join("________________"),
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
    logBuffer.push("Temporary directories deleted");
  } catch (cleanupError) {
    console.error("Error during cleanup:", cleanupError);
    logBuffer.push(`Error during cleanup: ${cleanupError}`);
  }

  return;
}
