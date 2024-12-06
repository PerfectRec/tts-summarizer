// Import the framework and instantiate it
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";

import path from "path";
import { fileURLToPath } from "url";
// Handler imports
import highQualitySummarizeHandler from "@handlers/highQualitySummarize";
import checkStatusHandler from "@handlers/checkStatus";
import mockSummarizeHandler from "@handlers/mockSummarize";
import syncPapers from "@handlers/syncPapers";
import getPapers from "@handlers/getPapers";
import fastSummarizeHandler from "@handlers/fastSummarize";
import healthHandler from "@handlers/healthHandler";

import { linkRoutes, LinkManagerHandlers } from "@handlers/linkManager";

// Set up environmment variables and logging
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

// Set up the Fastify server
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

// add routes for Link Management and checking
const lmHandlers = new LinkManagerHandlers();
linkRoutes(fastify, lmHandlers);

// Add swagger documentation if in development mode
/*
on 12/5 we attemped it. But swagger endpoint is not registering
if (environment === 'development') {

  fastify.register(fastifySwagger, {
    routePrefix: '/docs',
    swagger: {
      info: {
        title: 'Paper2Audio API',
        description: 'API documentation for the Paper2Audio',
        version: '1.0.0'
      }
    },
    uiConfig: {
      docExpansion: 'full',
      deepLinking: true
    },
    exposeRoute: true
  });

  console.log("Swagger documentation enabled");
}
*/

// Main section of the server

const port = Number(process.env.PORT) || 4242;
const host = "RENDER" in process.env ? `0.0.0.0` : `localhost`;

// Run the server!
try {
  await fastify.listen({ host: host, port: port });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
