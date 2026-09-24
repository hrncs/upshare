import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";

export type OutputField = readonly [label: string, value: string];

function visibleLength(value: string): number {
  return stripVTControlCharacters(value).length;
}

function isColorEnabled(stream: NodeJS.WriteStream): boolean {
  if (!pc.isColorSupported) {
    return false;
  }
  if (process.env.FORCE_COLOR) {
    return true;
  }
  return stream?.isTTY === true;
}

function isStdoutColorEnabled(): boolean {
  return isColorEnabled(process.stdout);
}

function isStderrColorEnabled(): boolean {
  return isColorEnabled(process.stderr);
}

export function printError(message: string, hint?: string): void {
  if (!isStderrColorEnabled()) {
    console.error(`Error: ${message}`);
    if (hint) {
      console.error(`  Try: ${hint}`);
    }
    return;
  }
  console.error(`${pc.bold(pc.red("Error:"))} ${pc.red(message)}`);
  if (hint) {
    console.error(`  ${pc.dim("Try:")} ${hint}`);
  }
}

export function printFields(fields: OutputField[]): void {
  let width = 0;
  for (const [label] of fields) {
    const len = visibleLength(label);
    if (len > width) {
      width = len;
    }
  }
  const useColor = isStdoutColorEnabled();
  for (const [label, value] of fields) {
    const padded =
      label + " ".repeat(Math.max(0, width - visibleLength(label)));
    console.log(`  ${useColor ? pc.dim(padded) : padded}  ${value}`);
  }
}

export function printHeading(title: string): void {
  console.log();
  console.log(isStdoutColorEnabled() ? pc.bold(title) : title);
  console.log();
}

export function printSuccess(message: string): void {
  console.log(isStdoutColorEnabled() ? pc.green(message) : message);
}

export function printWarning(message: string): void {
  if (!isStderrColorEnabled()) {
    console.warn(`Warning: ${message}`);
    return;
  }
  console.warn(`${pc.bold(pc.yellow("Warning:"))} ${pc.yellow(message)}`);
}
