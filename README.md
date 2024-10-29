# TTS Summarizer

## Requirements

- Node.js version 20 or higher (a key library we are using does not work with anything below 20)

## Getting Started

- Install Node.js 20 or higher. On Linux/MacOS use `nvm`. On Windows, simply download it from the Node.js website.
- From the root folder run `yarn` then `yarn upgrade`
- From the `client` folder run `yarn`.
- To start the server in dev mode with HMR, from the root folder run `yarn dev`
- Go to `http://localhost:4242`
- Upload a `pdf` or `epub` file.

## Folder Structure

- Place API route handlers in the `src/handlers` directory, each handler in its own file.
- AWS client interfaces are located in the `src/aws` directory.
- Email stuff is in `src/email`.

## Dependencies

We are using

- `fastify` as our primary Node framework.
- `S3` to store the audio files and metadata.
- `Polly` to convert generated text to audio.
- `Anthropic` or `OpenAI` models to generate the summries.
- `Mailchimp` to send transactional and marketing emails.
- `Helicone` for logging and monitoring Claude API calls.

## Modes we plan to support

- `Contextual Abstract`: Generates a better and context aware abstract or blurb for the content
- `Two-page`: Generates a standard two page summary of the content
- `Chaptered`: Generates a chaptered summary of the content. Includes options to use existing chapters if any or generate new ones. Also can control if each chapter should be generated seperately, often leading to more detail.
- `Tables, Figures & Expressions Only`: Generates a copy of the original content with only the tables, figures, algorithms and mathematical expressions summarized and the summaries integrated into the original text at the optimal locations. We also clean up meta content like journal info and references.
- `Ultimate`: `Contextual Abstract` + `Tables, Figures & Equations Only`
  - This is the only mode supported currently however the contextual abstract part of this is not supported yet.
