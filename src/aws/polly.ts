import AWS from "aws-sdk";
import dotenv from "dotenv";

dotenv.config();

const polly = new AWS.Polly({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

export const synthesizeSpeech = async (
  text: string,
  voiceId: string = "Ruth",
  useSSML: boolean = false
): Promise<Buffer> => {
  const params = {
    Text: text,
    OutputFormat: "mp3",
    VoiceId: voiceId,
    Engine: "generative",
    TextType: useSSML ? "ssml" : "text",
  };

  try {
    const data = await polly.synthesizeSpeech(params).promise();
    if (data.AudioStream instanceof Buffer) {
      return data.AudioStream;
    } else {
      throw new Error("AudioStream is not a Buffer");
    }
  } catch (err) {
    const error = err as Error;
    console.error(`Error synthesizing speech. ${error.message}`);
    throw error;
  }
};
