import { uploadFile } from "@aws/s3";
import { FastifyRequest, FastifyReply } from "fastify";

interface HealthHandlerRequestParameters {
    id: string,
    email: string,
    ts: string
}

function createTimestamp( timestamp: Date): string {
    const now = timestamp;
    const year = now.getFullYear();
    const month = ("0" + (now.getMonth() + 1)).slice(-2);
    const day = ("0" + now.getDate()).slice(-2);
    const hours = ("0" + now.getHours()).slice(-2);
    const minutes = ("0" + now.getMinutes()).slice(-2);
    const seconds = ("0" + now.getSeconds()).slice(-2);
  
    return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
  }

export default async function healthHandler(
  request: FastifyRequest<{
    Querystring: HealthHandlerRequestParameters;
  }>,
  reply: FastifyReply
) {
    // incoming URL is of the form /health?id=<ID>&email=<email>&ts=<Timestamp)
  const { id, email, ts } = request.query;
  const diagnosticsLog = request.body as string
  var timestampString : string = ""
  var filePrefix: string = ""

  // ------ Validate parameters first
  // Todo: move all these paramter validations into a class object

  if (!id) {
    return reply.status(400).send({
      status: "Error",
      errorType: "InvalidInput",
      message: "User ID is required.",
    });
  }

  // use the email if available. Or else switch to using the ID as prefix
  filePrefix = (email && (email.length > 0) ? email : id);
 
  // make up a timestamp value if not supplied  
  timestampString = ts ? ts : createTimestamp( new Date());

  if (!diagnosticsLog) {
    return reply.status(400).send({
      status: "Error",
      errorType: "InvalidInput",
      message: "Diagnostics Log is required in the body of POST.",
    });
  }

  // ------ Let us now save this diagnosticsLog to our file storage
  try {
    const filePath = `healthLogs/${filePrefix}-${timestampString}.txt`;
    const fileContent = Buffer.from( diagnosticsLog);
    await uploadFile(fileContent, filePath);

    reply.status(200).send({
      status: "Success",
      message: `Diagnostics content saved for ${filePrefix} at time: ${timestampString}`
    });
  } catch (error) {
    reply.status(500).send({
      status: "Error",
      errorType: "ProcessingError",
      message: `ERROR: unable to save diagnostics content for ${filePrefix} at time: ${timestampString}`
    });
  }
  return;
}
