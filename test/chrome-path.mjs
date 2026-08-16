// Resolves the pinned Chrome for Testing binary, shared by the browser tests
// and the benchmarks so they cannot drift apart per platform.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const chromePath = () => {
  const root = path.resolve(here, '../.chrome-for-testing/chrome');
  // the install dir also holds a .metadata entry, so pick the versioned one
  const version = fs.existsSync(root) && fs.readdirSync(root).find((d) => !d.startsWith('.'));
  if (!version) throw new Error('Chrome for Testing missing — run: npm run e2e:setup');

  // e.g. mac_arm-152.0.7977.42/chrome-mac-arm64, linux-152.0.7977.42/chrome-linux64
  const platform = fs.readdirSync(path.join(root, version))[0];
  const binary = platform.includes('mac')
    ? ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
    : [platform.includes('win') ? 'chrome.exe' : 'chrome'];

  return path.join(root, version, platform, ...binary);
};

// Shared launch flags. Headless would be simpler but cannot load extensions or
// capture tabs, so everything runs headful (under Xvfb on CI).
export const launchArgs = (ext) => [
  `--disable-extensions-except=${ext}`,
  `--load-extension=${ext}`,
  // Chrome 137+ ignores --load-extension unless this feature is disabled.
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check',
  // Ubuntu 23.10+ restricts unprivileged user namespaces under AppArmor, so
  // Chrome finds "no usable sandbox" and aborts on GitHub runners. Only
  // loosened on CI, which is a throwaway VM browsing our own fixture pages.
  ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
];
