import { type OutputStream, Spinner } from "picospinner";
import { printError, printSuccess } from "./output";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
export const SPINNER_INTERVAL_MS = 80;

export interface CreateSpinnerOptions {
  isEnabled?: boolean;
  isSilent?: boolean;
  stream?: OutputStream;
  text?: string;
}

export interface UpshareSpinner {
  fail: (text?: string) => UpshareSpinner;
  start: () => UpshareSpinner;
  stop: () => UpshareSpinner;
  succeed: (text?: string) => UpshareSpinner;
  text: string;
}

export function createSpinner(
  options: CreateSpinnerOptions | string
): UpshareSpinner {
  const normalized: CreateSpinnerOptions =
    typeof options === "string" ? { text: options } : options;
  const userSilent = normalized.isSilent === true;
  const stream = (normalized.stream ?? process.stderr) as OutputStream;
  const isInteractive =
    "isTTY" in stream && (stream as NodeJS.WriteStream).isTTY === true;
  const animate = normalized.isEnabled ?? isInteractive;

  let currentText = normalized.text ?? "";
  const pico =
    userSilent || !animate
      ? undefined
      : new Spinner(
          { stream, text: currentText },
          { colors: { spinner: "magenta" }, frames: SPINNER_FRAMES }
        );

  const spinner: UpshareSpinner = {
    fail(text?: string) {
      if (text !== undefined) {
        currentText = text;
      }
      if (pico?.running) {
        pico.stop();
      }
      if (!userSilent && currentText) {
        printError(currentText);
      }
      return spinner;
    },
    start() {
      if (pico && !pico.running) {
        pico.start(SPINNER_INTERVAL_MS);
      }
      return spinner;
    },
    stop() {
      if (pico?.running) {
        pico.stop();
      }
      return spinner;
    },
    succeed(text?: string) {
      if (text !== undefined) {
        currentText = text;
      }
      if (pico?.running) {
        pico.stop();
      }
      if (!userSilent && currentText) {
        printSuccess(currentText);
      }
      return spinner;
    },
    get text() {
      return currentText;
    },
    set text(value: string) {
      currentText = value;
      if (pico?.running) {
        pico.setText(value);
      }
    },
  };

  return spinner;
}
