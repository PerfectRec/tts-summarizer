# TTS Summarizer

## Requirements

- Node.js version 20 or higher

## Getting Started

- Install dependencies with `yarn`
- To start the server, run `yarn start`
- To start the server in dev mode with HMR, run `yarn dev`

The server will listen on port `4242`.

## Folder Structure

- Place API route handlers in the `src/handlers` directory, each handler in its own file.
- AWS client interfaces are located in the `src/aws` directory.

## Dependencies

We are using

- `fastify` as our primary Node framework.
- `AWS S3`
  - to store the user uploaded files.
  - to store the AI generated audio files.
  - to store the user interaction memory.
- `AWS Polly` to convert generated text to audio.
- `Anthropic` to generate the summries.
- `LlamaParse` to parse complex file types like `pdf` and `epub`

## Summarization Modes

- `Contextual Abstract`: Generates a better and context aware abstract or blurb for the content
- `Two-page`: Generates a standard two page summary of the content
- `Chaptered`: Generates a chaptered summary of the content. Includes options to use existing chapters if any or generate new ones. Also can control if each chapter should be generated seperately, often leading to more detail.
- `Tables, Figures & Expressions Only`: Generates a copy of the original content with only the tables, figures and mathematical expressions summarized and the summaries integrated into the original text at the optimal locations. Other features include:
  - Skip over citations
  - Skip over tables, figures & expressions
- `Ultimate`: `Contextual Abstract` + `Tables, Figures & Equations Only`
