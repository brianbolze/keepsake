import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "local.keepsake.library";
const domain = `gui/${process.getuid!()}`;
const path = resolve(homedir(), "Library/LaunchAgents", label + ".plist");
const action = process.argv[2] || "status";
const run = (args: string[]) =>
  spawnSync("launchctl", args, { encoding: "utf8" });
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
if (process.platform !== "darwin")
  throw new Error(
    "The login service installer supports macOS only. Use npm start on other systems.",
  );
if (action === "install") {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(resolve(root, "data"), { recursive: true, mode: 0o700 });
  if (existsSync(path))
    throw new Error(
      "Keepsake login service already exists. Check status or uninstall it first.",
    );
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(root, "src/cli.ts"))}</string><string>serve</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(resolve(root, "data/service.log"))}</string><key>StandardErrorPath</key><string>${xml(resolve(root, "data/service-error.log"))}</string></dict></plist>`;
  writeFileSync(path, plist, { mode: 0o600 });
  const result = run(["bootstrap", domain, path]);
  if (result.status !== 0) {
    unlinkSync(path);
    throw new Error(result.stderr || "Could not start login service");
  }
  console.log("Keepsake starts now and at login. http://127.0.0.1:47821");
} else if (action === "uninstall") {
  if (existsSync(path)) {
    const result = run(["bootout", domain, path]);
    if (
      result.status !== 0 &&
      !/No such process|Could not find specified service/i.test(result.stderr)
    )
      throw new Error(result.stderr);
    unlinkSync(path);
  }
  console.log("Login service removed. Your library is preserved.");
} else if (action === "status") {
  const result = run(["print", domain + "/" + label]);
  console.log(
    result.status === 0
      ? result.stdout
      : "Keepsake login service is not installed or not running.",
  );
} else throw new Error("Use install, uninstall, or status");
