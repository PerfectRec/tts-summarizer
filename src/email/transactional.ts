import mailchimpTransactional from "@mailchimp/mailchimp_transactional";
import dotenv from "dotenv";

dotenv.config();

const mailchimp = mailchimpTransactional(process.env.MANDRILL_API_KEY || "");

export async function sendEmail(
  toEmail: string,
  toName: string,
  fromEmail: string,
  fromName: string,
  subject: string,
  text: string
) {
  try {
    const response = await mailchimp.messages.send({
      message: {
        to: [{ email: toEmail, name: toName }],
        from_email: fromEmail,
        from_name: fromName,
        subject: subject,
        text: text,
      },
    });

    console.log(response);
  } catch (error) {
    console.error(error);
  }
}
