interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
  email: string;
  fileName: string;
  sendEmailToUser: string;
  link: string;
  error?: string;
}

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

interface ModelConfig {
  [task: string]: { temperature: number; model: Model; concurrency: number };
}

interface Author {
  authorName: string;
  affiliation: string;
}

type AbbreviationSubTypes =
  | "pronounced_as_a_single_word"
  | "pronounced_with_initials"
  | "partially_pronounced_with_initials";

interface Abbreviation {
  abbreviation: string;
  expansion: string;
  type: AbbreviationSubTypes;
}

interface Item {
  type: string;
  content: string;
  label?: { labelType: string; labelNumber: string };
  summary?: string;
  optimizedMath?: boolean;
  replacedCitations?: Boolean;
  repositioned?: Boolean;
  page: number;
  mathSymbolFrequency?: number;
  hasCitations?: boolean;
  citations?: string[];
  isStartCutOff?: boolean;
  isEndCutOff?: boolean;
  allAbbreviations?: Abbreviation[];
  audioIssues?: string[];
}

interface ItemAudioMetadata {
  type: string;
  startTime: number;
  itemDuration: number;
  transcript: string;
  page: number;
  index: number;
  audioIssues: string[];
}

interface ItemAudioResult {
  itemAudioBuffer: Buffer;
  itemAudioMetadata: ItemAudioMetadata;
}

interface AudioResult {
  audioBuffer: Buffer;
  audioMetadata: ItemAudioMetadata[];
}
