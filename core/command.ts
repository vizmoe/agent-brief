import { spawn } from "node:child_process";
import type { CredentialExec } from "./secrets.ts";

/** Own the shell's process group so timeout, cancellation and exit retire helpers too. */
export function nativeCredentialExec(maxBytes: number): CredentialExec {
  return (command, args, options) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { resolve({ code: 1, stdout: "", stderr: "", killed: true }); return; }
    const child = spawn(command, args, {
      cwd: options.cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let killed = false;
    const terminate = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    };
    const abort = () => { killed = true; terminate(); };
    const timer = setTimeout(abort, options.timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) abort();
      else chunks.push(chunk);
    });
    child.once("error", () => { cleanup(); reject(new Error("credential command failed")); });
    child.once("exit", terminate);
    child.once("close", code => {
      cleanup();
      resolve({ code: code ?? 1, killed, stdout: Buffer.concat(chunks).toString("utf8"), stderr: "" });
    });
  });
}
