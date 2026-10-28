'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;

var ASOUND_FILE = '/etc/asound.conf';
var BT_MARK_START = '#------ BluetoothOut section -------';
var BT_MARK_END = '#------ End of BluetoothOut section ------';
var MPD_CONF = '/etc/mpd.conf';
var MPD_OUTPUT_NAME = 'Bluetooth Output';

module.exports = ControllerBluetoothOut;

function ControllerBluetoothOut(context) {
  var self = this;
  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;
}

// ---------- Volumio plugin lifecycle ----------

ControllerBluetoothOut.prototype.onVolumioStart = function () {
  var self = this;
  var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
  return libQ.resolve();
};

ControllerBluetoothOut.prototype.getConfigurationFiles = function () {
  return ['UIConfig.json'];
};

ControllerBluetoothOut.prototype.onStart = function () {
  var self = this;
  var defer = libQ.defer();

  if (self.config.get('enabled') && self.config.get('deviceMac')) {
    // The Bluetooth adapter/bluetoothd may not be fully up yet this early in
    // the boot sequence; give it a few seconds before the first connect try.
    setTimeout(function () {
      self.enableBluetoothOutput(self.config.get('deviceMac'))
        .fail(function (e) {
          self.logger.error('[BluetoothOut] onStart failed: ' + e);
        });
    }, 8000);
    defer.resolve();
  } else {
    defer.resolve();
  }

  return defer.promise;
};

ControllerBluetoothOut.prototype.onStop = function () {
  var self = this;
  return self.disableBluetoothOutput();
};

ControllerBluetoothOut.prototype.onRestart = function () {};

// ---------- UI ----------

ControllerBluetoothOut.prototype.getUIConfig = function () {
  var self = this;
  var defer = libQ.defer();
  var lang_code = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  ).then(function (uiconf) {
    var devices = self.getDiscoveredDevices();
    var currentMac = self.config.get('deviceMac') || '';
    var currentName = self.config.get('deviceName') || '';

    // Always make sure the currently configured device (if any) shows up in
    // the list even if it wasn't part of the last scan (e.g. after a reboot).
    if (currentMac && !devices.some(function (d) { return d.mac === currentMac; })) {
      devices.push({ mac: currentMac, name: currentName || currentMac });
    }

    var options = devices.map(function (d) {
      return { value: d.mac, label: (d.name || d.mac) + ' (' + d.mac + ')' };
    });

    var selectedOption = options.find(function (o) { return o.value === currentMac; }) ||
      { value: '', label: '-- no device selected --' };

    uiconf.sections[0].content[1].value = self.config.get('enabled');
    uiconf.sections[0].content[2].options = options;
    uiconf.sections[0].content[2].value = selectedOption;
    uiconf.sections[0].content[3].value = currentName;
    uiconf.sections[0].content[4].value = self.config.get('connectionStatus');
    defer.resolve(uiconf);
  }).fail(function (e) {
    self.logger.error('[BluetoothOut] getUIConfig failed: ' + e);
    defer.reject(new Error());
  });

  return defer.promise;
};

// Parse self.config's cached scan results into a plain array of {mac, name}.
ControllerBluetoothOut.prototype.getDiscoveredDevices = function () {
  var self = this;
  try {
    var raw = self.config.get('discoveredDevicesJson');
    var parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

// Triggered by the "Scan for devices" button. Runs a short bluetoothctl
// discovery session and stores the results for getUIConfig() to display.
ControllerBluetoothOut.prototype.scanForDevices = function () {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.pushToastMessage('info', 'Bluetooth Output', 'Сканирование Bluetooth-устройств (10 сек)...');

  var scanScript =
    '{ echo "power on"; echo "scan on"; sleep 8; echo "quit"; } | bluetoothctl';

  // Run discovery first (its stdout is full of noisy [CHG]/RSSI lines we don't
  // want to parse), then separately ask for the clean "devices" listing -
  // that command's output is just "Device <MAC> <Name>" per line, no noise.
  run(scanScript, { timeout: 15000 })
    .then(function () { return run('bluetoothctl devices'); })
    .then(function (stdout) {
      var devices = [];
      var seen = {};
      var re = /^Device\s+([0-9A-Fa-f:]{17})\s+(.+)$/gm;
      var m;
      while ((m = re.exec(stdout)) !== null) {
        var mac = m[1].toUpperCase();
        var name = m[2].trim();
        // Skip entries where the "name" is just the MAC with dashes (unnamed device)
        if (name.replace(/-/g, ':').toUpperCase() === mac) { continue; }
        if (!seen[mac]) { seen[mac] = true; devices.push({ mac: mac, name: name }); }
      }

      self.config.set('discoveredDevicesJson', JSON.stringify(devices));
      self.commandRouter.pushToastMessage('success', 'Bluetooth Output',
        'Найдено устройств: ' + devices.length + '. Закройте и снова откройте эту страницу настроек, чтобы увидеть их в списке.');
      defer.resolve({});
    })
    .fail(function (e) {
      self.logger.error('[BluetoothOut] scanForDevices failed: ' + e);
      self.commandRouter.pushToastMessage('error', 'Bluetooth Output', 'Ошибка сканирования: ' + e);
      defer.resolve({});
    });

  return defer.promise;
};

ControllerBluetoothOut.prototype.saveBluetoothConfig = function (data) {
  var self = this;
  var defer = libQ.defer();

  // Volumio's "select" element submits the whole {value, label} option object,
  // not a bare string - handle both shapes defensively.
  var rawMac = data['deviceMac'];
  if (rawMac && typeof rawMac === 'object') { rawMac = rawMac.value; }
  var mac = (rawMac || '').toString().trim().toUpperCase();
  var macRegex = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

  if (data['enabled'] && !macRegex.test(mac)) {
    self.commandRouter.pushToastMessage('error', 'Bluetooth Output',
      'Устройство не выбрано или MAC-адрес некорректен. Нажмите "Просканировать устройства" и выберите устройство из списка.');
    defer.resolve({});
    return defer.promise;
  }

  var previousMac = self.config.get('deviceMac') || '';
  var deviceChanged = mac && previousMac && mac !== previousMac;

  var deviceName = mac;
  var known = self.getDiscoveredDevices().find(function (d) { return d.mac === mac; });
  if (known && known.name) { deviceName = known.name; }

  self.config.set('deviceMac', mac);
  self.config.set('deviceName', deviceName);
  self.config.set('enabled', data['enabled']);

  var prep = libQ.resolve();
  if (deviceChanged) {
    self.logger.info('[BluetoothOut] switching device from ' + previousMac + ' to ' + mac);
    prep = run('mpc disable "' + MPD_OUTPUT_NAME + '"').fail(function () {})
      .then(function () { return run('bluetoothctl disconnect ' + previousMac).fail(function () {}); });
  }

  prep.then(function () {
    return data['enabled']
      ? self.enableBluetoothOutput(mac)
      : self.disableBluetoothOutput();
  }).then(function () {
    self.commandRouter.pushToastMessage('success', 'Bluetooth Output',
      data['enabled'] ? 'Bluetooth-выход включён (' + deviceName + ')' : 'Bluetooth-выход выключен');
    defer.resolve({});
  }).fail(function (e) {
    self.logger.error('[BluetoothOut] saveBluetoothConfig failed: ' + e);
    self.config.set('connectionStatus', 'Error: ' + e);
    self.commandRouter.pushToastMessage('error', 'Bluetooth Output', 'Ошибка: ' + e);
    defer.resolve({});
  });

  return defer.promise;
};

// ---------- Core logic ----------

// Run a shell command, resolve with stdout, reject with stderr/error.
function run(cmd, opts) {
  var defer = libQ.defer();
  exec(cmd, opts || { timeout: 20000 }, function (err, stdout, stderr) {
    if (err) {
      defer.reject(new Error((stderr || err.message || '').toString().trim() || cmd + ' failed'));
    } else {
      defer.resolve((stdout || '').toString().trim());
    }
  });
  return defer.promise;
}

ControllerBluetoothOut.prototype.ensureBlueAlsaInstalled = function () {
  var self = this;
  var defer = libQ.defer();

  try {
    execSync('dpkg -s bluealsa', { stdio: 'ignore' });
    defer.resolve();
  } catch (e) {
    self.logger.info('[BluetoothOut] bluealsa not installed, installing via apt...');
    self.config.set('connectionStatus', 'Installing bluealsa...');
    // volumio user has passwordless sudo for apt-get/systemctl (see /etc/sudoers.d) -
    // the backend itself runs unprivileged, so these MUST go through sudo.
    // NOTE: on this Buster-based image, raspbian.raspberrypi.org is EOL/404 for some
    // package versions (e.g. libbluetooth3's "candidate"); archive.raspberrypi.org
    // still serves a working libbluetooth3 build, so pin it explicitly as a fallback.
    run('sudo apt-get update; sudo apt-get install -y bluealsa', { timeout: 180000, maxBuffer: 1024 * 1024 * 10 })
      .fail(function () {
        self.logger.info('[BluetoothOut] plain bluealsa install failed, retrying with pinned libbluetooth3 (archive.raspberrypi.org)');
        return run('sudo apt-get install -y bluealsa libbluetooth3=5.50-1.2~deb10u3+rpt1', { timeout: 180000, maxBuffer: 1024 * 1024 * 10 });
      })
      .then(function () {
        // bluealsa.service is a static unit on this image (no [Install] section),
        // so 'enable' is a no-op/warning - just make sure it's started.
        return run('sudo systemctl start bluealsa');
      })
      .then(function () { defer.resolve(); })
      .fail(function (e2) { defer.reject(e2); });
  }

  return defer.promise;
};

// Write/refresh the ALSA pcm.bluetoothOut block in /etc/asound.conf, bracketed
// by marker comments so it can be found & replaced/removed idempotently.
ControllerBluetoothOut.prototype.writeAsoundBlock = function (mac) {
  var self = this;
  var defer = libQ.defer();

  try {
    var content = fs.existsSync(ASOUND_FILE) ? fs.readFileSync(ASOUND_FILE, 'utf8') : '';

    var startIdx = content.indexOf(BT_MARK_START);
    var endIdx = content.indexOf(BT_MARK_END);
    if (startIdx !== -1 && endIdx !== -1) {
      content = content.slice(0, startIdx) + content.slice(endIdx + BT_MARK_END.length);
    }

    var block = '\n' + BT_MARK_START + '\n' +
      'pcm.bluetoothOut {\n' +
      '  type plug\n' +
      '  slave.pcm {\n' +
      '    type bluealsa\n' +
      '    device "' + mac + '"\n' +
      '    profile "a2dp"\n' +
      '  }\n' +
      '}\n' +
      'ctl.bluetoothOut {\n' +
      '  type bluealsa\n' +
      '}\n' +
      BT_MARK_END + '\n';

    var finalContent = content.trimEnd() + '\n' + block;
    var tmpFile = '/tmp/.bt_out_asound_' + Date.now() + '.conf';
    fs.writeFileSync(tmpFile, finalContent);
    // /etc/asound.conf is root-owned; volumio user only has NOPASSWD sudo for
    // specific binaries (tee, mv, chmod, ...), not an arbitrary editor, so we
    // write as ourselves to /tmp then let root 'tee' it into place.
    run('cat ' + tmpFile + ' | sudo tee ' + ASOUND_FILE + ' > /dev/null')
      .then(function () {
        try { fs.unlinkSync(tmpFile); } catch (e2) { /* non-fatal */ }
        defer.resolve();
      })
      .fail(function (e3) { defer.reject(e3); });
  } catch (e) {
    defer.reject(e);
  }

  return defer.promise;
};

ControllerBluetoothOut.prototype.removeAsoundBlock = function () {
  var defer = libQ.defer();
  try {
    if (!fs.existsSync(ASOUND_FILE)) { defer.resolve(); return defer.promise; }

    var content = fs.readFileSync(ASOUND_FILE, 'utf8');
    var startIdx = content.indexOf(BT_MARK_START);
    var endIdx = content.indexOf(BT_MARK_END);
    if (startIdx === -1 || endIdx === -1) { defer.resolve(); return defer.promise; }

    content = content.slice(0, startIdx) + content.slice(endIdx + BT_MARK_END.length);
    var tmpFile = '/tmp/.bt_out_asound_' + Date.now() + '.conf';
    fs.writeFileSync(tmpFile, content);
    run('cat ' + tmpFile + ' | sudo tee ' + ASOUND_FILE + ' > /dev/null')
      .then(function () {
        try { fs.unlinkSync(tmpFile); } catch (e2) { /* non-fatal */ }
        defer.resolve();
      })
      .fail(function (e3) { defer.reject(e3); });
  } catch (e) {
    defer.reject(e);
  }
  return defer.promise;
};

// Ensure the mpd.conf has our "Bluetooth Output" audio_output stanza
// (device bound to the pcm.bluetoothOut alias we wrote into asound.conf).
// Returns true if mpd.conf was changed (needs restart), false otherwise.
ControllerBluetoothOut.prototype.ensureMpdOutputStanza = function () {
  var defer = libQ.defer();
  try {
    var content = fs.readFileSync(MPD_CONF, 'utf8');
    // Match any amount/kind of whitespace between "name" and the quoted value -
    // mpd.conf gets rewritten/reformatted by Volumio's own alsa_controller on
    // every boot, so never assume a specific tab/space layout survives.
    var existsRe = new RegExp('name\\s+"' + MPD_OUTPUT_NAME + '"');
    if (existsRe.test(content)) {
      defer.resolve(false);
      return defer.promise;
    }

    var stanza = '\naudio_output {\n' +
      '    type            "alsa"\n' +
      '    name            "' + MPD_OUTPUT_NAME + '"\n' +
      '    device          "bluetoothOut"\n' +
      '    mixer_type      "software"\n' +
      // A USB Bluetooth A2DP link (SBC encode + wireless jitter) needs a much
      // bigger buffer than a local hardware DAC, or it stutters/underruns.
      '    buffer_time     "500000"\n' +
      '    period_time     "100000"\n' +
      '    enabled         "no"\n' +
      '}\n';

    var newContent = content.trimEnd() + '\n' + stanza;
    var tmpFile = '/tmp/.bt_out_mpd_' + Date.now() + '.conf';
    fs.writeFileSync(tmpFile, newContent);
    run('cat ' + tmpFile + ' | sudo tee ' + MPD_CONF + ' > /dev/null')
      .then(function () {
        try { fs.unlinkSync(tmpFile); } catch (e2) { /* non-fatal */ }
        defer.resolve(true);
      })
      .fail(function (e3) { defer.reject(e3); });
  } catch (e) {
    defer.reject(e);
  }
  return defer.promise;
};

// Check BlueZ's own notion of whether this device is actually connected,
// regardless of what the last `connect` command claimed.
function isDeviceConnected(mac) {
  return run('bluetoothctl info ' + mac, { timeout: 10000 })
    .then(function (stdout) { return /Connected:\s*yes/.test(stdout); })
    .fail(function () { return false; });
}

ControllerBluetoothOut.prototype.connectDevice = function (mac) {
  var self = this;
  self.config.set('connectionStatus', 'Connecting to ' + mac + '...');
  return run('bluetoothctl power on')
    .then(function () { return run('bluetoothctl trust ' + mac).fail(function () { /* already trusted / not fatal */ }); })
    .then(function () {
      return run('bluetoothctl connect ' + mac, { timeout: 25000 })
        .fail(function (e) {
          // bluetoothctl reports org.bluez.Error.Failed when asked to connect
          // a device that is already connected (e.g. reconnected automatically
          // via the "Trusted" flag). That's not an actual failure - verify the
          // real state via `info` before giving up.
          return isDeviceConnected(mac).then(function (alreadyConnected) {
            if (!alreadyConnected) { throw e; }
            self.logger.info('[BluetoothOut] connect reported an error but device is already connected: ' + mac);
          });
        });
    })
    .then(function () {
      self.config.set('connectionStatus', 'Connected to ' + mac);
    });
};

ControllerBluetoothOut.prototype.enableBluetoothOutput = function (mac) {
  var self = this;

  return self.ensureBlueAlsaInstalled()
    .then(function () { return self.writeAsoundBlock(mac); })
    .then(function () { return self.connectDevice(mac); })
    .then(function () { return self.ensureMpdOutputStanza(); })
    .then(function (needsRestart) {
      if (needsRestart) {
        self.logger.info('[BluetoothOut] mpd.conf changed, restarting mpd via Volumio\'s own mpd plugin');
        // IMPORTANT: do NOT just `sudo systemctl restart mpd` ourselves - Volumio's
        // backend holds its own persistent MPD client socket, and killing mpd out
        // from under it leaves that socket permanently broken (EPIPE on every
        // command, playback/browsing dead) until the whole volumio service is
        // restarted. mpd's own restartMpd() method restarts the service AND
        // re-establishes Volumio's internal connection (mpdEstablish()).
        var d = libQ.defer();
        self.commandRouter.executeOnPlugin('music_service', 'mpd', 'restartMpd', function (err) {
          if (err) { d.reject(err); return; }
          // give mpd a moment to come back up before talking mpc to it
          setTimeout(function () { d.resolve(); }, 3000);
        });
        return d.promise;
      }
    })
    .then(function () { return run('mpc enable "' + MPD_OUTPUT_NAME + '"'); })
    .then(function () {
      self.config.set('connectionStatus', 'Active: streaming to ' + mac);
    });
};

ControllerBluetoothOut.prototype.disableBluetoothOutput = function () {
  var self = this;
  var defer = libQ.defer();

  run('mpc disable "' + MPD_OUTPUT_NAME + '"')
    .fail(function () { /* output may not exist yet, not fatal */ })
    .then(function () {
      var mac = self.config ? self.config.get('deviceMac') : null;
      if (mac) {
        return run('bluetoothctl disconnect ' + mac).fail(function () {});
      }
    })
    .then(function () {
      if (self.config) { self.config.set('connectionStatus', 'Disabled'); }
      defer.resolve();
    })
    .fail(function (e) {
      self.logger.error('[BluetoothOut] disableBluetoothOutput error: ' + e);
      defer.resolve();
    });

  return defer.promise;
};
