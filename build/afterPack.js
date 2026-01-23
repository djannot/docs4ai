const fs = require("fs");
const path = require("path");

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

exports.default = async function afterPack(context) {
  // Only for Windows builds
  if (context.electronPlatformName !== "win32") return;

  const appOutDir = context.appOutDir;
  const unwanted = path.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "sqlite-vec",
    "node_modules",
    "sqlite-vec-linux-x64"
  );

  rmrf(unwanted);

  // Optional: fail hard if it somehow still exists
  if (fs.existsSync(unwanted)) {
    throw new Error(`Failed to remove ${unwanted}`);
  }
};