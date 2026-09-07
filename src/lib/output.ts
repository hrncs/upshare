import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";

export type OutputField = readonly [label: string, value: string];

function visibleLength(value: string): number {
  return stripVTControlCharacters(value).length;
}

function isStdoutColorEnabled(): boolean {
  if (!pc.isColorSupported) {
    return false;
  }
  if (process.env.FORCE_COLOR) {
    return true;
  }
  return process.stdout?.isTTY === true;
}

function isStderrColorEnabled(): boolean {
  if (!pc.isColorSupported) {
    return false;
  }
  if (process.env.FORCE_COLOR) {
    return true;
  }
  return process.stderr?.isTTY === true;
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
  const width = Math.max(...fields.map(([label]) => visibleLength(label)), 0);
  const useColor = isStdoutColorEnabled();
  for (const [label, value] of fields) {
    const padded = label.padEnd(width);
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
