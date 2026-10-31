const {
  withAndroidManifest,
  withDangerousMod,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Lets the player talk to Esei's own loopback decryption server.
 *
 * Phase 2 plays saved (encrypted) songs through a tiny HTTP server bound to
 * 127.0.0.1 that decrypts on the fly. Android refuses cleartext HTTP by
 * default at this target SDK, loopback included, so without this the player
 * would reject the only URL a saved song can be played from.
 *
 * The permission is scoped as narrowly as Android allows: a network
 * security config that permits cleartext for 127.0.0.1 only and keeps it
 * denied everywhere else.
 *
 * This lives in a config plugin because android/ is generated and
 * `npx expo prebuild --clean` would discard hand edits.
 */

const CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
`;

function withConfigFile(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'network_security_config.xml'), CONFIG_XML);
      return cfg;
    },
  ]);
}

function withManifestEntry(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return cfg;
  });
}

module.exports = function withLoopbackCleartext(config) {
  config = withConfigFile(config);
  config = withManifestEntry(config);
  return config;
};
