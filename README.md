# Volumio Bluetooth Output Plugin

Adds an outgoing Bluetooth A2DP audio output (stream Volumio playback to a
Bluetooth speaker/headphones), which Volumio does not support out of the box
(the official `Bluetooth` system plugin is input-only, bundled behind a
license, and only lets you stream a phone *into* Volumio).

## Status

Early MVP: hardcoded single device (enter its MAC manually), no in-app
scanning/pairing yet. Pairing with the speaker must be done once manually
over SSH first:

```
bluetoothctl
power on
scan on
pair   XX:XX:XX:XX:XX:XX
trust  XX:XX:XX:XX:XX:XX
```

Then enter that MAC address in the plugin's settings page and enable it.

## How it works

- Installs `bluealsa` (BlueALSA, ALSA<->BlueZ bridge) via apt if missing.
- Adds a `pcm.bluetoothOut` / `ctl.bluetoothOut` block to `/etc/asound.conf`
  pointing at the configured MAC (A2DP profile), bracketed by
  `#------ BluetoothOut section -------` markers so it's managed
  idempotently and doesn't disturb the rest of the ALSA chain
  (FusionDSP/CamillaDSP etc. keep working on the primary output).
- Adds a second MPD `audio_output` stanza (`"Bluetooth Output"`, type alsa,
  device `bluetoothOut`) to `/etc/mpd.conf`, disabled by default.
- On enable: connects to the device via `bluetoothctl`, then
  `mpc enableoutput "Bluetooth Output"` — so it plays *alongside* the
  normal output, toggled live without restarting MPD after the first setup.
- On disable: `mpc disableoutput` + `bluetoothctl disconnect`.

## Reversibility

Nothing here touches the base Volumio image (it runs on an overlay root —
see project notes). Worst case is a `Factory Reset` from Volumio's System
settings. Individually: delete the marked block from `/etc/asound.conf`,
remove the added `audio_output` stanza from `/etc/mpd.conf`, and
`apt-get purge bluealsa` to fully undo.

## Roadmap

- In-app device scan/pair picker (replace hardcoded MAC).
- Surface connection/battery status from BlueZ via D-Bus instead of shelling
  out to `bluetoothctl` for every action.
