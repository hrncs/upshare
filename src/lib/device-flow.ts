import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";

export const DEVICE_FLOW_TIMEOUT_MS = 120_000;
const DEVICE_STATE_BYTES = 32;

export function generateDeviceState(): string {
  return randomBytes(DEVICE_STATE_BYTES).toString("hex");
}

export function buildAuthorizeUrl(
  apiUrl: string,
  port: number,
  state: string,
  mode: "signup" | "login" = "signup"
): string {
  const params = new URLSearchParams({
    mode,
    port: String(port),
    state,
  });
  return `${apiUrl}/cli/authorize?${params.toString()}`;
}

export function openBrowser(url: string): boolean {
  try {
    const { platform } = process;
    let command: string;
    if (platform === "win32") {
      command = `start "" "${url}"`;
    } else if (platform === "darwin") {
      command = `open "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }
    exec(command, () => {});
    return true;
  } catch {
    return false;
  }
}

export interface LoopbackServer {
  close: () => void;
  port: number;
  waitForCallback: () => Promise<{ code: string; state: string }>;
}

function successPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CLI Connected | UpShare</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#090909;color:#ededed;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:100%;max-width:420px;padding:36px 32px 15px;text-align:center;background:#111;border:1px solid #232323;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35)}.status{width:52px;height:52px;margin:0 auto 2px;display:grid;place-items:center;background:none;border:none;transform:translateY(-8px)}.status svg{width:34px;height:34px;display:block}h1{margin:0 0 10px;font-size:26px;font-weight:650;letter-spacing:-.02em}p{margin:0;color:#999;font-size:15px;line-height:1.6}.brand{margin-top:10px;color:#4f8cff;font-size:13px;font-weight:700}</style></head><body><main class="card"><div class="status" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="20px" height="20px" viewBox="0 0 20 20"><path d="m17.999,10c0-1.097-.567-2.113-1.465-2.707.215-1.054-.103-2.174-.878-2.95-.775-.776-1.896-1.094-2.95-.878-.593-.897-1.609-1.464-2.706-1.464s-2.113.567-2.706,1.464c-1.053-.216-2.174.102-2.95.878s-1.093,1.896-.878,2.949c-.897.593-1.465,1.61-1.465,2.707s.567,2.113,1.465,2.707c-.215,1.054.103,2.174.878,2.95s1.898,1.092,2.95.878c.593.897,1.609,1.464,2.706,1.464s2.113-.568,2.706-1.465c1.059.214,2.176-.103,2.95-.878.776-.776,1.094-1.896.878-2.95.897-.593,1.465-1.609,1.465-2.707Zm-4.218-1.875l-4,5c-.178.222-.442.358-.726.374-.019,0-.037.001-.056.001-.265,0-.52-.105-.707-.293l-2-2c-.391-.391-.391-1.023,0-1.414s1.023-.391,1.414,0l1.21,1.21,3.302-4.127c.347-.43.975-.502,1.406-.156.431.345.501.974.156,1.405Z" stroke-width="0" fill="#00e676"></path></svg></div><h1>Connected</h1><p>UpShare CLI is connected successfully.<br>You can close this tab and return to your terminal.</p><div class="brand">UpShare CLI</div></main></body></html>`;
}

function errorPage(message: string, title: string): string {
  const safeMessage = message.replace(/[<>&"]/g, "");
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeTitle} | UpShare</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#090909;color:#ededed;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:100%;max-width:420px;padding:36px 32px 15px;text-align:center;background:#111;border:1px solid #232323;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35)}.status{width:52px;height:52px;margin:0 auto 2px;display:grid;place-items:center;background:none;border:none;transform:translateY(-8px)}.status svg{width:34px;height:34px;display:block}h1{margin:0 0 10px;font-size:26px;font-weight:650;letter-spacing:-.02em}p{margin:0;color:#999;font-size:15px;line-height:1.6}.brand{margin-top:10px;color:#4f8cff;font-size:13px;font-weight:700}</style></head><body><main class="card"><div class="status" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="20px" height="20px" viewBox="0 0 20 20"><path d="m17.794,12.5L12.598,3.5c-.542-.939-1.514-1.5-2.598-1.5s-2.056.561-2.598,1.5L2.206,12.5c-.542.938-.543,2.061,0,3,.542.939,1.514,1.5,2.598,1.5h10.393c1.084,0,2.056-.561,2.598-1.5.542-.939.542-2.062,0-3Zm-8.794-5.5c0-.552.447-1,1-1s1,.448,1,1v3.5c0,.552-.447,1-1,1s-1-.448-1-1v-3.5Zm1,8c-.689,0-1.25-.561-1.25-1.25s.561-1.25,1.25-1.25,1.25.561,1.25,1.25-.561,1.25-1.25,1.25Z" stroke-width="0" fill="#ff3b30"></path></svg></div><h1>Something went wrong</h1><p>${safeMessage}</p><div class="brand">UpShare CLI</div></main></body></html>`;
}

export async function startLoopbackServer(
  expectedState: string,
  options?: { port?: number; timeoutMs?: number }
): Promise<LoopbackServer> {
  const timeoutMs = options?.timeoutMs ?? DEVICE_FLOW_TIMEOUT_MS;
  const preferredPort = options?.port ?? 0;

  let resolveCallback!: (value: { code: string; state: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    }
  );

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found. This server only handles /callback.");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!(code && state)) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorPage("Missing code or state.", "Incomplete Sign-in"));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          errorPage("State mismatch. Run the command again.", "Invalid Session")
        );
        rejectCallback(new Error("State mismatch in browser callback."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(successPage());
      resolveCallback({ code, state });
    } catch {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(errorPage("Invalid callback.", "Invalid Request"));
    }
  });

  const timeout = setTimeout(() => {
    rejectCallback(
      new Error("Timed out waiting for browser sign-in. Run the command again.")
    );
    try {
      server.close();
    } catch {}
  }, timeoutMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
  callbackPromise.then(
    () => clearTimeout(timeout),
    () => clearTimeout(timeout)
  );

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("Could not start local callback server."));
      }
    });
  }).catch((error: unknown) => {
    clearTimeout(timeout);
    try {
      server.close();
    } catch {}
    throw error instanceof Error
      ? error
      : new Error("Could not start local callback server.");
  });

  return {
    close: () => {
      clearTimeout(timeout);
      try {
        server.close();
      } catch {}
    },
    port,
    waitForCallback: () => callbackPromise,
  };
}
