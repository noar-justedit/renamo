/*
 * renamo - afterSign hook: notarize and staple the .app
 *
 * electron-builder signs the app, then calls this file. We hand the signed .app
 * to Apple's notarytool, wait for the verdict, and staple the ticket into the
 * bundle so the app opens without a Gatekeeper warning even offline. The DMG is
 * assembled afterwards, so it ships an already-stapled app.
 *
 * Credentials come from a keychain profile created once with:
 *   xcrun notarytool store-credentials renamo-notarization \
 *     --apple-id <your-apple-id> --team-id <TEAMID> --password <app-specific-password>
 *
 * Environment:
 *   NOTARY_PROFILE=<name>   use another keychain profile (default renamo-notarization)
 *   SKIP_NOTARIZE=1         build without notarizing (local test builds)
 *
 * This hook fails the build rather than silently producing an un-notarized app.
 */
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PROFILE = process.env.NOTARY_PROFILE || 'renamo-notarization';

// codesign prints its whole report on stderr, even when it succeeds, so both
// streams have to be merged. execFileSync would only hand back stdout, which is
// empty here - that is exactly the trap this function exists to avoid.
function codesignReport(appPath) {
  const res = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  return String((res.stdout || '') + (res.stderr || ''));
}

function assertDeveloperIdSignature(appPath) {
  const report = codesignReport(appPath);
  if (/Authority=Developer ID Application/.test(report)) return;
  const adhoc = /Signature=adhoc/.test(report) || /code object is not signed/.test(report);
  throw new Error(
    'The app is ' + (adhoc ? 'not signed with' : 'missing') + ' a Developer ID Application certificate, ' +
    'so Apple would reject it.\n' +
    '  - check the certificate is in your login keychain:  security find-identity -v -p codesigning\n' +
    '  - or build without notarizing:                      ./build.sh --no-notarize\n' +
    '  what codesign reported for ' + appPath + ':\n' +
    (report.trim() ? report.trim().split('\n').slice(0, 12).map(l => '    ' + l).join('\n') : '    (nothing)') + '\n'
  );
}

function assertProfileExists() {
  try {
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      'notarytool cannot use the keychain profile "' + PROFILE + '".\n' +
      '  Create it once with:\n' +
      '    xcrun notarytool store-credentials ' + PROFILE + ' \\\n' +
      '      --apple-id <your-apple-id> --team-id <TEAMID> --password <app-specific-password>\n' +
      '  notarytool said:\n  ' + String(err.stderr || err.message).trim().split('\n').join('\n  ') + '\n'
    );
  }
}

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('  notarize: skipped (SKIP_NOTARIZE=1) - this build shows a Gatekeeper warning');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, appName + '.app');

  assertDeveloperIdSignature(appPath);
  assertProfileExists();

  // @electron/notarize v3 is ESM only: import it dynamically from this CommonJS hook.
  const { notarize } = await import('@electron/notarize');

  console.log('  notarize: submitting ' + appName + '.app to Apple, usually 2 to 10 minutes...');
  const started = Date.now();
  await notarize({ appPath, keychainProfile: PROFILE });
  console.log('  notarize: approved and stapled in ' + Math.round((Date.now() - started) / 1000) + 's');
};

// electron-builder accepts either shape depending on how the hook is loaded.
module.exports.default = module.exports;
