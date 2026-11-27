/**
 * Ask PB — Firebase AI Logic hybrid inference.
 *
 * One question in, one streamed answer out. The model is created with
 * InferenceMode.PREFER_ON_DEVICE: Firebase AI Logic tries Gemini Nano
 * on-device (Chrome's Prompt API) and falls back to a cloud Gemini model
 * automatically when on-device isn't available.
 *
 * LANE HONESTY: the badge never guesses. Every response from the SDK carries
 * `inferenceSource` ('on_device' | 'in_cloud', Firebase JS SDK v12.5.0+), and
 * the badge is set from that value. Only if a response arrives without it do
 * we fall back to the pre-call LanguageModel.availability() result — and then
 * the result is flagged `laneInferred` so the UI can say so.
 *
 * LIVE SEARCH: when Gemini Nano is not ready on the device, the cloud
 * serves the answer either way — so those questions go to a dedicated
 * cloud model carrying Google Search grounding (buildSearchModel), and
 * the sources it checked are returned in AskResult.sources for the UI
 * to list. When Nano IS ready, the hybrid model serves on-device.
 */
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  type GenerativeModel,
} from "firebase/ai";
import { firebaseApp, firebaseConfigured } from "./firebase";
import { PB_SYSTEM_CONTEXT } from "./facts";

/** Cloud fallback model — the Firebase AI Logic default for SDK v13. */
const CLOUD_MODEL = "gemini-3.5-flash";

export type Lane = "on-device" | "cloud";

export type NanoAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | "unsupported";

interface LanguageModelStatic {
  availability: () => Promise<string>;
}

function promptApi(): LanguageModelStatic | undefined {
  return (window as unknown as { LanguageModel?: LanguageModelStatic })
    .LanguageModel;
}

/**
 * Ask Chrome's Prompt API whether Gemini Nano can answer on this device.
 * 'unsupported' means the Prompt API itself isn't in this browser
 * (not Chrome 139+ desktop, or the flag isn't enabled).
 */
export async function checkNanoAvailability(): Promise<NanoAvailability> {
  const lm = promptApi();
  if (!lm) return "unsupported";
  try {
    const raw = await lm.availability();
    switch (raw) {
      case "available":
      case "readily": // older Prompt API vocabulary
        return "available";
      case "downloadable":
      case "after-download":
        return "downloadable";
      case "downloading":
        return "downloading";
      default:
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}

let cachedModel: GenerativeModel | undefined;
let cachedSearchModel: GenerativeModel | undefined;

function aiBackend() {
  if (!firebaseApp) {
    throw new Error(
      "Firebase is not configured yet. Copy .env.example to .env and fill in your Firebase project config, then reload.",
    );
  }
  return getAI(firebaseApp, { backend: new GoogleAIBackend() });
}

/**
 * The hybrid model: Gemini Nano on-device when it's ready, cloud Gemini
 * otherwise (InferenceMode.PREFER_ON_DEVICE). This is the hackathon's
 * core lane — private, offline-capable answers on the visitor's machine.
 */
function buildHybridModel(): GenerativeModel {
  return getGenerativeModel(aiBackend(), {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [
          {
            role: "system",
            content: [{ type: "text", value: PB_SYSTEM_CONTEXT }],
          },
        ],
      },
    },
    inCloudParams: {
      model: CLOUD_MODEL,
      systemInstruction: PB_SYSTEM_CONTEXT,
      generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
    },
  });
}

/**
 * The plain cloud model. Used whenever Gemini Nano is NOT ready on
 * this device. It carries NO tools on purpose: on this AI Logic
 * backend, the SDK's googleSearch tool never grounded reliably
 * (ignored on the lite model, MALFORMED_FUNCTION_CALL on the full
 * model). Live web access is PB's own job instead — see
 * fetchLiveResults() below: PB searches first, answers from what he
 * finds, and lists the pages he actually checked.
 */
function buildCloudModel(): GenerativeModel {
  return getGenerativeModel(aiBackend(), {
    model: CLOUD_MODEL,
    systemInstruction: PB_SYSTEM_CONTEXT,
    generationConfig: { maxOutputTokens: 512, temperature: 0.7 },
  });
}

function getHybridModel(): GenerativeModel {
  cachedModel ??= buildHybridModel();
  return cachedModel;
}

function getCloudModel(): GenerativeModel {
  cachedSearchModel ??= buildCloudModel();
  return cachedSearchModel;
}

/* ------------------------------------------------------------------ */
/* PB's own live search — "memory for speed, search for truth".        */
/*                                                                     */
/* Before answering a factual question, PB fetches live results from */
/* PoorBoyAI's own search proxy (a tiny in-house worker), feeds the  */
/* snippets to whichever lane serves the answer as context, and     */
/* reports the fetched pages as the answer's sources. Creative and  */
/* pure-math prompts skip the fetch. Any failure fails OPEN: the    */
/* question is answered without live context rather than not at all. */
/* ------------------------------------------------------------------ */

const SEARCH_ENDPOINT = "https://pb-ask-search.dewayne-aatm.workers.dev/";

interface LiveResult {
  title: string;
  url: string;
  snippet: string;
}

function needsLiveSearch(question: string): boolean {
  const q = question.trim();
  if (/^(write|compose|make up|tell me a joke|tell me a story)\b/i.test(q)) {
    return false;
  }
  // Pure arithmetic ("what is 17 x 24", "15% of 240") needs no web.
  if (/^[\d\s%+\-*/x×÷=().,]+$/i.test(q.replace(/^what is/i, ""))) {
    return false;
  }
  return true;
}

async function fetchLiveResults(question: string): Promise<LiveResult[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      SEARCH_ENDPOINT + "?q=" + encodeURIComponent(question),
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: LiveResult[] };
    return Array.isArray(data.results) ? data.results.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function withLiveContext(question: string, results: LiveResult[]): string {
  if (results.length === 0) return question;
  const lines = results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title} — ${r.snippet} (source: ${r.url})`,
    )
    .join("\n");
  return (
    question +
    "\n\nLIVE WEB RESULTS — you fetched these pages just now, before " +
    "answering. For anything current or factual, answer from these " +
    "results, not from memory:\n" +
    lines
  );
}

export interface AskCallbacks {
  /** Called with the full answer text so far, on every streamed chunk. */
  onChunk: (textSoFar: string) => void;
  /** On-device model download progress, 0..1, when Nano is downloading. */
  onDownloadProgress?: (fraction: number) => void;
  /** Fires the moment the SDK reports which lane is serving this answer. */
  onLaneKnown?: (lane: Lane) => void;
}

export interface SourceLink {
  title: string;
  uri: string;
}

export interface AskResult {
  text: string;
  lane: Lane;
  /** True when the lane came from the availability check, not the SDK. */
  laneInferred: boolean;
  availability: NanoAvailability;
  /** Web sources the cloud lane actually checked (search grounding). */
  sources: SourceLink[];
}

async function consume(
  model: GenerativeModel,
  question: string,
  callbacks: AskCallbacks,
  availability: NanoAvailability,
  initDevice: boolean,
): Promise<AskResult> {

  // initializeDeviceModel() must be called after/on a user interaction and
  // before the first prompt request — but ONLY on the hybrid model.
  // askPB() runs from the Ask button's submit handler, so we are inside
  // that gesture chain. Calling it on the plain cloud search model can
  // stall the ask indefinitely (observed live: the page sat on
  // "Checking on-device…" for minutes) — the search model is cloud-only
  // by construction and skips init entirely. A failure here (e.g. no
  // Prompt API) must never block the cloud lane either.
  if (initDevice) {
    try {
      await model.initializeDeviceModel((fraction) =>
        callbacks.onDownloadProgress?.(fraction),
      );
    } catch {
      // On-device init unavailable — PREFER_ON_DEVICE will use the cloud.
    }
  }

  const { stream, response } = await model.generateContentStream(question);

  let text = "";
  let lane: Lane | undefined;
  const noteLane = (source: InferenceSource | undefined) => {
    if (!source || lane) return;
    lane = source === InferenceSource.ON_DEVICE ? "on-device" : "cloud";
    callbacks.onLaneKnown?.(lane);
  };

  for await (const chunk of stream) {
    const piece = chunk.text();
    if (piece) {
      text += piece;
      callbacks.onChunk(text);
    }
    noteLane(chunk.inferenceSource);
  }

  const finalResponse = await response;
  noteLane(finalResponse.inferenceSource);

  let laneInferred = false;
  if (!lane) {
    // The SDK always reports inferenceSource on v12.5.0+; if we ever land
    // here, infer from the pre-call availability check and say so.
    lane = availability === "available" ? "on-device" : "cloud";
    laneInferred = true;
    callbacks.onLaneKnown?.(lane);
  }

  // Sources the cloud lane checked, from the response's grounding metadata.
  // Deduped, capped at 3 — enough to show the work without clutter.
  const sources: SourceLink[] = [];
  try {
    const chunks =
      finalResponse.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const uri = chunk.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ title: chunk.web?.title || uri, uri });
      if (sources.length >= 3) break;
    }
  } catch {
    // Grounding metadata is a bonus — never a reason to fail an answer.
  }

  return { text, lane, laneInferred, availability, sources };
}

export async function askPB(
  question: string,
  callbacks: AskCallbacks,
): Promise<AskResult> {
  if (!firebaseConfigured) {
    throw new Error(
      "Firebase is not configured yet. Copy .env.example to .env and fill in your Firebase project config, then reload.",
    );
  }

  // PB searches first, answers from what he finds: fetch live results
  // (fail-open) and fold them into the prompt for whichever lane
  // serves. The fetched pages become the answer's shown sources.
  const liveResults = needsLiveSearch(question)
    ? await fetchLiveResults(question)
    : [];
  const prompt = withLiveContext(question, liveResults);
  const fetchedSources: SourceLink[] = liveResults
    .slice(0, 3)
    .map((r) => ({ title: r.title, uri: r.url }));

  // Pre-call availability: drives the "checking on-device…" UI and is the
  // honest fallback signal if a response ever arrives without a source.
  const availability = await checkNanoAvailability();

  // Lane routing:
  // - Nano ready on this device → the hybrid model (on-device serves,
  //   private and offline-capable — the point of the hybrid build).
  // - Nano not ready → the plain cloud model. If its request ever fails
  //   before a single word streams, fall back to the hybrid model — an
  //   answer beats no answer. A failure after text has streamed is
  //   surfaced as-is.
  const finish = (result: AskResult): AskResult =>
    fetchedSources.length > 0 ? { ...result, sources: fetchedSources } : result;

  if (availability === "available") {
    return finish(
      await consume(getHybridModel(), prompt, callbacks, availability, true),
    );
  }
  let emitted = false;
  const tracking: AskCallbacks = {
    ...callbacks,
    onChunk: (textSoFar) => {
      emitted = true;
      callbacks.onChunk(textSoFar);
    },
  };
  try {
    return finish(
      await consume(getCloudModel(), prompt, tracking, availability, false),
    );
  } catch (err) {
    if (emitted) throw err;
    return finish(
      await consume(getHybridModel(), prompt, callbacks, availability, true),
    );
  }
}
