import { WebClient } from "@slack/web-api";
import "dotenv/config";

// Initialize Slack client with the token from environment variables
const slackClient = new WebClient(process.env.SLACK_TOKEN);

/**
 * Sends a notification to a Slack channel.
 * @param {string} text - The message text to send.
 */
export async function sendSlackNotification(text: string): Promise<void> {
  try {
    // Send a message to the specified channel
    await slackClient.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID as string,
      text: text,
    });
    console.log("Message sent successfully");
  } catch (error) {
    console.error("Error sending message to Slack:", error);
  }
}
