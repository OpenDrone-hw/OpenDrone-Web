---
title: OpenRX Video Release
summary: Four Open Source ExpressLRS receivers, one range test, and the design rule one of them breaks. 
date: 2026-07-18
tags: [video, build-notes]
author: OpenDrone
published: true
image: ./images/openrx-range-test-ride.jpg
---

The video is live: [How LoRa (ExpressLRS) Receivers Work](https://www.youtube.com/watch?v=ssmQkRkXE84).


## The hardware

![The four OpenRX boards wired to the logger](./images/openrx-range-test-boards.jpg)

All four boards share the same core: an ESP32-C3, a 3.3 V regulator, and the
Open Source ExpressLRS firmware. They differ only in the radio:

- **Lite**: SX1281, 2.4 GHz, ceramic chip antenna on the PCB. No antenna to
  attach, nothing sticking out.
- **Lite-UFL**: the same board with a U.FL connector for an external antenna.
- **Mono**: LR1121, dual band (2.4 GHz and 900 MHz), single radio.
- **Gemini**: two LR1121s, two independent radios, two antennas. Two copies of
  the same RF layout on one board.

Everything is Open Source, KiCad files included, under CERN-OHL-S, and all four
are OSHWA-certified Open Source hardware:
[OpenRX Lite](https://github.com/OpenDrone-hw/OpenRX-Lite),
[Lite-UFL](https://github.com/OpenDrone-hw/OpenRX-Lite-UFL),
[Mono](https://github.com/OpenDrone-hw/OpenRX-Mono), and
[Gemini](https://github.com/OpenDrone-hw/OpenRX-Gemini).

## The test

One transmitter on top of a tower, all receivers in a box on the
bike, wired to a logger recording link quality, signal strength and SNR for
every board, every second, alongside GPS.

What the logs say:

- Farthest point with a live link: **5307 m** from the transmitter.
- Link uptime over the whole ride: Gemini **99 %**, Mono **95 %**, Lite-UFL
  **80 %**, Lite **55 %**.
- First board to drop out completely was the Lite, at **2.89 km**, when a
  hill moved between us and the tower. The trees alone ate roughly **35 dB**,
  about three thousand times weaker.
- At **5.2 km**, boards that had been fully dead re-acquired the link on
  their own when getting Line of Sight.
- The Gemini's longest outage of the entire ride: **3 seconds**. Surviving many buildings, 
  hills and otherwise impossible challenges.

## Below the noise floor

![Per-board SNR over the ride, red is below the noise floor](./images/openrx-range-test-snr.jpg)

The part that should not be possible: LoRa decodes signals that sit below the
noise floor. On the ride out to the farthest
point, **49 % of the packets the Gemini received arrived below the noise
floor**, and for the Lite it was 73 %. The receiver spends most of the ride
decoding a signal it cannot even see on a spectrum analyser.

The trick is the chirp. LoRa sends frequency sweeps and hides the data in
where the sweep starts. The receiver multiplies the incoming mess with its own
reference chirp running the other way, which collapses the signal into a
single FFT bin while the noise, which has no chirp shape, scatters across all
of them. That is a processing gain of about 24 dB, like strapping a large
directional antenna onto a 17 mm board, except it is math.

## Watch it

The full video walks through modulation, the noise floor, LoRa, and the PCB
design in KiCad:
[youtube.com/watch?v=ssmQkRkXE84](https://www.youtube.com/watch?v=ssmQkRkXE84).

Hardware, schematics and layouts:
[Lite](https://github.com/OpenDrone-hw/OpenRX-Lite),
[Lite-UFL](https://github.com/OpenDrone-hw/OpenRX-Lite-UFL),
[Mono](https://github.com/OpenDrone-hw/OpenRX-Mono), and
[Gemini](https://github.com/OpenDrone-hw/OpenRX-Gemini).
Subscribe below to get an email when the boards go on sale.

We're still working on the website, let us know on discord if there's things to change!
