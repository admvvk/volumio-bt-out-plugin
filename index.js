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
    self.enableBluetoothOutput(self.config.get('deviceMac'))
      .then(function () { defer.resolve(); })
      .fail(function (e) {
        self.logger.error('[BluetoothOut] onStart failed: ' + e);
        defer.resolve();
      });
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
    uiconf.sections[0].content[0].value = self.config.get('enabled');
    uiconf.sections[0].content[1].value = self.config.get('deviceMac');
    uiconf.sections[0].content[2].value = self.config.get('deviceName');
    uiconf.sections[0].content[3].value = self.config.get('connectionStatus');
    defer.resolve(uiconf);
  }).fail(function (e) {
    self.logger.error('[BluetoothOut] getUIConfig failed: ' + e);
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerBluetoothOut.prototype.saveBluetoothConfig = function (data) {
  var self = this;
  var defer = libQ.defer();

  var mac = (data['deviceMac'] || '').trim().toUpperCase();
  var macRegex = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

  if (data['enabled'] && !macRegex.test(mac)) {
    self.commandRouter.pushToastMessage('error', 'Bluetooth Output',
      'MAC-адрес устройства указан неверно (формат XX:XX:XX:XX:XX:XX)');
    defer.resolve({});
    return defer.promise;
  }

  self.config.set('deviceMac', mac);
  self.config.set('deviceName', data['deviceName'] || '');
  self.config.set('enabled', data['enabled']);

  var action = data['enabled']
    ? self.enableBluetoothOutput(mac)
    : self.disableBluetoothOutput();

  action.then(function () {
    self.commandRouter.pushToastMessage('success', 'Bluetooth Output',
      data['enabled'] ? 'Bluetooth-выход включён' : 'Bluetooth-выход выключен');
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
    run('apt-get update && apt-get install -y bluealsa', { timeout: 180000, maxBuffer: 1024 * 1024 * 10 })
      .then(function () {
        // make sure the daemon is enabled/running
        return run('systemctl enable --now bluealsa');
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

    fs.writeFileSync(ASOUND_FILE, content.trimEnd() + '\n' + block);
    defer.resolve();
  } catch (e) {
    defer.reject(e);
  }

  return defer.promise;
};

ControllerBluetoothOut.prototype.removeAsoundBlock = function () {
  var defer = libQ.defer();
  try {
    if (fs.existsSync(ASOUND_FILE)) {
      var content = fs.readFileSync(ASOUND_FILE, 'utf8');
      var startIdx = content.indexOf(BT_MARK_START);
      var endIdx = content.indexOf(BT_MARK_END);
      if (startIdx !== -1 && endIdx !== -1) {
        content = content.slice(0, startIdx) + content.slice(endIdx + BT_MARK_END.length);
        fs.writeFileSync(ASOUND_FILE, content);
      }
    }
    defer.resolve();
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
    if (content.indexOf('name\t\t"' + MPD_OUTPUT_NAME + '"') !== -1 ||
        content.indexOf('name "' + MPD_OUTPUT_NAME + '"') !== -1) {
      defer.resolve(false);
      return defer.promise;
    }

    var stanza = '\naudio_output {\n' +
      '    type            "alsa"\n' +
      '    name            "' + MPD_OUTPUT_NAME + '"\n' +
      '    device          "bluetoothOut"\n' +
      '    mixer_type      "software"\n' +
      '    enabled         "no"\n' +
      '}\n';

    fs.appendFileSync(MPD_CONF, stanza);
    defer.resolve(true);
  } catch (e) {
    defer.reject(e);
  }
  return defer.promise;
};

ControllerBluetoothOut.prototype.connectDevice = function (mac) {
  var self = this;
  self.config.set('connectionStatus', 'Connecting to ' + mac + '...');
  return run('bluetoothctl power on')
    .then(function () { return run('bluetoothctl trust ' + mac).fail(function () { /* already trusted / not fatal */ }); })
    .then(function () { return run('bluetoothctl connect ' + mac, { timeout: 25000 }); })
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
        self.logger.info('[BluetoothOut] mpd.conf changed, restarting mpd');
        return run('systemctl restart mpd').then(function () {
          // give mpd a moment to come back up before talking mpc to it
          var d = libQ.defer();
          setTimeout(function () { d.resolve(); }, 3000);
          return d.promise;
        });
      }
    })
    .then(function () { return run('mpc enableoutput "' + MPD_OUTPUT_NAME + '"'); })
    .then(function () {
      self.config.set('connectionStatus', 'Active: streaming to ' + mac);
    });
};

ControllerBluetoothOut.prototype.disableBluetoothOutput = function () {
  var self = this;
  var defer = libQ.defer();

  run('mpc disableoutput "' + MPD_OUTPUT_NAME + '"')
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
