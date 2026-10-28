# Volumio Bluetooth Output Plugin

Adds an **outgoing** Bluetooth A2DP audio output — stream Volumio playback to
a Bluetooth speaker/amplifier. Volumio does not support this out of the box:
the official `Bluetooth` system plugin is **input only** (lets a phone stream
*into* Volumio) and is a licensed/encrypted premium plugin besides.

## Features

- Web UI device picker: "Scan for devices" button + dropdown, no manual MAC
  entry needed day-to-day.
- Plays through Bluetooth *alongside* the normal hardware DAC output
  (independent MPD outputs, toggle either one).
- Survives Volumio's own `alsa_controller` regenerating `/etc/mpd.conf` on
  every boot (re-adds its stanza idempotently).

## Known limitations (read this before use)

These are documented as a visible warning on the plugin's own settings page
too, but in short:

1. **Stop playback** before switching devices on the settings page, or
   before powering off the connected speaker/amp. Switching the live MAC or
   losing the link while MPD still has the ALSA device open leaves it in a
   stale state (`libasound` caches the parsed `/etc/asound.conf` for the
   life of the MPD process) — sound silently falls back to the DAC only.
2. If there's no sound after switching devices, **reboot Volumio**
   (Settings → System → Reboot). A fresh MPD process re-reads the config.
3. After a reboot, give the Bluetooth link **~15 seconds** to settle before
   pressing play, or the first track may stutter.

Fixing these properly needs either a full `restartMpd()` on every device
switch, or unique-per-device ALSA pcm names + a BlueZ D-Bus connection-state
listener — more plugin-dev time than this project has had so far.

## Installing on a fresh Volumio install (e.g. after re-flashing the SD card)

A re-flash wipes `/data` entirely, so everything below needs to be redone
from scratch. All of it is scriptable; nothing here is a one-off GUI click
you have to remember.

### 0. Prerequisite: use a USB Bluetooth dongle, not the onboard chip (Pi 3)

The Raspberry Pi 3's onboard UART Bluetooth chip crashed with a real kernel
oops under sustained A2DP source load in testing. Disable it permanently and
use a cheap USB BT dongle instead (plug it in *after* the system has fully
booted the first time, not during a cold boot — a cold boot with it already
inserted caused one unexplained hang in testing, root cause unconfirmed):

```
echo 'dtoverlay=disable-bt' | sudo tee -a /boot/config.txt
sudo reboot
```

### 1. Install bluealsa (the plugin also does this itself on first enable, but doing it up front avoids any apt timing surprises)

```
sudo apt-get update
sudo apt-get install -y bluealsa
# If that fails because libbluetooth3's candidate version 404s on the dead
# raspbian.raspberrypi.org mirror (known Buster EOL issue), pin the version
# still served by the live archive.raspberrypi.org mirror instead:
sudo apt-get install -y bluealsa libbluetooth3=5.50-1.2~deb10u3+rpt1
```

### 2. Copy the plugin onto the device

From a machine with Node matching the Volumio device's version (check with
`node -v` on the device over SSH — this image runs Node 14):

```
git clone https://github.com/admvvk/volumio-bt-out-plugin.git
cd volumio-bt-out-plugin
npm install --production   # pure JS deps (kew, v-conf, fs-extra) - no native build needed, copy node_modules as-is to any architecture
scp -r . volumio@<pi-ip>:/tmp/volumio-bt-out-plugin
ssh volumio@<pi-ip> "sudo mkdir -p /data/plugins/audio_interface/volumio-bt-out-plugin && sudo cp -r /tmp/volumio-bt-out-plugin/. /data/plugins/audio_interface/volumio-bt-out-plugin/ && sudo chown -R volumio:volumio /data/plugins/audio_interface/volumio-bt-out-plugin"
```

**The folder name must be exactly `volumio-bt-out-plugin`** (matching
`package.json`'s `name` field exactly, hyphens included) — Volumio's plugin
manager derives its registry key from `package.json.name` and separately
checks a folder of that same name exists on disk. A mismatch (e.g.
underscores) makes Volumio silently delete the plugin's entry from
`plugins.json` on every boot with no error, no toast — it just never starts.

### 3. Register it and seed its config

```
ssh volumio@<pi-ip>
mkdir -p /data/configuration/audio_interface/volumio-bt-out-plugin
cp /data/plugins/audio_interface/volumio-bt-out-plugin/config.json \
   /data/configuration/audio_interface/volumio-bt-out-plugin/config.json

python3 - <<'EOF'
import json
p = '/data/configuration/plugins.json'
d = json.load(open(p))
d.setdefault('audio_interface', {})['volumio-bt-out-plugin'] = {
    'enabled': {'type': 'boolean', 'value': True},
    'status': {'type': 'string', 'value': 'STARTED'}
}
json.dump(d, open(p, 'w'), indent=2)
EOF

sudo systemctl restart volumio
```

### 4. Pair your device for the first time

Open the plugin's settings page in the web UI (Plugins → Installed →
Bluetooth Output), click **Scan for devices**, wait ~10s, close and reopen
the settings page, pick your device from the dropdown, enable the toggle and
Save. First-time pairing may prompt a PIN confirmation **on the device
itself** (e.g. a speaker's own display/button) — confirm it there.

## How it works

- Installs `bluealsa` (BlueALSA, the ALSA↔BlueZ bridge) via `sudo apt-get`
  if not already present (backend runs as the unprivileged `volumio` user;
  `apt-get`/`systemctl`/`tee` are in its passwordless sudoers whitelist).
- Writes a `pcm.bluetoothOut` / `ctl.bluetoothOut` block into
  `/etc/asound.conf`, bracketed by `#------ BluetoothOut section -------`
  markers so it can be found-and-replaced idempotently without disturbing
  the rest of the ALSA chain (FusionDSP/CamillaDSP etc. keep working on the
  primary output).
- Adds a second MPD `audio_output` stanza (`"Bluetooth Output"`, type
  `alsa`, device `bluetoothOut`, with a 500ms `buffer_time`/100ms
  `period_time` — a USB A2DP link needs a much bigger buffer than a local
  DAC or it stutters) to `/etc/mpd.conf`.
- Connects to the device via `bluetoothctl` (treating BlueZ's
  `org.bluez.Error.Failed` on an already-connected device as success, not a
  real failure — a known BlueZ quirk, not this plugin's bug), then
  `mpc enable "Bluetooth Output"` — it plays *alongside* the normal output.
- On disable: `mpc disable "Bluetooth Output"` + `bluetoothctl disconnect`.
- Never shells out a bare `systemctl restart mpd` — that breaks Volumio's
  own persistent MPD client socket permanently (EPIPE on everything,
  playback control AND library browsing die). Uses
  `commandRouter.executeOnPlugin('music_service', 'mpd', 'restartMpd', cb)`
  instead, which also re-establishes Volumio's own connection.

## Reversibility

Nothing here touches the base Volumio image — Volumio runs on an overlay
root (`overlay` mounted with `lowerdir=/mnt/static` read-only +
`upperdir=/mnt/ext/dyn` writable), so the squashfs image itself is never
written to regardless of what this plugin does. Worst case is a
**Factory Reset** from Volumio's System settings, which discards the whole
overlay. Individually: delete the marked block from `/etc/asound.conf`,
remove the added `audio_output` stanza from `/etc/mpd.conf`, remove the
plugin's entry from `/data/configuration/plugins.json`, and
`sudo apt-get purge bluealsa` to fully undo.

## Roadmap

- Fix the device-switch/reconnect sound loss properly (full `restartMpd()`
  on every switch, or per-device unique ALSA pcm names + a background BlueZ
  D-Bus `PropertiesChanged` listener to react to unexpected disconnects).
- Surface connection/battery status from BlueZ via D-Bus instead of shelling
  out to `bluetoothctl` for every action.
