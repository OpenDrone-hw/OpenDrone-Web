# The Control Loop Ladder

Research notes for the chapter. One claim per bullet. `[verified]` = two independent
sources, or one primary source (datasheet, firmware source, official spec).
`[single]` = one secondary source only.

Local sources used:
- AM32 firmware, pinned at commit `32d7dd0` (2026-05-07, tags through v2.20): https://github.com/am32-firmware/AM32/tree/32d7dd0
- OpenBrain fact DB: `psql -d openbrain`, table `facts`
- Datasheet extracts: local working copies, not archived. Each claim citing a datasheet names the part and the document.

---

## Rung 1: MOSFET switching / PWM carrier

- AM32's default motor PWM carrier is 24 kHz. `Inc/targets.h:5581-5588` defines
  `NOMINAL_PWM 24000U` and derives `TIM1_AUTORELOAD` from it as
  `((uint16_t)(CPU_FREQUENCY_MHZ * 1000U * 1000U / NOMINAL_PWM)-1)`.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Inc/targets.h#L5581-L5588 [verified, primary]
- AM32's configurable PWM carrier range is 8 kHz to 144 kHz. `Src/main.c:631` gates on
  `if (eepromBuffer.pwm_frequency < 145 && eepromBuffer.pwm_frequency > 7)`, and only then
  recomputes `TIMER1_MAX_ARR = TIM1_AUTORELOAD * 400 / divider` where
  `divider = pwm_frequency * 100 / 6`. Any value outside 8..144 falls back to the nominal
  24 kHz auto-reload.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/main.c#L631-L638 [verified, primary]
- The 8 to 144 kHz range is a v2.19 feature, listed in the release notes as
  "8-144 khz pwm ( not all esc's will work with high pwm frequency )".
  Source: https://github.com/am32-firmware/AM32/releases/tag/v2.19 [verified]
- AM32 `variable_pwm == 1` sweeps the carrier with motor speed: the timer auto-reload is
  linearly mapped from the commutation interval between `TIMER1_MAX_ARR / 2` and
  `TIMER1_MAX_ARR`, i.e. the carrier rises from the configured value up to 2x it as RPM
  climbs. Set 24 kHz and it sweeps 24 to 48 kHz.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/main.c#L1930-L1932
  (`tim1_arr = map(commutation_interval, 96, 200, TIMER1_MAX_ARR / 2, TIMER1_MAX_ARR)`) [verified, primary]
- AM32 `variable_pwm == 2` ("by RPM", added in v2.18) picks the range automatically from the
  average commutation interval rather than from the user's slider:
  `tim1_arr = average_interval * (CPU_FREQUENCY_MHZ/9)` clamped to an interval of 100..250.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/main.c#L1934-L1943; v2.18 release notes
  "Adds auto pwm frequency" https://github.com/am32-firmware/AM32/releases/tag/v2.18 [verified, primary]
- The AM32 configuration tool historically exposed 8 to 48 kHz for variable PWM settings;
  the firmware limit is wider than the GUI limit.
  Source: openbrain `facts` (corroboration 5, no cite_url) [single]
- Practical "by RPM" operating band on a 5 inch quad is roughly 30 to 55 kHz.
  Source: openbrain `facts`, `faq/esc/am32` [single]
- Reason the rung sits at tens of kHz, high side: gate-drive and switching power scales
  linearly with carrier, `P = Q_g * V_gs * f_sw`, so 48 kHz dissipates about twice the
  switching plus gate-drive power of 24 kHz and loads the ESC's internal gate-drive regulator
  twice as hard.
  Source: openbrain `facts`; Vishay AN608A gate-charge switching-time derivation [verified]
- Reason the rung sits at tens of kHz, low side: below roughly 16 to 20 kHz the carrier is
  audible, and current ripple through the motor inductance grows as `f_sw` falls, raising
  motor copper loss and heat. AM32 guidance explicitly notes "a low fixed PWM frequency
  causes excess heat".
  Source: openbrain `facts`, `faq/esc/am32` [single]
- Dead time is a hard lower bound on usable duty at high carrier: with a fixed ~1 us dead
  time, at 24 kHz (41.7 us period) dead time is ~2.4% of the period, at 48 kHz (20.8 us)
  it is ~4.8%, and at 144 kHz (6.9 us) it is ~14%. This is why "not all ESCs will work with
  high pwm frequency" is in the AM32 release notes rather than a caveat.
  Source: derived from `Src/main.c` timer arithmetic plus openbrain `facts` on AM32 dead-time
  duty loss [verified]
- Beat-frequency argument for variable PWM: a fixed carrier beats against the changing
  commutation frequency as RPM varies, producing a throttle dead-spot and audible whine;
  tracking the carrier to RPM keeps the ratio roughly constant and removes the dead-spot.
  Source: openbrain `facts` (multiple entries, `faq/esc/am32`) [verified]
- BLHeli_S runs a fixed 24 kHz PWM carrier, not user-configurable. The official manual states
  flatly: "Motor PWM: The motor PWM frequency is always 24kHz. The resolution is 2048 steps for
  MCUs running at 48MHz... For MCUs running at 24MHz, the PWM resolutions are half."
  Source: https://github.com/bitdump/BLHeli/blob/master/BLHeli_S%20SiLabs/BLHeli_S%20manual%20SiLabs%20Rev16.x.pdf
  lines 242-245 of the extracted text [verified, primary]
- The BLHeli_S source header confirms the drive mode is fixed too: "Motor pwm is always damped
  light (aka complementary pwm, regenerative braking)".
  Source: https://github.com/bitdump/BLHeli/blob/master/BLHeli_S%20SiLabs/BLHeli_S.asm line 96 [verified, primary]
- BLHeli_32's PWM frequency is programmable "in a range that is preconfigured by the ESC
  manufacturer", not a fixed universal range. Variable PWM by throttle arrived in Rev32.8 and
  variable PWM by RPM in Rev32.9. The manual gives 48 kHz as a worked example when discussing
  sine mode resolution.
  Source: https://github.com/bitdump/BLHeli/blob/master/BLHeli_32%20ARM/BLHeli_32%20manual%20ARM%20Rev32.x.pdf
  sections "PWM frequency" and revision history [verified, primary]
- Ordering note for the chapter: AM32 had variable PWM first and BLHeli_32 copied it. AM32's
  "by RPM" mode and BLHeli_32's Rev32.9 RPM-controlled variable PWM are the same idea.
  Source: openbrain `facts`; corroborated by BLHeli_32 manual revision history dating Rev32.9 [verified]
- Bluejay, the Open Source BLHeli_S replacement, adds a selectable carrier of 24, 48 or 96 kHz,
  chosen at compile time. The source defines `PWM_FREQ EQU 0 ; 0=24, 1=48, 2=96 kHz` and stores
  the display value as `(24 SHL PWM_FREQ)`.
  Source: https://github.com/bird-sanctuary/bluejay/blob/master/src/Bluejay.asm lines 135, 143, 345;
  README feature list "Selectable PWM frequency: 24, 48 and 96 kHz" [verified, primary]
- Bluejay trades PWM resolution for carrier frequency in the same instruction:
  `PWM_BITS_H EQU (3 - PWM_CENTERED - PWM_FREQ)`. Doubling the carrier costs one bit of duty
  resolution, because the timer counts to half as many steps in half the period. That is the
  cleanest single-line statement of the PWM rung's trade-off found anywhere.
  Source: https://github.com/bird-sanctuary/bluejay/blob/master/src/Bluejay.asm line 143 [verified, primary]

---

## Rung 2: The ESC commutation loop

- The governing formula is electrical frequency `f_e = (RPM / 60) * (poles / 2)`, i.e.
  mechanical revolutions per second multiplied by pole pairs. Six commutation events occur
  per electrical revolution in trapezoidal six-step drive, so
  `commutations/s = 6 * f_e = RPM / 10 * pole_pairs`.
  Source: standard BLDC theory, and Betaflight implements exactly this to convert DShot eRPM
  into mechanical frequency:
  `erpmToHz = ERPM_PER_LSB / SECONDS_PER_MINUTE / (motorConfig()->motorPoleCount / 2.0f)`
  https://github.com/betaflight/betaflight/blob/master/src/main/drivers/dshot.c line 191 [verified, primary]
- A typical 2207 FPV motor has 14 poles, i.e. 7 pole pairs (12N14P stator/magnet count).
  Source: near-universal for 22xx outrunners; Betaflight exposes it as `motor_poles`, default 14,
  and divides by 2 to get pole pairs in the line above [verified]
- Worked example, 2207 at 10,000 RPM (roughly hover to low cruise on 6S):
  `f_e = (10000/60) * 7 = 1167 Hz` electrical, so `6 * 1167 = 7,000` commutations per second,
  one every 143 us. [derived]
- Worked example, 2207 at 25,000 RPM (mid throttle, 5 inch on 6S):
  `f_e = (25000/60) * 7 = 2917 Hz`, so `17,500` commutations per second, one every 57 us. [derived]
- Worked example, 2207 at 40,000 RPM (near full throttle, 1900 KV on 6S unloaded-ish):
  `f_e = (40000/60) * 7 = 4667 Hz`, so `28,000` commutations per second, one every 36 us. [derived]
- Zero-crossing detection happens once per commutation step, so the ZC detection rate equals
  the commutation rate: 7 kHz to 28 kHz across the useful RPM band of a 5 inch quad. [derived]
- This is the reason the PWM carrier and the commutation rate are the same order of magnitude
  at high RPM, and the reason AM32 varies the carrier: at 40,000 RPM the commutation rate
  (28 kHz) is above a fixed 24 kHz carrier, so back-EMF sampling windows and PWM edges collide.
- AM32's own note on the mechanism: variable PWM tracks RPM specifically "to avoid pwm
  frequency/commutation frequency interference".
  Source: openbrain `facts` (AM32 firmware-verified entry) [verified]
- Community-measured description of the AM32 variable-PWM knee: carrier stays at 24 kHz until
  the commutation frequency approaches 11.5 kHz, then scales up proportionally to a 48 kHz
  maximum.
  Source: https://www.youtube.com/watch?v=yOeVj6P9PSU&t=1035s (corroboration 5 in DB) [single]
- Why zero-crossing detection cannot go faster: it is not a sampled loop with a chosen rate,
  it is event-driven by the motor itself. The ESC must wait for the floating phase's back-EMF
  to cross the virtual neutral, which physically happens 6 times per electrical revolution and
  no more often.
- Why it fails at low RPM: back-EMF amplitude is proportional to RPM, so below a few hundred
  RPM the zero-crossing is buried in noise. This is exactly why AM32 has open-loop startup and
  a sine/slow startup mode, and why AM32 guidance says the ideal sine-mode motor "should be
  large low kv" since "a 1000 KV motor produces twice the back-EMF of a 2000 KV motor at the
  same RPM".
  Source: https://wiki.am32.ca/general/Crawler-Hardware-and-AM32.html [verified]
- AM32 requires a minimum number of consecutive good back-EMF samples before accepting a zero
  crossing (`TARGET_MIN_BEMF_COUNTS`), and doubles that requirement for the first 5 zero
  crossings after startup (or adds 1 in bidirectional mode). This is the filter that trades
  commutation latency against false-trigger immunity, i.e. desync.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/main.c#L1915-L1927 [verified, primary]
- `TARGET_MIN_BEMF_COUNTS` is per-target, defined 28 times in `Inc/targets.h`, with values
  ranging from 1 to 6 (most common value 3). It is tuned per ESC hardware, not per motor.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Inc/targets.h (lines 752, 805, 1326, 1661, 2213,
  2235, 2768, 2803, 2824, 2845 and others) [verified, primary]

---

## Rung 3: ESC control input, DShot

- DShot bit rates are named in kbit/s: DShot150 = 150 kbit/s, DShot300 = 300 kbit/s,
  DShot600 = 600 kbit/s, DShot1200 = 1200 kbit/s. Bit period is therefore 6.67 us,
  3.33 us, 1.67 us and 0.83 us respectively. [derived from protocol definition]
- A DShot frame is 16 bits: 11 bits throttle/command, 1 bit telemetry request, 4 bits CRC.
  Frame duration is 16 x bit period: 106.7 us (DShot150), 53.3 us (DShot300),
  26.7 us (DShot600), 13.3 us (DShot1200). [derived]
- Corroborating community figure: "DShot600 takes approximately 25 microseconds to transmit
  a single packet", against the 26.7 us derived value.
  Source: openbrain `facts` [single, but consistent with derivation]
- AM32 decodes DShot by measuring the whole 16-bit frame span from its DMA capture buffer:
  `dshot_frametime = dma_buffer[31] - dma_buffer[0]` and `halfpulsetime = dshot_frametime >> 5`
  (frame divided by 32, i.e. half a bit period). It then accepts the frame only if the measured
  frame time falls inside a window `dshot_frametime_low..dshot_frametime_high` derived from a
  running average packet length, `(average_packet_length >> 3) +/- (average_packet_length >> 7)`,
  which is +/- 0.78%.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/dshot.c#L74-L76,
  https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/signal.c#L31-L32 (lines 31-32, 171-172) [verified, primary]
- That +/- 0.78% acceptance window is why AM32 does not auto-detect arbitrary DShot rates and
  why bit-banged DShot on a busy FC produces error counts: the protocol is self-clocking but
  the tolerance is tight.
  Source: derived from `Src/signal.c:171-172` plus openbrain `facts` on bitbang DShot600
  error counts [verified]
- AM32 standard releases do not support DShot150. Infrequently used signal types, including
  DShot150, Multishot and Oneshot, were dropped to reduce the risk of misdetection.
  Source: openbrain `facts`, multiple entries; wiki.am32.ca [verified]
- AM32 supports one-way DShot300/600/1200/2400 since v2.16 (2024-10-26, release note
  "Dshot timing changed to allow dshot 1200, 2400"). Bidirectional DShot remains DShot300/600.
  Source: openbrain `facts`, `am32-staleness-sweep-2026-06-12`; wiki.am32.ca [verified]
- Bidirectional DShot inverts the signal and the ESC replies with a 21-bit GCR-encoded
  telemetry frame. AM32 builds it by GCR RLL encoding 16 bits to 20 bits via a 16-entry
  `gcr_encode_table`, then a 20-to-21 bit run-length step.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/dshot.c#L20 (lines 20, 315-340) [verified, primary]
- The bidirectional return frame is 21 bits. Betaflight's bit-bang decoder validates on exactly
  that: `#define MIN_VALID_BBSAMPLES ((21 - 2) * 3)` and `MAX_VALID_BBSAMPLES ((21 + 2) * 3)`,
  the `* 3` being the 3x oversampling of each bit.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/drivers/dshot_bitbang_decode.c
  lines 36-37 [verified, primary]
- The reply is sent at a higher bit rate than the outbound frame so the round trip fits inside
  one DShot period. The commonly cited multiplier is 5/4; not confirmed in source here, see
  "Unknowns". [single]
- AM32 rate-limits extended DShot telemetry (EDT) by round-robin: it interleaves current,
  voltage and temperature frames using `CURRENT_EDT_RATE_DIVISOR`, `VOLTAGE_EDT_RATE_DIVISOR`
  and `TEMP_EDT_RATE_DIVISOR` counters, sending one extended frame between eRPM frames rather
  than every frame. eRPM stays at the full rate; the slow telemetry is decimated.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/dshot.c#L248-L281 [verified, primary]
- AM32 disarms after half a second of signal loss when armed:
  `if (signaltimeout > (LOOP_FREQUENCY_HZ >> 1))`.
  Source: https://github.com/am32-firmware/AM32/blob/32d7dd0/Src/main.c#L1945-L1950 [verified, primary]
- How often the FC sends: once per PID loop, up to the protocol ceiling. At an 8 kHz PID loop
  the frame interval is 125 us, which DShot300 (53.3 us) and DShot600 (26.7 us) both clear,
  but DShot150 (106.7 us) barely clears one-way and cannot clear a bidirectional round trip.
  This is the mechanical reason DShot150 was dropped. [derived]
- Known interaction: in Betaflight 4.2, enabling bidirectional DShot at DShot300 with an 8 kHz
  PID loop caused motor commands to be sent only every other PID loop iteration.
  Source: https://www.youtube.com/watch?v=nALPi8cTXGY&t=258s [single]
- BLHeli_S documents the input-rate ceiling per protocol directly: "Dshot150 theoretically
  supports up to 8kHz input rates, Dshot300 supports 16kHz and Dshot600 32kHz. MCUs running at
  24MHz do not support Dshot600." It also warns "For MCUs running at 24MHz, input signal pulse
  rates above 8kHz are not recommended. For MCUs running at 48MHz, input signal pulse rates up
  to 32kHz are supported."
  Source: https://github.com/bitdump/BLHeli/blob/master/BLHeli_S%20SiLabs/BLHeli_S%20manual%20SiLabs%20Rev16.x.pdf
  lines 204-210 of the extracted text [verified, primary]
- Those ceilings match the derived frame durations: DShot150's 106.7 us frame gives a hard
  9.4 kHz ceiling (BLHeli_S says 8 kHz with margin); DShot300's 53.3 us gives 18.8 kHz
  (BLHeli_S says 16 kHz); DShot600's 26.7 us gives 37.5 kHz (BLHeli_S says 32 kHz). The
  documented figures are the derived ones with roughly 15% headroom. [verified, derivation
  agrees with primary source]
- BLHeli_32 documents the eRPM ceiling, which is the other end of the same trade: DShot at
  8 kHz input supports 470k eRPM, at 16 kHz 420k eRPM, at 32 kHz 310k eRPM. Faster input rate
  costs commutation headroom because the MCU spends cycles decoding instead of commutating.
  Source: https://github.com/bitdump/BLHeli/blob/master/BLHeli_32%20ARM/BLHeli_32%20manual%20ARM%20Rev32.x.pdf
  lines 379-381 of the extracted text [verified, primary]
- That BLHeli_32 table is the single best quantitative statement of the whole chapter's thesis:
  the input rung and the commutation rung compete for the same MCU, and pushing the outer loop
  faster costs the inner loop headroom. At 310k eRPM with a 14-pole motor the mechanical limit
  is 310000 / 7 = 44,286 RPM. [derived from the source above]
- Why not go faster than DShot600 in practice: AM32 states higher speeds such as DShot4800 and
  DShot9600 "provide no measurable motor-response advantage and increase the risk of unintended
  motor spin-up". The motor's electrical time constant, not the wire, is the limit.
  Source: openbrain `facts`, wiki.am32.ca [verified]

---

## Rung 4: Gyro sampling

### MPU-6000 (the legacy reference)

- Gyro internal sample rate is 8 kHz with the DLPF disabled (`DLPF_CFG = 0`), and drops to
  1 kHz with any DLPF setting enabled (`DLPF_CFG = 1..6`).
  Source: MPU-6000 product spec PS-MPU-6000A, "Gyroscope Sample Rate, Fast: DLPFCFG=0, 8 kHz";
  "Gyroscope Sample Rate, Slow: DLPFCFG=1,2,3,4,5, or 6, 1 kHz"
  https://cdn.sparkfun.com/datasheets/Components/General%20IC/PS-MPU-6000A.pdf [verified, primary]
- Accelerometer sample rate is fixed at 1 kHz.
  Source: same, PS-MPU-6000A [verified, primary]
- Programmable output sample rate via the sample rate divider spans 3.9 Hz to 8000 Hz.
  Source: same [verified, primary]
- Rate noise spectral density is 0.005 deg/s/sqrt(Hz) at 10 Hz; total RMS noise
  0.05 deg/s-rms at DLPF_CFG=2 (100 Hz bandwidth).
  Source: same [verified, primary]
- This is the origin of the 8 kHz ceiling in Betaflight's older loop-rate options: with an
  MPU-6000 you can only get fresh samples at 8 kHz, and only if you turn the on-chip filter
  off entirely and take the aliasing.

### ICM-20602

- Same InvenSense architecture as MPU-6000, 8 kHz gyro sample rate with DLPF bypassed,
  32 kHz possible with `FCHOICE_B` selecting the bypass path.
  Datasheet download failed from every mirror tried, see "Unknowns". [single]

### ICM-42688-P (the current high end)

- Gyro ODR is selectable from 12.5 Hz to 32 kHz. The register table for `GYRO_ODR`
  (bank 0, 0x4Fh, bits 3:0) lists 32 kHz, 16 kHz, 8 kHz, 4 kHz, 2 kHz, 1 kHz (default),
  500 Hz, 200 Hz, 100 Hz, 50 Hz, 25 Hz, 12.5 Hz.
  Source: DS-000347 rev 1.5 section 5.6, ICM-42688-P datasheet [verified, primary]
- The specification table states Output Data Rate min 12.5 Hz, max 32000 Hz for the gyro.
  Source: DS-000347 Table 1, Gyroscope Specifications [verified, primary]
- The ADC and decimation filter run at a fixed 32 kHz regardless of the selected ODR. The
  signal chain is: ADC, decimation filter (32 kHz), notch filter, anti-alias filter, user
  offset, UI filter block, sensor registers.
  Source: DS-000347 signal path block diagram, section 5 [verified, primary]
- The anti-alias filter is a 2nd-order programmable low pass with 3 dB bandwidth from
  42 Hz to 3979 Hz, set by `GYRO_AAF_DELT`, `GYRO_AAF_DELTSQR` and `GYRO_AAF_BITSHIFT`.
  The datasheet states the filter "allows trading off RMS noise vs. latency for a given ODR".
  Source: DS-000347 section 5.3 and register descriptions [verified, primary]
- The Low Pass Filter Response spec row gives 5 to 500 Hz for ODR below 1 kHz, and
  42 to 3979 Hz for ODR at or above 1 kHz. That 3979 Hz is the real analog-domain ceiling,
  not the 32 kHz ODR.
  Source: DS-000347 Table 1 [verified, primary]
- Rate noise spectral density is 0.0028 deg/s/sqrt(Hz) at 10 Hz, total RMS noise
  0.028 deg/s-rms at 100 Hz bandwidth: about half the noise of the MPU-6000.
  Source: DS-000347 Table 1 [verified, primary]
- Gyroscope mechanical resonance frequencies are 25, 27 and 29 kHz. This is the physical
  reason the on-chip notch filter exists and the reason ODR above roughly 8 kHz starts folding
  the drive resonance into the passband.
  Source: DS-000347 Table 1, "Gyroscope Mechanical Frequencies 25 / 27 / 29 kHz" [verified, primary]
- INAV's ICM-42605/42688 driver cites section 5.3 of the same datasheet and embeds the AAF
  lookup table directly, confirming flight firmware treats AAF bandwidth as the tuning knob
  rather than ODR.
  Source: https://github.com/iNavFlight/inav/blob/master/src/main/drivers/accgyro/accgyro_icm42605.c
  (`static aafConfig_t aafLUT42688[]`, comment cites the datasheet) [verified]

### BMI270 (the volume part in current FCs)

- Gyro ODR range is 25 Hz to 6.4 kHz. The datasheet notes the register `GYR_CONF.gyr_odr`
  offers eight valid settings from 25 Hz to 3.2 kHz, and that "for 6.4 kHz operation use
  FIFO data readout".
  Source: BST-BMI270-DS000-08 section 4, Table 10 area
  https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi270-ds000.pdf [verified, primary]
- Gyro 3 dB cutoff by ODR in normal filter mode (`gyr_bwp=0x02`):
  25 Hz -> 11 Hz, 50 -> 20, 100 -> 39, 200 -> 77, 400 -> 152, 800 -> 300, 1.6 k -> 557,
  3.2 k -> 751, 6.4 k -> 712 Hz.
  Source: BST-BMI270-DS000-08 Table 10 [verified, primary]
- The critical number: bandwidth saturates at roughly 750 Hz. Going from 3.2 kHz ODR to
  6.4 kHz ODR makes the bandwidth slightly worse (751 Hz to 712 Hz) while the RMS noise gets
  worse (431 to 500 mdps in normal mode). Doubling the sample rate on a BMI270 buys nothing.
  Source: BST-BMI270-DS000-08 Tables 10 and 11 [verified, primary]
- Gyro group delay by ODR: 3.2 kHz -> 0.82 ms, 6.4 kHz -> 0.68 ms, 1.6 kHz -> 0.97 ms,
  800 Hz -> 2.34 ms. Even at maximum rate the BMI270 contributes about 0.7 to 0.8 ms of pure
  delay before the FC sees a sample.
  Source: BST-BMI270-DS000-08 Table 13 [verified, primary]
- Gyro output noise density is 0.007 dps/sqrt(Hz) in performance mode and
  0.010 dps/sqrt(Hz) in normal mode.
  Source: BST-BMI270-DS000-08 electrical characteristics [verified, primary]
- Betaflight's BMI270 driver sets `BMI270_VAL_GYRO_CONF_ODR3200` by default, i.e. 3.2 kHz,
  and only uses the 6.4 kHz unfiltered FIFO path when `gyro_hardware_lpf` is set to
  `EXPERIMENTAL`. Comment in the source: "6.4KHz sampling, unfiltered data vs. the default
  3.2KHz with hardware filtering".
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/drivers/accgyro/accgyro_spi_bmi270.c
  lines 132, 148, 233-235, 259-265 [verified, primary]
- Betaflight maps `gyro_hardware_lpf` NORMAL to BMI270 OSR4, OPTION_1 to OSR2, OPTION_2 to
  normal filter mode, and EXPERIMENTAL to normal mode plus the 6.4 kHz FIFO path.
  Source: same file, `getBmiOsrMode()` lines 210-225 [verified, primary]
- The physical reason gyros cap out here: the MEMS proof mass is a mechanical resonator with a
  drive frequency in the tens of kHz (25 to 29 kHz on the ICM-42688-P). Sampling faster than
  roughly a tenth of the drive frequency does not produce new information, it produces
  demodulation residue and thermal noise. Bandwidth, not ODR, is the specification that matters.

---

## Rung 5: Betaflight gyro and PID loop rates

- In current Betaflight (4.3 and later, confirmed on master) the PID loop rate is not set
  directly. It is derived: `gyro.targetLooptime = activePidLoopDenom * 1e6f / gyro.sampleRateHz`,
  where `gyro.sampleRateHz` comes from whatever the detected gyro's driver reports.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/sensors/gyro_init.c
  `gyroSetTargetLooptime()`, lines 793-800 [verified, primary]
- The default `pid_process_denom` is 1, so by default the PID loop runs at the gyro's native
  sample rate, one PID iteration per gyro sample.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/flight/pid.c
  lines 91-104 (`#define DEFAULT_PID_PROCESS_DENOM 1`) [verified, primary]
- `MAX_PID_PROCESS_DENOM` is 16, so the slowest achievable PID loop is gyro rate divided by 16.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/flight/pid.h line 33 [verified, primary]
- Practical loop rates therefore fall out of the gyro, not out of a menu:
  BMI270 -> 3.2 kHz gyro, 3.2 kHz PID by default;
  ICM-42688-P as configured by Betaflight -> selectable 8k / 4k / 2k / 1k;
  MPU-6000 -> 8 kHz with DLPF bypassed, else 1 kHz.
  Sources: BF `accgyro_spi_bmi270.c`, `accgyro_spi_icm426xx.c`, `accgyro_spi_mpu6000.c` [verified, primary]
- Betaflight's ICM-426xx driver defines exactly four ODR options: `ODR_CONFIG_8K`, `4K`, `2K`,
  `1K`, mapping to `GYRO_ODR` register codes 3, 4, 5, 6. It does not expose the chip's 16 kHz
  or 32 kHz settings at all. That is the origin of the familiar "8k/4k/2k/1k" menu.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/drivers/accgyro/accgyro_spi_icm426xx.c
  lines 141-167 [verified, primary]
- Betaflight's four `gyro_hardware_lpf` settings on the ICM-42688-P map to AAF cutoffs of
  258 Hz, 536 Hz, 997 Hz and 1962 Hz, implemented as the register triples
  `{6,36,10}`, `{12,144,8}`, `{21,440,6}`, `{37,1376,4}`.
  Source: same file, `aafLUT42688[]` lines 149-175 [verified, primary]
- On the ICM-42605 the top two options collapse: the driver comments that "995 Hz is the max
  cutoff on the 42605", so selecting the 1962 Hz option does nothing.
  Source: same file, `aafLUT42605[]` lines 178-184 [verified, primary]
- Betaflight enforces a minimum PID period based on the motor protocol, expressed as
  `motorUpdateRestriction`: PWM = `1/BRUSHLESS_MOTORS_PWM_RATE`, OneShot125 = 500 us,
  OneShot42 = 100 us, DShot150 = 250 us, DShot300 = 100 us, everything faster (DShot600 and up)
  = 31.25 us. If the computed PID looptime is shorter than that, `pid_process_denom` is raised
  until it is not.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/config/config.c
  `validateAndFixConfig()`, lines 641-687 [verified, primary]
- Bidirectional DShot doubles that restriction: `motorUpdateRestriction *= 2` when
  `useDshotTelemetry` is set. DShot300 with bidirectional telemetry therefore requires a PID
  period of at least 200 us, i.e. 5 kHz maximum.
  Source: same, config.c line 676 [verified, primary]
- On F4 and G4 targets with bidirectional DShot enabled and no CPU overclock, Betaflight
  silently downgrades DShot600 to DShot300 and forces `pid_process_denom >= 2` whenever the
  gyro sample rate exceeds 4000 Hz. This is the code that makes an F4 board land on 4 kHz.
  Source: same, config.c lines 623-640 [verified, primary]
- The 8k/4k/2k choice therefore exists for exactly two reasons: the gyro can supply samples
  at those rates, and the MCU plus motor protocol can consume them at those rates. Neither is
  a tuning preference.
- What breaks if the loop goes faster than the gyro can supply: nothing improves, the PID
  controller re-processes a stale sample. Betaflight structurally prevents this by making the
  loop rate a division of the gyro rate rather than an independent setting.
- What breaks if the loop goes faster than the MCU can complete it: the scheduler overruns,
  gyro samples are dropped, and D-term (which differentiates) sees irregular dt. This is the
  failure mode behind "CPU load too high" and dropped loop iterations.
- What you lose going slower: D-term is a derivative, so its usable bandwidth is bounded by the
  loop's Nyquist frequency. Betaflight computes exactly that bound for dynamic filtering:
  `gyroFrequencyNyquist = (1000000 / 2 / gyro.targetLooptime) * 0.95f`.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/sensors/gyro_init.c
  lines 91 and 156 [verified, primary]
- Practical numbers: an 8 kHz loop has a 125 us period and a ~3.8 kHz usable filter ceiling;
  a 2 kHz loop has a 500 us period and a ~950 Hz ceiling. Motor and frame resonances of a
  5 inch quad sit in the 100 to 800 Hz band, so a 2 kHz loop is already adequate for the
  resonances that matter, which is why the perceived benefit above 4 kHz is small. [derived]

---

## Rung 6: The RC link

### ExpressLRS packet rates and sensitivity

- Official ELRS 4.x RF mode table, 2.4 GHz: 50 Hz LoRa -115 dBm; 100 Hz Full LoRa -112 dBm;
  150 Hz LoRa -112 dBm; 250 Hz LoRa -108 dBm; 333 Hz Full LoRa -105 dBm; 500 Hz LoRa -105 dBm;
  250 Hz DVDA FLRC -104 dBm; 500 Hz DVDA FLRC -104 dBm; 500 Hz FLRC -104 dBm;
  1000 Hz FLRC -104 dBm; 250 Hz DVDA FSK -103 dBm; 500 Hz DVDA FSK -103 dBm;
  1000 Hz FSK -103 dBm.
  Source: https://github.com/ExpressLRS/Docs/blob/master/docs/info/signal-health.md
  (rendered at https://www.expresslrs.org/info/signal-health/) [verified, primary]
- Official ELRS 4.x RF mode table, 900 MHz: 25 Hz LoRa -123 dBm; 50 Hz LoRa -120 dBm;
  100 Hz LoRa -117 dBm; 100 Hz Full LoRa -112 dBm; 200 Hz LoRa -112 dBm;
  200 Hz Full LoRa -111 dBm; 250 Hz LoRa -111 dBm; 50 Hz DVDA LoRa -112 dBm;
  1000 Hz Full FSK -101 dBm.
  Source: same [verified, primary]
- The full span is 20 dB from the most sensitive mode (25 Hz LoRa on 900 MHz, -123 dBm) to the
  fastest (1000 Hz FSK, -101 to -103 dBm). 20 dB of link budget is a factor of 10 in range in
  free space. That is the price of the packet rate.
  Source: derived from the table above [verified]
- ELRS 3.x table gives the actual air time per packet, which the 4.x table dropped. TX duration
  and TX interval in microseconds: 25 Hz = 30980 us on air / 40000 us interval;
  50 Hz = 19580 (900 MHz) or 10798 (2.4 GHz) / 20000; 100 Hz = 9280 / 10000;
  150 Hz = 5891.9 / 6666; 200 Hz = 4640 / 5000; 250 Hz = 3330 / 4000; 333 Hz Full = 2374.4 / 3003;
  500 Hz LoRa = 1507.4 / 2000; F500 and F1000 FLRC = 388.8 us on air; K1000 FSK = 658 / 1000.
  Source: same file, "ExpressLRS 3.x" table [verified, primary]
- The FLRC modes are the interesting entry: 388.8 us on air versus 1507.4 us for 500 Hz LoRa,
  i.e. FLRC gets the same packet rate with a quarter of the air time, at the cost of 1 dB of
  sensitivity relative to 500 Hz LoRa and 11 dB relative to 50 Hz LoRa.
  Source: same [verified, primary]
- Duty cycle limit: at 25 Hz LoRa the transmitter is on air 30980 us out of 40000 us, a 77%
  duty cycle. At 1000 Hz FSK it is 658 out of 1000 us, 66%. The link is close to continuously
  transmitting at both ends of the range, so packet rate does not buy air-time headroom, it
  trades chirp length (processing gain) for repetition rate. [derived from the 3.x table]
- ELRS claims sub-2 ms latency at the 1000 Hz packet rate.
  Source: https://www.youtube.com/watch?v=YVmBV5tAeCU&t=569s, and a second entry
  https://www.youtube.com/watch?v=it6TM-w2CtE&t=594s [single, community]
- Comparative end-to-end control latency measurements from a hardware latency rig: RedPine at
  666 Hz = 1 to 5 ms; TBS Crossfire on a Taranis = 7 to 20 ms; FrSky X on a Taranis = 18 to
  37 ms; ExpressLRS at 1 kHz faster than all of them.
  Source: https://www.youtube.com/watch?v=7pQ06kFNEyg&t=0s [single]
- ExpressLRS maintains an Open Source hardware latency rig for exactly this measurement:
  an ESP8266 that measures end-to-end latency of CRSFv2, GHST and SBUS.
  Source: https://github.com/ExpressLRS/RClatencyTester [verified, primary tool, no published numbers in repo]

### CRSF frame timing

- CRSF runs at 420000 baud (416666 on some targets). Betaflight's own comment computes
  "420000 bit/s = 46667 byte/s (including stop bit) = 21.43 us per byte", and
  "A 64 byte frame plus 1 sync byte can be transmitted in 1393 microseconds".
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/rx/crsf.c lines 92-101,
  and `crsf_protocol.h` lines 34-36 [verified, primary]
- The RC channels frame payload is 22 bytes: "11 bits per channel * 16 channels = 22 bytes".
  With the 4-byte frame overhead (address, length, type, CRC) the RC frame is 26 bytes,
  which at 21.43 us/byte is about 557 us on the wire.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/rx/crsf_protocol.h
  line 113 (`CRSF_FRAME_RC_CHANNELS_PAYLOAD_SIZE = 22`) plus the byte-time above [verified, primary]
- Betaflight's stated minimum interval between CRSF frames is
  `CRSF_TIME_BETWEEN_FRAMES_US 6667`, commented "At fastest, frames are sent by the transmitter
  every 6.667 milliseconds, 150 Hz". That constant dates from Crossfire's 150 Hz maximum and is
  now well below what ELRS actually sends.
  Source: https://github.com/betaflight/betaflight/blob/master/src/main/rx/crsf.c line 57 [verified, primary]
- Betaflight budgets `CRSF_TIME_NEEDED_PER_FRAME_US 1748`, commented "a maximally sized 64 byte
  payload will take ~1550us, round up to 1748".
  Source: same, line 56 [verified, primary]
- CRSF link statistics time out after 250 ms (`CRSF_LINK_STATUS_UPDATE_TIMEOUT_US 250000`,
  "250ms, 4 Hz mode 1 telemetry"), which is why RSSI/LQ on the OSD updates far slower than the
  control channels.
  Source: same, line 64 [verified, primary]
- The wire is not the bottleneck at any ELRS rate: 557 us of RC frame inside a 1000 us interval
  at 1000 Hz is 56% UART occupancy, and that is the worst case. Everything above that is RF air
  time and receiver processing. [derived]

### Why the RC rung sits at 50 to 1000 Hz

- Upper bound: air time. At 1000 Hz the packet is 658 us long out of a 1000 us window, and the
  sensitivity has fallen to -103 dBm. Faster means shorter chirps, less processing gain, less
  range, and eventually no duty cycle left for telemetry.
- Lower bound: the aircraft. A quad's attitude changes meaningfully in tens of milliseconds. A
  50 Hz link (20 ms interval) is on the edge of that; a 25 Hz link (40 ms) is only usable
  because at that range you are flying smooth lines, not racing.
- The RC link is deliberately the slowest fast loop in the aircraft: it carries setpoints, not
  corrections. Corrections are the gyro loop's job at 3200 Hz. This is the structural reason a
  50 Hz link still flies well and a 50 Hz gyro loop would not.

---

## Rung 7: The video pipeline

Timing only. A separate agent covers the history.

### Measurement methodology, which determines whether a number means anything

- The standard community method is high-speed camera frame counting: point a camera running at
  240 fps at both the real scene and the goggle display, then count frames between the event
  and its appearance. Resolution is 1/240 s = 4.17 ms per frame, so results are quantised to
  4.17 ms steps. Reported figures such as "41.7 ms (10 frames at 240fps)" are that method.
  Source: https://www.youtube.com/watch?v=E6ZxqTM3FzQ&t=1083s [verified, methodology stated in source]
- The higher-precision method is an oscilloscope with a photodiode on the display and an LED as
  the stimulus, which removes the frame quantisation. Used by RC_Shim for camera-level figures.
  Source: https://www.youtube.com/watch?v=PHlSp8g2FGc&t=495s [single]
- A measurement floor exists on analog: an NTSC feed at 30 fps limits the resolution of any
  latency measurement made through it to about 33 ms, so sub-frame differences between analog
  cameras cannot be distinguished this way.
  Source: https://www.youtube.com/watch?v=gOf4WNnWOh8&t=77s [single]
- Consequence: manufacturer figures, on-screen goggle figures, and independently measured
  figures are three different quantities and disagree systematically. On Walksnail the on-screen
  figure runs about 5 to 10 ms below independent measurement.
  Sources: https://www.youtube.com/watch?v=Q2Fw2MApsck&t=405s ,
  https://www.youtube.com/watch?v=mEBf028w1tQ&t=720s [verified, two sources]

### Analog

- Frame rate is fixed by the video standard: NTSC 59.94 fields/s (interlaced, 29.97 frames/s),
  PAL 50 fields/s (25 frames/s). One field period is 16.7 ms (NTSC) or 20 ms (PAL), and that is
  the irreducible transport quantum. [standard, verified]
- Analog transmission itself is essentially zero latency: it is a continuous scanline signal,
  not a buffered frame. Whole-system latency is therefore camera sensor readout plus goggle
  display latency, not link latency.
- Measured analog camera figures: RunCam Racer advertised 6 ms;
  RunCam Eagle 1 measured max 45.5 ms / average 36.0 ms / minimum 27.2 ms (Oscar Liang method);
  RunCam Split analog output ~35 ms at 1080p60 NTSC (RC_Shim, oscilloscope + photodiode),
  rising to ~65 ms when recording PAL 720p30.
  Sources: https://www.youtube.com/watch?v=SutpbuvtUsg&t=98s ,
  https://www.youtube.com/watch?v=-xIPtlgOoBY&t=171s ,
  https://www.youtube.com/watch?v=PHlSp8g2FGc&t=495s and &t=582s [single each]
- Practical whole-chain analog range quoted by reviewers: 16 to 30 ms.
  Sources: https://www.youtube.com/watch?v=Pxom81qbKac&t=503s ,
  https://www.youtube.com/watch?v=oXq5vDVO4RI&t=560s [verified, two sources]

### HDZero

- HDZero's own marketing claims "glass to glass latency < 3ms" on one part of its technology
  page and "less than 1ms fixed latency" on another. These are link-only figures and they
  contradict each other.
  Source: https://www.hd-zero.com/technology [verified that the claims are made; the claims
  themselves are not independently supported]
- Independently reported system figures: 14 ms glass-to-glass with a 90 fps camera and 16 ms
  with a 60 fps camera; a separate source gives "fixed latency of 14 to 16 milliseconds
  depending on whether running at 60 fps or 90 fps"; typical quoted range 15 to 20 ms.
  Sources: https://www.youtube.com/watch?v=TPnGVad9Cm8&t=1285s ,
  https://www.youtube.com/watch?v=TMOeIQ4VRX4&t=627s ,
  https://www.youtube.com/watch?v=Ig4-c6SgmQY&t=907s [verified, three sources agreeing]
- Camera-only figure: RunCam Nano 90 at 540p 90 fps reaches roughly 4 ms.
  Source: https://www.youtube.com/watch?v=P3md4zUtj00&t=267s [single]
- HDZero's mode set: 540p 90 fps (lowest latency, racing), 720p 60 fps (higher resolution,
  higher latency). The 90 fps mode is not available over the standalone receiver's HDMI output,
  which caps at 60 fps.
  Sources: https://www.youtube.com/watch?v=PTqhmHctHAc&t=1119s ,
  https://www.youtube.com/watch?v=9PXz_zB8qfY&t=693s [verified, two sources]
- HDZero's structural advantage: latency is fixed and does not grow as the link degrades.
  When signal weakens the picture shows sparkles but the frames that arrive are never delayed.
  Sources: https://www.youtube.com/watch?v=1wP-yblVyn4&t=752s ,
  https://www.youtube.com/watch?v=TMOeIQ4VRX4&t=796s [verified, two sources]

### DJI O3 / O4

- O3 with DJI Goggles 2: 1080p at 100 fps, claimed 30 ms; 1080p at 60 fps, claimed 40 ms.
  Source: https://www.youtube.com/watch?v=OugMoITCZSs&t=178s [single, restating DJI's own figures]
- O3 with the older Goggles V2: limited to 810p, 120 fps giving about 20 ms, 60 fps giving
  about 30 ms.
  Source: same [single]
- General rule reported across many DJI cameras: 120 fps cameras land around 25 ms and 60 fps
  cameras around 30 to 35 ms, with the link (not the camera) setting the figure; some sources
  give 35 to 45 ms for 60 fps cameras.
  Sources: https://www.youtube.com/watch?v=vubarw7BJkw&t=163s ,
  https://www.youtube.com/watch?v=p8gvRtiSVYg&t=0s [verified, two sources, ranges overlap
  but do not agree exactly]
- O4 Air Unit: transmits 1080p at 100 fps to the goggles. Racing mode advertised at a "stable
  (not constant) latency of 15 to 20 ms"; independently reported at about 19 ms, with standard
  mode 25 to 30 ms.
  Sources: https://www.youtube.com/watch?v=hmdJ6uP2uzg&t=212s and &t=287s ,
  https://www.youtube.com/watch?v=utN33fcZtLY&t=809s [verified, two sources]
- Recording mode couples to link latency on O4: any recording mode above 100 fps (4K 120 for
  example) drops the transmitted feed to 60 fps and raises latency.
  Source: https://www.youtube.com/watch?v=hmdJ6uP2uzg&t=212s [single]
- DJI does not display in-flight latency, unlike Walksnail.
  Source: https://www.youtube.com/watch?v=hmdJ6uP2uzg&t=287s [single]

### Walksnail Avatar

- Goggle-reported figures: ~25 ms at 720p standard frame rate, ~21 ms at 720p high frame rate,
  ~35 to 40 ms at 1080p. Independent measurement runs 5 to 10 ms above these.
  Source: https://www.youtube.com/watch?v=mEBf028w1tQ&t=720s [single]
- Independently measured, 240 fps frame counting: 41.7 ms (10 frames) for both the Dominator HD
  goggles and the standalone VRX into HDO2 goggles, in 720p 60 fps mode, while the goggles
  displayed 30 to 32 ms and Walksnail advertised 21 ms.
  Source: https://www.youtube.com/watch?v=E6ZxqTM3FzQ&t=1083s and &t=1243s [verified, primary
  measurement with stated method]
- Frame rate dominates: Dominator HD at 720p 100 fps measured ~33 ms versus ~42 ms at 60 fps.
  Source: https://www.youtube.com/watch?v=BuZM3dElYdw&t=1078s and &t=1238s [single]
- Going through HDMI into third-party goggles adds 10 to 30 ms: standalone VRX into Orqa ~50 ms,
  into Orca FPV-1 ~50 ms, into HDZero goggles ~67 ms at 60 fps and ~42 ms at 100 fps.
  Source: https://www.youtube.com/watch?v=BuZM3dElYdw&t=1153s and &t=1238s and &t=1324s [single]
- Goggle frame rate is a hardware property, not a setting: the Fat Shark Recon HD has a 1080p
  60 fps panel and cannot access the 100 fps low-latency mode, costing about 10 ms.
  Source: https://www.youtube.com/watch?v=xsadv-iN3TA&t=566s [single]

### Why the video rung sits at 60 to 100 fps

- Upper bound on frame rate: link bitrate. A digital system has a fixed channel capacity, so
  frames per second trades against pixels per frame. This is visible in every product: HDZero
  drops from 720p to 540p to get 90 fps; DJI O4 drops from 100 fps to 60 fps when the recorder
  demands more pixels.
- Lower bound: below about 60 fps the motion sampling itself becomes the dominant error at
  racing speeds, independent of latency.
- The floor on total latency is not the link, it is the camera sensor readout plus the display
  panel refresh. A 60 fps sensor cannot deliver an event sooner than its 16.7 ms exposure and
  readout period, and a 60 Hz panel cannot show it sooner than its next refresh. Two 16.7 ms
  quanta already account for most of the ~30 ms figures. [derived]
- Perceptual threshold: reviewers converge on latency above about 60 ms being perceptible and
  above about 100 ms making precision flying difficult.
  Source: https://www.youtube.com/watch?v=oXq5vDVO4RI&t=560s [single]

---

## Rung 8: The human

- Simple visual reaction time in a calibrated, temporally precise test: mean 231 ms, or 213 ms
  when corrected for hardware delays, across a community sample of 1469 subjects aged 18 to 65.
  Source: Woods DL, Wyma JM, Yund EW, Herron TJ, Reed B. "Factors influencing the latency of
  simple reaction time." Front Hum Neurosci. 2015;9:131. doi:10.3389/fnhum.2015.00131,
  PMID 25859198 [verified, primary, large sample]
- That total decomposes: stimulus detection time (SRT minus the finger-movement initiation time
  measured separately by speeded tapping) averaged 131 ms and was unaffected by age. The
  remaining ~100 ms is motor output.
  Source: same [verified, primary]
- Reaction time degrades with age at 0.55 ms/year, and the degradation is in motor output, not
  in detection.
  Source: same [verified, primary]
- A second, independent measurement using the Deary-Liewald reaction timer, n=120, gives a mean
  visual simple reaction time of 298.93 +/- 37.12 ms. The gap versus Woods is the hardware
  delay Woods corrected for, which is the point Woods was making.
  Source: Gautam Y, Bade M. "Effect of Auditory Interference on Visual Simple Reaction Time."
  Kathmandu Univ Med J. 2017;15(60):329-331. PMID 30580351 [verified, primary]
- So the human detection-to-action loop is 200 to 300 ms, i.e. 3 to 5 Hz if you treat it as a
  loop rate. It is 2 to 3 orders of magnitude slower than the gyro loop.
- Manual control bandwidth is lower than reaction rate. In a visuo-manual tracking task
  controlling an unstable load, disturbance-to-joystick coherence was insignificant beyond
  1 to 2 Hz, whether the subject used continuous contact or intermittent taps. Optimal
  intermittent control showed a modal contact rate of 2 per second.
  Source: Loram ID, Gollee H, Lakie M, Gawthrop PJ. "Human control of an inverted pendulum: is
  continuous control necessary? Is intermittent control effective? Is intermittent control
  physiological?" J Physiol. 2011;589(2):307-324. doi:10.1113/jphysiol.2010.194712,
  PMID 21098004 [verified, primary]
- That paper also states directly that engineering servo paradigms "are designed for high band
  width, inflexible, consistent systems whereas human control is low bandwidth and flexible
  using noisy sensors and actuators", which is the exact claim the chapter needs.
  Source: same [verified, primary]
- The hard ceiling on what a hand can even do: physiological finger tremor has spectral peaks at
  8 to 12 Hz and 20 to 25 Hz, and both are mechanical resonance rather than intentional signal.
  Anything a pilot commands above roughly 10 Hz is noise, not control.
  Source: Vernooij CA, Lakie M, Reynolds RF. "The complete frequency spectrum of physiological
  tremor can be recreated by broadband mechanical or electrical drive." J Neurophysiol.
  2015;113(2):647-656. doi:10.1152/jn.00519.2014, PMID 25376782 [verified, primary]
- Conclusion for the chapter: the human contributes 200 to 300 ms of latency and about 1 to 2 Hz
  of usable control bandwidth. The video link's 20 to 40 ms is a 10 to 15% addition to the
  human's own delay. The gyro loop at 3200 Hz is 1600 times faster than the fastest thing the
  pilot can command. The claim "the slowest loop is you" is defensible by a wide margin.

---

## The ladder as a table

| Rung | Frequency | Period | Latency contribution | Source |
|---|---|---|---|---|
| MOSFET switching (AM32 default) | 24 kHz | 41.7 us | sub-period, negligible | `AM32/Inc/targets.h:5583` |
| MOSFET switching (AM32 range) | 8 to 144 kHz | 125 to 6.9 us | negligible | `AM32/Src/main.c:631` |
| MOSFET switching (BLHeli_S) | 24 kHz fixed | 41.7 us | negligible | BLHeli_S manual Rev16.x |
| MOSFET switching (Bluejay) | 24 / 48 / 96 kHz | 41.7 / 20.8 / 10.4 us | negligible | `Bluejay.asm:135` |
| Motor commutation, 2207 14-pole @ 10k RPM | 7 kHz | 143 us | 1 step, ~143 us | derived, `f_e = RPM/60 * 7` |
| Motor commutation, 2207 @ 25k RPM | 17.5 kHz | 57 us | ~57 us | derived |
| Motor commutation, 2207 @ 40k RPM | 28 kHz | 36 us | ~36 us | derived |
| DShot600 frame | up to 37.5 kHz | 26.7 us/frame | 26.7 us on wire | 16 bits at 600 kbit/s |
| DShot300 frame | up to 18.8 kHz | 53.3 us/frame | 53.3 us on wire | 16 bits at 300 kbit/s |
| Gyro ADC + decimation, ICM-42688-P | 32 kHz fixed | 31.2 us | internal | DS-000347 sec 5 |
| Gyro ODR, ICM-42688-P as used by Betaflight | 1 to 8 kHz | 1000 to 125 us | AAF-dependent | BF `accgyro_spi_icm426xx.c:141-146` |
| Gyro ODR, BMI270 as used by Betaflight | 3.2 kHz | 312 us | 0.82 ms group delay | BST-BMI270-DS000-08 Table 13 |
| Gyro ODR, MPU-6000 (DLPF off) | 8 kHz | 125 us | filter-dependent | PS-MPU-6000A |
| PID loop (default, denom 1) | = gyro rate | 125 to 500 us | 1 period | BF `gyro_init.c:793-800`, `pid.c:92` |
| RC link, ELRS 1000 Hz FSK | 1 kHz | 1000 us | 658 us air time + processing, ~2 ms end to end | ELRS `signal-health.md` |
| RC link, ELRS 250 Hz LoRa | 250 Hz | 4000 us | 3330 us air time | ELRS `signal-health.md` |
| RC link, ELRS 50 Hz LoRa | 50 Hz | 20000 us | 19580 us (900) / 10798 us (2.4) air time | ELRS `signal-health.md` |
| CRSF RC frame on the wire | per packet | 557 us for 26 bytes | 557 us | BF `crsf.c:97`, `crsf_protocol.h:113` |
| Video, HDZero 90 fps | 90 fps | 11.1 ms | 14 to 16 ms glass to glass | 3 independent reviewers |
| Video, DJI O4 racing mode | 100 fps | 10 ms | 15 to 20 ms claimed, ~19 ms measured | DJI + 1 measurement |
| Video, DJI O3 / Goggles 2 | 100 fps | 10 ms | ~30 ms claimed | DJI figures |
| Video, Walksnail 720p 60 fps | 60 fps | 16.7 ms | 41.7 ms measured | 240 fps frame count |
| Video, analog NTSC | 59.94 fields/s | 16.7 ms | 16 to 30 ms whole chain | 2 reviewers |
| Human, visual detection | - | - | 131 ms | Woods 2015 |
| Human, detection to action | 3 to 5 Hz equivalent | - | 213 to 231 ms (corrected) | Woods 2015 |
| Human, manual control bandwidth | 1 to 2 Hz | 500 to 1000 ms | - | Loram 2011 |

Rough end-to-end budget for a stick input reaching a prop, at ELRS 500 Hz, 3.2 kHz BMI270 loop,
DShot300, AM32 24 kHz:
2 ms (RC air time and processing) + 0.6 ms (CRSF wire) + 0.3 ms (PID period) +
0.8 ms (gyro group delay, applies to the correction path not the command path) +
0.05 ms (DShot frame) + up to 0.14 ms (one commutation step at hover RPM) = roughly 3 to 4 ms.
Round-trip through the pilot's eyes instead: add 20 to 40 ms of video plus 213 to 300 ms of
human. The aircraft is not the slow part by two orders of magnitude.

---

## Why each rung sits where it does

- **PWM carrier, 24 to 48 kHz.** Bounded below by audibility (roughly 16 to 20 kHz) and by
  current ripple through the motor inductance, which scales as 1/f_sw and shows up as motor
  heat. Bounded above by switching loss, which scales as `P = Q_g * V_gs * f_sw` in the gate
  drive and as edge-rate loss in the FETs, and by dead time consuming an ever-larger fraction of
  each shorter period. AM32's 144 kHz ceiling exists but the release notes warn "not all esc's
  will work with high pwm frequency" for exactly these reasons.
- **Commutation, 7 to 28 kHz.** Not chosen at all. It is `6 * RPM/60 * pole_pairs`, set by the
  motor's magnetic geometry and the throttle. You cannot go faster without more poles or more
  RPM, and you cannot go slower without stalling. The failure mode at low RPM is that back-EMF
  amplitude scales with RPM, so zero crossings vanish into noise; the failure mode at high RPM
  is that the commutation rate approaches the PWM carrier and the two beat, which is precisely
  what AM32's variable PWM exists to prevent.
- **DShot, 150 to 2400 kbit/s.** Bounded below by the PID loop needing a fresh frame every
  period: DShot150's 106.7 us frame cannot fit inside a 125 us loop with a bidirectional reply.
  Bounded above by signal integrity on an unshielded 5 cm wire in a switching-noise environment,
  and by AM32's +/- 0.78% frame-time acceptance window. There is nothing to gain past DShot600
  because the motor's electrical time constant is far slower than the wire.
- **Gyro, 1 to 8 kHz ODR but 250 to 1000 Hz bandwidth.** The number that matters is bandwidth,
  not ODR. The ICM-42688-P's anti-alias filter tops out at 3979 Hz, its MEMS drive resonances
  sit at 25/27/29 kHz, and its ADC runs at a fixed 32 kHz regardless of what you select. The
  BMI270 makes the point brutally: its bandwidth saturates at 751 Hz, so going from 3.2 kHz to
  6.4 kHz ODR makes bandwidth *worse* (712 Hz) and noise worse (431 to 500 mdps). Faster
  sampling of a band-limited signal returns noise, not information.
- **PID loop, 1 to 8 kHz.** Bounded above by the MCU's ability to finish an iteration and by
  the motor protocol's minimum update period, both of which Betaflight enforces in code. Bounded
  below by the D-term: derivative bandwidth is capped at 0.95 x Nyquist of the loop rate, and
  frame/motor resonances of a 5 inch quad live in the 100 to 800 Hz band. A 2 kHz loop already
  covers those; that is why 8 kHz feels like diminishing returns rather than a step change.
- **RC link, 50 to 1000 Hz.** A pure link-budget trade. 20 dB of sensitivity separates 25 Hz
  LoRa from 1000 Hz FSK, which is a factor of 10 in free-space range. Faster packets mean
  shorter chirps, less processing gain, less range. Slower packets mean the aircraft's attitude
  can change meaningfully between setpoints. It works at 50 Hz only because the link carries
  setpoints and the gyro loop carries corrections.
- **Video, 60 to 100 fps.** Bounded above by channel capacity, which forces a pixels-per-frame
  versus frames-per-second trade, visible in HDZero going 720p60 to 540p90 and DJI dropping to
  60 fps when the recorder wants more pixels. Bounded below by two hard quanta that no amount
  of link engineering removes: sensor exposure and readout, and display panel refresh. At 60 fps
  those are 16.7 ms each, which is most of the measured 30 ms.
- **Human, 1 to 5 Hz.** Bounded above by neural conduction and muscle activation. Detection
  alone is 131 ms; adding motor output makes 213 to 231 ms. Usable closed-loop tracking
  bandwidth is 1 to 2 Hz. Above about 10 Hz the hand only produces mechanical tremor. This rung
  cannot be engineered, which is the whole reason the ones below it exist.

---

## Conflicting numbers

- **AM32 PWM configurable range.** Firmware source says 8 to 144 kHz (`main.c:631`). Several
  DB entries say the configuration tool exposes 8 to 48 kHz, one says 96 kHz is the practical
  maximum via variable mode with a 48 kHz base. These are not in conflict, they are firmware
  limit versus GUI limit versus practical limit, but the writeup must say which is which.
- **AM32 variable PWM knee.** A community source (corroboration 5) says the carrier stays at
  24 kHz until commutation frequency reaches 11.5 kHz, then scales to 48 kHz. The source code
  maps the auto-reload linearly from a commutation interval of 96 to 200 counts, with no
  explicit 11.5 kHz threshold. The community figure may be a measured consequence rather than a
  coded constant. Do not state 11.5 kHz as a firmware parameter.
- **DShot600 packet duration.** Derived value 26.7 us (16 bits at 600 kbit/s); DB entry says
  "approximately 25 microseconds". Use the derived value and note the community figure rounds.
- **HDZero latency.** Official site: "< 3ms" glass-to-glass in one place, "less than 1ms fixed
  latency" in another. Independent reviewers: 14 to 16 ms, or 15 to 20 ms typical, or "as low as
  4 ms" for the camera alone. The official figures are link-only and should not be quoted as
  glass-to-glass.
- **Walksnail latency.** Advertised 21 ms, goggle-displayed 30 to 32 ms, independently measured
  41.7 ms, all in 720p 60 fps mode on the same hardware. Three different numbers for one
  configuration. Present the measured figure with its method and note the discrepancy.
- **DJI 60 fps camera latency.** One source says 30 to 35 ms, another says 35 to 45 ms, a third
  says 25 to 35 ms overall. Present as a 25 to 45 ms band.
- **HDZero link latency outlier.** One DB entry says "HDZero has a video link latency as low as
  60 milliseconds", which contradicts every other source by a factor of 4. Almost certainly a
  transcription error in the source video. Discard.
- **ELRS end-to-end latency.** "Sub-2 ms at 1000 Hz" and "4 to 6 ms control link latency" are
  both quoted. The first is likely RF-only, the second end-to-end including the FC. No
  authoritative published measurement was found.
- **CRSF minimum frame interval.** Betaflight's `CRSF_TIME_BETWEEN_FRAMES_US` is 6667 us
  (150 Hz), documented as the fastest a transmitter sends. ELRS sends at up to 1000 Hz. The
  constant is a legacy Crossfire assumption used for frame-boundary detection, not a limit on
  the actual rate. Do not present it as the CRSF maximum.

---

## Unknowns / could not verify

- **BLHeli_32 numeric PWM range.** The manual says the range is "preconfigured by the ESC
  manufacturer" and never states a universal min/max. Community figures of 16 to 48 kHz or
  24 to 96 kHz depend on the ESC. BLHeli_32 is closed source, so a per-ESC figure is the best
  that can be published. Do not state a single BLHeli_32 range.
- **ICM-20602 datasheet.** Every mirror tried returned HTML or 404, including
  invensense.tdk.com (which now redirects all `/wp-content/uploads/` datasheet PDFs to the site
  homepage), DigiKey media, LCSC and Mouser. The 8 kHz / 32 kHz figures for the ICM-20602 in
  this document are inferred from the shared InvenSense architecture and are not verified.
  Try again via the DigiKey API (the `digikey` skill) or the LCSC part page.
- **Bidirectional DShot return-frame bit rate.** The 21-bit frame length is confirmed in both
  AM32 (`Src/dshot.c` GCR encoding) and Betaflight (`dshot_bitbang_decode.c` sample bounds).
  The 5/4 bit-rate multiplier on the reply was not located in either source in this session.
  Look in AM32 `Src/dshot.c` `make_dshot_package` output timer setup, or in
  `src/platform/common/stm32/dshot_bitbang.c` where the input capture rate is configured.
- **McRuer crossover model numbers.** The classic human-operator model (crossover frequency
  3 to 6 rad/s, effective time delay 0.15 to 0.3 s) would strengthen the human rung, but no
  fetchable primary was found: NTRS returned only conference proceedings index entries, DTIC
  blocked, Wikipedia has no `Crossover_model` article, Semantic Scholar rate-limited.
  The Loram 2011 J Physiol result (1 to 2 Hz coherence limit) covers the same ground with a
  verified primary, so this is optional.
- **Published ELRS end-to-end latency measurements.** `ExpressLRS/RClatencyTester` is the
  official rig but its README publishes no results. If a number is needed, it must be measured
  or sourced from a third party.
- **Analog goggle display latency.** Not separated from camera latency in any source found.
  The "16 to 30 ms whole chain" figure lumps camera, link and display together.
- **DJI official latency specification pages.** dji.com redirects the O4 Air Unit Pro specs URL
  to a 404 for this region. All DJI figures here are secondary, quoting DJI marketing rather
  than a retrieved spec page.
