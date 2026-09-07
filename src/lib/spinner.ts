import ora, { type Options, type Ora } from "ora";
import { printError, printSuccess } from "./output";

const TEXT_SPINNER = {
  frames: ["-", "\\", "|", "/"],
  interval: 100,
};

export function createSpinner(options: Options | string): Ora {
  const normalized: Options =
    typeof options === "string" ? { text: options } : options;
  const suppressFinalOutput = normalized.isSilent === true;
  const stream = normalized.stream ?? process.stderr;
  const isInteractive =
    "isTTY" in stream && (stream as NodeJS.WriteStream).isTTY === true;
  const animate = normalized.isEnabled ?? isInteractive;
  const spinner = ora({
    ...normalized,
    isSilent: suppressFinalOutput || !animate,
    spinner: TEXT_SPINNER,
  });

  spinner.succeed = (text?: string) => {
    spinner.stop();
    if (!suppressFinalOutput) {
      printSuccess(text ?? spinner.text);
    }
    return spinner;
  };
  spinner.fail = (text?: string) => {
    spinner.stop();
    if (!suppressFinalOutput) {
      printError(text ?? spinner.text);
    }
    return spinner;
  };

  return spinner;
}
