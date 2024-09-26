// Import the framework and instantiate it
import Fastify from "fastify";
import path from "path";
import { fileURLToPath } from "url";
import fastifyStatic from "@fastify/static";
// Handler imports
import summarizeHandler from "@handlers/summarize";
import highQualitySummarizeHandler from "@handlers/highQualitySummarize";

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
  bodyLimit: 10485760,
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

// Run the server!
try {
  await fastify.listen({ port: 4242 });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
