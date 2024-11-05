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
}

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

interface ModelConfig {
  [task: string]: { temperature: number; model: Model };
}

interface Author {
  authorName: string;
  affiliation: string;
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
  isStartCutOff?: boolean;
  isEndCutOff?: boolean;
  allAbbreviations?: {
    abbreviation: string;
    expansion: string;
    type: "pronounced_as_a_single_word" | "pronounced_with_initials";
  }[];
}

interface ItemAudioMetadata {
  type: string;
  startTime: number;
  itemDuration: number;
  transcript: string;
  page: number;
  index: number;
}

interface ItemAudioResult {
  itemAudioBuffer: Buffer;
  itemAudioMetadata: ItemAudioMetadata;
}

interface AudioResult {
  audioBuffer: Buffer;
  audioMetadata: ItemAudioMetadata[];
}
