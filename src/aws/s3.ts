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
