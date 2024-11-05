import { sendEmail } from "@email/transactional";
export const sendSuccessEmail = async (
  recipientEmail: string,
  fileName: string,
  audioFileUrl: string
) => {
  const emailSubject = `Your audio paper ${fileName} is ready!`;
  const emailBody = `Download link:\n${audioFileUrl}\n\nReply to this email to share feedback. We want your feedback. We will actually read it, work on addressing it, and if indicated by your reply, respond to your email.\n\nPlease share https://www.paper2audio.com with friends. We are looking for more feedback!\n\nKeep listening,\nJoe Golden`;

  try {
    await sendEmail(
      recipientEmail,
      "",
      "joe@paper2audio.com",
      "paper2audio",
      emailSubject,
      emailBody
    );
    console.log("Success email sent successfully to:", recipientEmail);
  } catch (error) {
    console.error("Error sending success email:", error);
  }
};

export const sendErrorEmail = async (
  recipientEmail: string,
  fileName: string,
  runId: string,
  errorFileUrl?: string
) => {
  const emailSubject = `Failed to generate audio paper ${fileName} for ${recipientEmail}`;
  const emailBody =
    `
    Failed to generate audio paper for ${fileName}.pdf uploaded by ${recipientEmail}. Check run status at runStatus/${runId}.json` +
    (errorFileUrl
      ? ` See error logs at ${errorFileUrl} and send an updated email to the user.`
      : "");

  const userEmailBody = `Failed to generate audio paper for ${fileName}. We will take a look at the error and send you a follow-up email with the audio file.`;

  try {
    await sendEmail(
      "joe@paper2audio.com",
      "",
      "joe@paper2audio.com",
      "paper2audio",
      emailSubject,
      emailBody
    );
    await sendEmail(
      "chandradeep@paper2audio.com",
      "",
      "joe@paper2audio.com",
      "paper2audio",
      emailSubject,
      emailBody
    );
    await sendEmail(
      recipientEmail,
      "",
      "joe@paper2audio.com",
      "paper2audio",
      emailSubject,
      userEmailBody
    );
    console.log("Error email sent successfully to:", recipientEmail);
  } catch (error) {
    console.error("Error sending error email:", error);
  }
};
