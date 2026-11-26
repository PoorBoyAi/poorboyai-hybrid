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
const CLOUD_MODEL = "gemini-3.5-flash-lite";

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

function getModel(): GenerativeModel {
  if (cachedModel) return cachedModel;
  if (!firebaseApp) {
    throw new Error(
      "Firebase is not configured yet. Copy .env.example to .env and fill in your Firebase project config, then reload.",
    );
  }
  const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
  cachedModel = getGenerativeModel(ai, {
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
  return cachedModel;
}

export interface AskCallbacks {
  /** Called with the full answer text so far, on every streamed chunk. */
  onChunk: (textSoFar: string) => void;
  /** On-device model download progress, 0..1, when Nano is downloading. */
  onDownloadProgress?: (fraction: number) => void;
  /** Fires the moment the SDK reports which lane is serving this answer. */
  onLaneKnown?: (lane: Lane) => void;
}

export interface AskResult {
  text: string;
  lane: Lane;
  /** True when the lane came from the availability check, not the SDK. */
  laneInferred: boolean;
  availability: NanoAvailability;
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
  const model = getModel();

  // Pre-call availability: drives the "checking on-device…" UI and is the
  // honest fallback signal if a response ever arrives without a source.
  const availability = await checkNanoAvailability();

  // initializeDeviceModel() must be called after/on a user interaction and
  // before the first prompt request. askPB() runs from the Ask button's
  // submit handler, so we are inside that gesture chain. A failure here
  // (e.g. no Prompt API) must never block the cloud lane.
  try {
    await model.initializeDeviceModel((fraction) =>
      callbacks.onDownloadProgress?.(fraction),
    );
  } catch {
    // On-device init unavailable — PREFER_ON_DEVICE will use the cloud.
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

  return { text, lane, laneInferred, availability };
}
