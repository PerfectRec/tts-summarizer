import AWS from "aws-sdk";
import dotenv from "dotenv";

dotenv.config();

const ses = new AWS.SES({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

export const sendEmail = async (
  toAddress: string,
  subject: string,
  body: string
): Promise<void> => {
  const params = {
    Source: "it@perfectrec.com",
    Destination: {
      ToAddresses: [toAddress],
    },
    Message: {
      Subject: {
        Data: subject,
      },
      Body: {
        Text: {
          Data: body,
        },
      },
    },
  };

  try {
    const data = await ses.sendEmail(params).promise();
    console.log(`Email sent successfully. Message ID: ${data.MessageId}`);
  } catch (err) {
    const error = err as Error;
    console.error(`Error sending email. ${error.message}`);
    throw error;
  }
};