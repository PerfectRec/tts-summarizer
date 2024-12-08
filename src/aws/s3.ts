import { sendSlackNotification } from "@utils/slack";
import AWS from "aws-sdk";
import dotenv from "dotenv";

dotenv.config();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const bucketName = process.env.AWS_BUCKET_NAME;
if (!bucketName) {
  throw new Error("AWS_BUCKET_NAME is not defined in environment variables");
}

export const uploadFile = async (
  fileContent: Buffer,
  fileName: string
): Promise<string> => {
  const params = {
    Bucket: bucketName,
    Key: fileName,
    Body: fileContent,
    ACL: "public-read",
  };

  try {
    const data = await s3.upload(params).promise();
    console.log(`File uploaded successfully. ${data.Location}`);
    return data.Location;
  } catch (err) {
    const error = err as Error;
    console.error(`Error uploading file. ${error.message}`);
    throw error;
  }
};

export const getFileContent = async (fileName: string): Promise<string> => {
  const params = {
    Bucket: bucketName,
    Key: fileName,
  };

  try {
    const data = await s3.getObject(params).promise();
    return data.Body?.toString("utf-8") || "";
  } catch (err) {
    const error = err as Error;
    console.error(`Error fetching file. ${error.message}`);
    throw error;
  }
};

export const uploadStatus = async (
  runId: string,
  status: string,
  additionalData: Record<string, any>,
  mock: boolean = false
): Promise<void> => {
  const combinedData: Record<string, any> = { status, ...additionalData };
  const fileName = `runStatus/${runId}.json`;
  const fileContent = Buffer.from(JSON.stringify(combinedData));

  try {
    await uploadFile(fileContent, fileName);

    if (status === "Completed" && !mock) {
      await sendSlackNotification(
        `COMPLETED ${
          combinedData.summarizationMethod &&
          combinedData.summarizationMethod === "ultimate"
            ? `[full paper]`
            : combinedData.summarizationMethod === "short"
            ? "[short summary]"
            : ""
        } "${
          combinedData.extractedTitle ?? combinedData.cleanedFileName
        }" email: ${
          combinedData.email && combinedData.email !== ""
            ? combinedData.email
            : "N/A"
        } ID: ${
          combinedData.id && combinedData.id !== "" ? combinedData.id : "N/A"
        }. [${encodeURI(
          `https://files.paper2audio.com/runStatus/${runId}.json`
        )}]`
      );
    }

    if (status === "Error" && !mock) {
      await sendSlackNotification(
        `ERROR [${combinedData.errorType}] ${
          combinedData.summarizationMethod &&
          combinedData.summarizationMethod === "ultimate"
            ? `[full paper]`
            : combinedData.summarizationMethod === "short"
            ? "[short summary]"
            : ""
        } "${
          combinedData.extractedTitle ?? combinedData.cleanedFileName
        }" email: ${
          combinedData.email && combinedData.email !== ""
            ? combinedData.email
            : "N/A"
        } ID: ${
          combinedData.id && combinedData.id !== "" ? combinedData.id : "N/A"
        }. [${encodeURI(
          `https://files.paper2audio.com/runStatus/${runId}.json`
        )}]`
      );
    }

    console.log(`Status for ${runId} uploaded successfully.`);
  } catch (err) {
    const error = err as Error;
    console.error(`Error uploading status for ${runId}: ${error.message}`);
    throw error;
  }
};
