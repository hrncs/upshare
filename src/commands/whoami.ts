import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { resolveCommandContext } from "../lib/config";
import { getApiKeyPrefix, resolveProfileApiKey } from "../lib/credentials";
import { formatBytes, sanitizeTerminalText } from "../lib/format";
import { printFields, printHeading } from "../lib/output";
import { createSpinner } from "../lib/spinner";

const LEGACY_MONTHLY_QUOTA_BYTES = 53_687_091_200;

export async function whoamiCommand(options?: {
  apiUrl?: string;
  profile?: string;
}): Promise<void> {
  const spinner = createSpinner("Fetching account details...").start();
  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });

  try {
    const data = await client.verifyApiKey();
    spinner.stop();

    const used = formatBytes(data.quota.usedBytes);
    const max = formatBytes(data.quota.maxQuotaBytes);
    const remaining = formatBytes(
      Math.max(
        0,
        data.quota.maxQuotaBytes -
          data.quota.usedBytes -
          data.quota.reservedBytes
      )
    );

    printHeading("UpShare Account");
    const isLegacy =
      data.quota.isLegacy ??
      data.quota.maxQuotaBytes >= LEGACY_MONTHLY_QUOTA_BYTES;
    const context = resolveCommandContext({
      apiUrl: options?.apiUrl,
      profile: options?.profile,
    });
    const fields: [string, string][] = [
      ["Profile", context.profile],
      ["Name", pc.bold(data.user.name)],
      ["Email", data.user.email],
      [
        "Uploads",
        `${used} / ${max} this month (${remaining} left)${isLegacy ? ` ${pc.yellow("[Legacy]")}` : ""}`,
      ],
    ];
    try {
      const resolved = resolveProfileApiKey(context.profile, context.apiUrl);
      if (resolved) {
        const prefix = sanitizeTerminalText(getApiKeyPrefix(resolved.apiKey));
        const label =
          resolved.source === "environment"
            ? `${prefix} ${pc.dim("(from UPSHARE_API_KEY)")}`
            : prefix;
        fields.push(["API key", pc.gray(label)]);
      }
    } catch {
      // Ignore failure to resolve stored API key label
    }
    if (data.quota.reservedBytes > 0) {
      fields.push([
        "Pending",
        `${formatBytes(data.quota.reservedBytes)} unfinished - run \`upshare abort\` to free it`,
      ]);
    }
    printFields(fields);
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to fetch account info"
    );
    process.exitCode = 1;
  }
}
