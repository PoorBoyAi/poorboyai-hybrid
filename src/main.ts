import "./style.css";
import { askPB, checkNanoAvailability, type Lane, type NanoAvailability } from "./ask";
import { firebaseConfigured } from "./firebase";

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const nanoStatus = $<HTMLParagraphElement>("#nano-status");
const form = $<HTMLFormElement>("#ask-form");
const input = $<HTMLInputElement>("#question");
const askBtn = $<HTMLButtonElement>("#ask-btn");
const setupBanner = $<HTMLParagraphElement>("#setup-banner");
const answerCard = $<HTMLElement>("#answer-card");
const badge = $<HTMLSpanElement>("#lane-badge");
const answerState = $<HTMLParagraphElement>("#answer-state");
const answerText = $<HTMLParagraphElement>("#answer-text");
const answerMeta = $<HTMLParagraphElement>("#answer-meta");

if (!firebaseConfigured) {
  setupBanner.hidden = false;
}

const AVAILABILITY_LINES: Record<NanoAvailability, string> = {
  available: "Gemini Nano is on this device — answers can run 100% on-device.",
  downloadable:
    "Gemini Nano can be downloaded to this device — the first on-device answer will fetch the model, then it's local.",
  downloading: "Gemini Nano is downloading to this device right now…",
  unavailable:
    "Gemini Nano isn't available on this device — PB will answer from the cloud.",
  unsupported:
    "This browser has no Prompt API (needs Chrome 139+ on desktop) — PB will answer from the cloud.",
};

void checkNanoAvailability().then((availability) => {
  nanoStatus.textContent = AVAILABILITY_LINES[availability];
  nanoStatus.dataset.availability = availability;
});

function setBadge(state: "checking" | Lane, inferred = false) {
  badge.className = "badge";
  if (state === "checking") {
    badge.classList.add("badge-checking");
    badge.textContent = "Checking on-device…";
  } else if (state === "on-device") {
    badge.classList.add("badge-device");
    badge.textContent = inferred
      ? "On-device · Gemini Nano (inferred)"
      : "On-device · Gemini Nano";
  } else {
    badge.classList.add("badge-cloud");
    badge.textContent = inferred
      ? "Cloud · Gemini (inferred)"
      : "Cloud · Gemini";
  }
}

let asking = false;

async function runAsk(question: string) {
  if (asking || !question.trim()) return;
  asking = true;
  askBtn.disabled = true;
  input.disabled = true;

  answerCard.hidden = false;
  answerText.textContent = "";
  answerMeta.textContent = "";
  setBadge("checking");
  answerState.textContent = "Checking on-device…";

  try {
    const result = await askPB(question, {
      onChunk: (textSoFar) => {
        answerState.textContent = "";
        answerText.textContent = textSoFar;
      },
      onDownloadProgress: (fraction) => {
        answerState.textContent = `Downloading Gemini Nano to this device… ${Math.round(fraction * 100)}%`;
      },
      onLaneKnown: (lane) => setBadge(lane),
    });
    setBadge(result.lane, result.laneInferred);
    answerState.textContent = "";
    if (!result.text) {
      answerText.textContent = "(PB didn't have anything to say to that one — try another question.)";
    }
    answerMeta.textContent =
      result.lane === "on-device"
        ? "Answered by Gemini Nano on your device. Your question never left this machine."
        : "Answered by Gemini in the cloud through Firebase AI Logic.";
    if (result.laneInferred) {
      answerMeta.textContent +=
        " (The SDK didn't report a lane for this response, so the badge is inferred from the pre-call availability check.)";
    }
  } catch (err) {
    badge.className = "badge badge-error";
    badge.textContent = "Something went wrong";
    answerState.textContent = "";
    answerText.textContent =
      err instanceof Error ? err.message : "PB hit a snag answering that. Try again.";
  } finally {
    asking = false;
    askBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void runAsk(input.value);
});

document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.q ?? "";
    void runAsk(input.value);
  });
});
