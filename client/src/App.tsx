import { useState } from "react";
import "./App.css";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [summarizationMethod, setSummarizationMethod] =
    useState<string>("betterAbstract");

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setFile(event.target.files[0]);
    }
  };

  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const handleMethodChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSummarizationMethod(event.target.value);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;

    setAudioUrl(null);

    const fileBuffer = await file.arrayBuffer();

    try {
      const response = await fetch(
        `/summarize?summarizationMethod=${summarizationMethod}`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type,
          },
          body: fileBuffer,
        }
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        console.log("Audio URL:", url);
        setAudioUrl(url);
      } else {
        console.error("Error:", response.statusText);
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  return (
    <>
      <h1 className="text-2xl font-bold mb-4">Text-to-speech Summarizer</h1>
      <form onSubmit={handleSubmit} className="flex flex-row gap-4">
        <input
          type="file"
          accept=".pdf,.epub"
          onChange={handleFileChange}
          className="p-2 border rounded"
        />
        <select
          value={summarizationMethod}
          onChange={handleMethodChange}
          className="p-2 border rounded"
        >
          <option value="betterAbstract">Better Abstract</option>
          <option value="twoPage">Two-page Summary</option>
          <option value="chaptered">Chaptered Summary</option>
          <option value="tablesAndFiguresOnly">Tables and Figures Only</option>
          <option value="ultimate">
            Better Abstract + Tables and Figures Only
          </option>
        </select>
        <button
          type="submit"
          className="p-2 bg-blue-500 text-white rounded hover:bg-blue-700"
        >
          Upload + Summarize
        </button>
      </form>
      {audioUrl && (
        <div className="mt-4">
          <audio controls src={audioUrl} className="w-full mb-2"></audio>
          <a
            href={audioUrl}
            download="summary.mp3"
            className="p-2 bg-green-500 text-white rounded"
          >
            Download MP3
          </a>
        </div>
      )}
    </>
  );
}

export default App;
