// Import the framework and instantiate it
import Fastify from "fastify";
import path from "path";
import { fileURLToPath } from "url";
import fastifyStatic from "@fastify/static";
// Handler imports
import highQualitySummarizeHandler from "@handlers/highQualitySummarize";
import checkStatusHandler from "@handlers/checkStatus";
import mockSummarizeHandler from "@handlers/mockSummarize";
import syncPapers from "@handlers/syncPapers";
import getPapers from "@handlers/getPapers";
import fastSummarizeHandler from "@handlers/fastSummarize";
import healthHandler from "@handlers/healthHandler";

const envToLogger = {
  development: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
  production: true,
  test: false,
};

type Environment = "development" | "production" | "test";

const environment: Environment =
  (process.env.NODE_ENV as Environment) || "development";

const fastify = Fastify({
  logger: envToLogger[environment] ?? true,
  bodyLimit: 52428800,
});

// Add content type parsers
fastify.addContentTypeParser(
  "application/pdf",
  { parseAs: "buffer" },
  (req, body, done) => {
    done(null, body);
  }
);
fastify.addContentTypeParser(
  "application/epub+zip",
  { parseAs: "buffer" },
  (req, body, done) => {
    done(null, body);
  }
);

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from the 'client/dist' directory
fastify.register(fastifyStatic, {
  root: path.join(__dirname, "../client/dist"),
  prefix: "/", // optional: default '/'
});

// Routes
fastify.post("/summarize", highQualitySummarizeHandler);
fastify.post("/v2/summarize", fastSummarizeHandler);
fastify.get("/checkStatus", checkStatusHandler);
fastify.post("/mockSummarize", mockSummarizeHandler);
fastify.get("/getpapers", getPapers);
fastify.post("/syncPapers", syncPapers);

fastify.post("/health", healthHandler);

const port = Number(process.env.PORT) || 4242;
const host = "RENDER" in process.env ? `0.0.0.0` : `localhost`;

// Run the server!
try {
  await fastify.listen({ host: host, port: port });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
