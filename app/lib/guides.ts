/**
 * /guides - beginner firmware tutorials for the boards /flash supports.
 *
 * The guides are structured data, not free prose: every page is a numbered list
 * of steps (each with what the reader should SEE when it worked), safety
 * callouts and an "If it doesn't work" list. The routes render that shape and
 * derive the HowTo and breadcrumb JSON-LD from it, so the visible steps and the
 * structured data can never disagree.
 *
 * Strings use the site's inline markup (`app/lib/rich-text.ts`: `[label](/path)`,
 * `**strong**`, `*em*`) plus backticks for code. Links to `/flash` are rendered
 * as full document loads by the route, because that page's Permissions-Policy
 * (USB, serial) only applies to a freshly loaded document.
 *
 * Facts we could not confirm in this repo are deliberately left general: the
 * BOOT button's position (readers are sent to the printed board and its README)
 * and the firmware version numbers (the reader compares against what /flash
 * shows, which comes from the signed release manifest at run time).
 *
 * Pure module (no `~/` imports, no Vite globals) so `node --test` can load it.
 */

import {FLASHER_TARGETS} from './flasher/targets.ts';

export type Callout = {kind: 'safety' | 'note'; title: string; text: string};

export type GuideStep = {
  title: string;
  /** What to do. */
  text: string;
  /** What the reader should see when the step worked. */
  see?: string;
  /** A literal block to type or paste, shown in a code box. */
  code?: string;
};

export type GuideSection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  code?: string;
};

export type Trouble = {problem: string; fix: string};

export type GuidePage = {
  /** URL segment within the family, e.g. `boot-mode`. */
  slug: string;
  /** Short label for step navigation, e.g. "Bootloader mode". */
  label: string;
  /** The H1 and HowTo name. */
  title: string;
  /** Meta description, 70 to 160 characters. */
  description: string;
  intro: string[];
  /** What the reader needs on the desk. Also emitted as HowTo `tool`. */
  tools: string[];
  callouts: Callout[];
  steps: GuideStep[];
  /** Extra material after the steps: alternatives, browser and OS notes. */
  sections?: GuideSection[];
  troubleshooting: Trouble[];
};

export type GuideFamily = {
  /** URL segment, e.g. `flash-openfc`. */
  id: string;
  /** Board family name as printed in the guide titles. */
  board: string;
  firmware: string;
  /** One line for the /guides index. */
  blurb: string;
  pages: GuidePage[];
};

export type GuideLocation = {
  family: GuideFamily;
  page: GuidePage;
  index: number;
  prev: GuidePage | null;
  next: GuidePage | null;
};

/** Site-relative path of a guide page. */
export function guidePath(familyId: string, slug: string): string {
  return `/guides/${familyId}/${slug}`;
}

function targetName(product: string): string {
  return FLASHER_TARGETS.find((t) => t.product === product)?.target ?? '';
}

const LITE_TARGET = targetName('openfc-lite');
const MINI_TARGET = targetName('openfc-lite-mini');

/** Shown on the pages where the board is on USB only. */
const FC_SAFETY: Callout = {
  kind: 'safety',
  title: 'Propellers off, battery unplugged',
  text: 'Take the propellers off the motors and unplug the flight battery before you start. The flight controller gets all the power it needs from the USB cable for this. Keep the battery unplugged for the whole update.',
};

const NEVER_UNPLUG: Callout = {
  kind: 'safety',
  title: 'Never unplug while it is writing',
  text: 'Do not unplug the cable, close the browser tab or let the computer sleep while firmware is being written. If it happens anyway, the board can still be recovered: see [Recover a failed update](/guides/flash-openfc/recovery).',
};

const ESC_SAFETY: Callout = {
  kind: 'safety',
  title: 'Propellers off, battery only when a step asks for it',
  text: 'Take all four propellers off before you start: the motors beep and can twitch while the ESC restarts. The ESC is powered only by the flight battery, not by USB, so it has to be plugged in for flashing. Plug it in only at the step that says so, and unplug it as soon as you are done. If you own a smoke stopper (a fuse-like plug that limits current), use it between battery and drone.',
};

const ESC_NEVER_UNPLUG: Callout = {
  kind: 'safety',
  title: 'Never unplug while it is writing',
  text: 'Do not unplug the battery or the USB cable, or close the browser tab, while the ESC is being flashed. If it happens anyway, the AM32 bootloader on the ESC stays intact and you can flash again: see [Recover a failed ESC update](/guides/flash-openesc/recovery).',
};

const BROWSER_NOTE: Callout = {
  kind: 'note',
  title: 'Which browser',
  text: 'Downloading the firmware and dragging it onto the board works in every browser. Installing directly from the page, and the Betaflight app, need **Chrome or Edge** on a computer, because only those can talk to USB and serial devices. Safari and phones cannot do this.',
};

const ESC_BROWSER_NOTE: Callout = {
  kind: 'note',
  title: 'Which browser',
  text: 'Flashing an ESC talks to the flight controller over a serial connection from the browser. Use **Chrome or Edge** on a computer. Safari and phones cannot do this.',
};

const FC_TOOLS = [
  'A computer running Windows, macOS or Linux',
  'A USB-C cable that carries data (some cables only charge)',
  'Your OpenFC-Lite or OpenFC-Lite Mini',
];

const ESC_TOOLS = [
  'A computer with Chrome or Edge',
  'A USB-C data cable for the flight controller',
  'Your OpenESC, connected to a flight controller running Betaflight with the 8-pin cable',
  'A charged flight battery',
];

const UDEV_RULE = `# /etc/udev/rules.d/99-rp2350-bootsel.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="000f", MODE="0660", TAG+="uaccess"`;

const UDEV_RELOAD = 'sudo udevadm control --reload-rules && sudo udevadm trigger';

const OPENFC: GuideFamily = {
  id: 'flash-openfc',
  board: 'OpenFC',
  firmware: 'Betaflight',
  blurb:
    'Put Betaflight on an OpenFC-Lite or OpenFC-Lite Mini flight controller over USB, check it worked, and recover from a failed update.',
  pages: [
    {
      slug: 'boot-mode',
      label: 'Bootloader mode',
      title: 'Put your OpenFC in bootloader mode',
      description:
        'Step 1 of updating an OpenFC flight controller: save your settings, then hold BOOT and plug in USB so the board shows up as a drive named RP2350.',
      intro: [
        'Before new firmware can go on, the flight controller has to be in **bootloader mode**. In this mode the board stops running Betaflight and shows up on your computer as a small USB drive called **RP2350**, ready to receive a firmware file.',
        'The bootloader is built into the chip itself and cannot be erased. Whatever happens during an update, you can always get back to this mode.',
      ],
      tools: FC_TOOLS,
      callouts: [FC_SAFETY, BROWSER_NOTE],
      steps: [
        {
          title: 'Make the drone safe',
          text: 'Take the propellers off and unplug the flight battery. Only the USB cable will be connected from now on.',
          see: 'No battery connected and no propellers on the motors.',
        },
        {
          title: 'Save your settings (skip this on a brand-new board)',
          text: 'If you have already set the board up, open [the Betaflight app](https://app.betaflight.com) in Chrome or Edge, plug in USB and click **Connect**. Open the **CLI** tab, type `diff all` and press Enter. Click **Save to File** and keep the file somewhere safe. Then click **Disconnect**.',
          see: 'A text file with your settings in your downloads folder.',
        },
        {
          title: 'Unplug the USB cable',
          text: 'Unplug the cable from the flight controller. Leave the other end in the computer.',
        },
        {
          title: 'Find the BOOT button',
          text: 'The board has a small push button for bootloader mode, usually labelled BOOT or BOOTSEL. Its position differs between the OpenFC-Lite and the Mini, so look at the label printed on your board and at the board\'s documentation: [OpenFC-Lite on GitHub](https://github.com/OpenDrone-hw/OpenFC-Lite) or [OpenFC-Lite Mini on GitHub](https://github.com/OpenDrone-hw/OpenFC-Lite-Mini).',
          see: 'You know which button to press. If you cannot find it, use the CLI method under "Other ways in" below.',
        },
        {
          title: 'Hold BOOT and plug in USB',
          text: 'Press and hold the BOOT button, plug the USB cable into the board while you keep holding it, then let go after about a second.',
          see: 'A new drive called **RP2350** appears on your computer. It contains two files, `INDEX.HTM` and `INFO_UF2.TXT`. The board is now in bootloader mode.',
        },
      ],
      sections: [
        {
          heading: 'Other ways in',
          paragraphs: [
            'If the board is running Betaflight, you do not need the button. In the Betaflight app\'s **CLI** tab, type `bl rom` and press Enter: the board restarts straight into bootloader mode. The [firmware page](/flash) also has a button that does the same in Chrome or Edge.',
          ],
        },
        {
          heading: 'Where the drive shows up',
          bullets: [
            '**Windows:** in File Explorer under This PC, with its own drive letter. Windows may open a window for it on its own.',
            '**macOS:** in Finder\'s sidebar under Locations, and on the desktop if you show drives there. On some Macs a prompt asks whether to allow the accessory to connect: click Allow.',
            '**Linux:** most desktops mount it automatically under `/media` or `/run/media`. In a terminal, `lsusb` lists it as `2e8a:000f`.',
          ],
        },
      ],
      troubleshooting: [
        {
          problem: 'No RP2350 drive appears.',
          fix: 'Try another USB cable first: many cables only charge and carry no data. Plug straight into the computer, not through a hub or dock, and try another port. Make sure you hold the button down before the cable goes in.',
        },
        {
          problem: 'The board shows up as a serial port or connects in the Betaflight app instead.',
          fix: 'It started normally, so the button was not held while the cable went in. Unplug, hold BOOT first, then plug in. Or use `bl rom` in the CLI.',
        },
        {
          problem: 'I am not sure the drive is the flight controller.',
          fix: 'Open `INFO_UF2.TXT` on the drive. It should say `Board-ID: RP2350`. If it says anything else, do not copy firmware onto it.',
        },
        {
          problem: 'Nothing happens on any cable, port or computer.',
          fix: 'Open a [support ticket](/support) and tell us what you tried. Do not try to fix the board with a soldering iron.',
        },
      ],
    },
    {
      slug: 'flash',
      label: 'Install',
      title: 'Install Betaflight on your OpenFC',
      description:
        'Step 2 of updating an OpenFC: drag the verified Betaflight file from the firmware page onto the RP2350 drive, or install it directly in Chrome or Edge.',
      intro: [
        'There are two ways to put the firmware on. **Drag and drop** works in every browser and on every computer: you download the file and copy it onto the RP2350 drive. **Direct install** does the same from the web page in one click, in Chrome or Edge only.',
        'Either way, the firmware page checks the file before you get it: its size and checksum must match the signed release list, and it must be built for the board you picked.',
      ],
      tools: FC_TOOLS,
      callouts: [FC_SAFETY, NEVER_UNPLUG, BROWSER_NOTE],
      steps: [
        {
          title: 'Open the firmware page and pick your board',
          text: 'Go to [the firmware page](/flash) and choose your board. The name is printed on the board: OpenFC-Lite or OpenFC-Lite Mini.',
          see: `The page shows the firmware version, its release date and the target name: \`${LITE_TARGET}\` for the OpenFC-Lite, \`${MINI_TARGET}\` for the Mini. Write the version down; you will check it later.`,
        },
        {
          title: 'Download and verify the file',
          text: 'Click the download-and-verify button for the version you want.',
          see: 'A message that the file was checked. If the page reports a problem instead, do not use the file; see below.',
        },
        {
          title: 'Save the file',
          text: 'Click the save button.',
          see: 'A file ending in `.uf2` in your downloads folder.',
        },
        {
          title: 'Put the board in bootloader mode',
          text: 'Follow [Put your OpenFC in bootloader mode](/guides/flash-openfc/boot-mode) if it is not there already.',
          see: 'The **RP2350** drive on your computer.',
        },
        {
          title: 'Drag the file onto the RP2350 drive',
          text: 'Drag the `.uf2` file from your downloads folder onto the RP2350 drive, or copy and paste it there. Do not unplug anything while it copies.',
          see: 'A short copy, then the drive disappears by itself. That is the board restarting with the new firmware. Your computer may warn that the disk was not ejected properly: that is normal here and harmless.',
        },
      ],
      sections: [
        {
          heading: 'Direct install in Chrome or Edge',
          paragraphs: [
            'With the board in bootloader mode, the firmware page offers to install the checked file directly. Click it, choose the **RP2350** device in the list the browser shows, confirm the checks on the page, and wait for the progress bar to finish. The board restarts on its own at the end.',
            'If the page cannot open the device, use drag and drop instead. It does exactly the same job.',
          ],
        },
        {
          heading: 'Windows, macOS and Linux notes',
          bullets: [
            '**Windows:** no driver is needed for either method. If you once replaced the board\'s USB driver with a tool such as Zadig, direct install may fail on that computer; use drag and drop.',
            '**macOS:** drag and drop works from Finder. Ignore the "Disk Not Ejected Properly" message afterwards.',
            '**Linux:** drag and drop works on any desktop that mounts the drive. Direct install needs permission to open the device; add the rule below once, then unplug and replug the board.',
          ],
          code: `${UDEV_RULE}\n\n${UDEV_RELOAD}`,
        },
      ],
      troubleshooting: [
        {
          problem: 'The page says the file failed its check.',
          fix: 'Do not use that file. Reload the page and download it again. If it keeps failing, open a [support ticket](/support).',
        },
        {
          problem: 'The drive disappeared, but after replugging the board is in bootloader mode again.',
          fix: 'The board did not accept the file, usually because it was not a `.uf2` for this board. Download it again from the firmware page for the board printed on yours, and copy it again.',
        },
        {
          problem: 'The copy stopped halfway, or the cable came out.',
          fix: 'Nothing is lost. Follow [Recover a failed update](/guides/flash-openfc/recovery).',
        },
        {
          problem: 'Chrome or Edge shows no device to choose for direct install.',
          fix: 'Check the board is in bootloader mode (the RP2350 drive is visible). On Linux, add the udev rule above. Otherwise use drag and drop.',
        },
        {
          problem: 'The direct install button is missing.',
          fix: 'Your browser cannot talk to USB devices (Safari and Firefox cannot). Use drag and drop, which works everywhere.',
        },
      ],
    },
    {
      slug: 'verify',
      label: 'Check',
      title: 'Check the firmware on your OpenFC',
      description:
        'Step 3 of updating an OpenFC: connect in the Betaflight app, run the CLI version command and confirm the board name and version match the firmware page.',
      intro: [
        'The update finished when the drive disappeared. Now confirm that the board runs the firmware you meant to install, and that your settings are still there.',
      ],
      tools: FC_TOOLS,
      callouts: [FC_SAFETY, BROWSER_NOTE],
      steps: [
        {
          title: 'Plug the board in normally',
          text: 'Unplug the USB cable, then plug it back in without touching any button.',
          see: 'No RP2350 drive this time. The board is running Betaflight.',
        },
        {
          title: 'Connect in the Betaflight app',
          text: 'Open [the Betaflight app](https://app.betaflight.com) in Chrome or Edge, click **Connect** and choose the board in the list.',
          see: 'The app connects and opens its setup screen.',
        },
        {
          title: 'Run the version command',
          text: 'Open the **CLI** tab, type `version` and press Enter.',
          see: `A few lines that name Betaflight, its version number and the board: \`${LITE_TARGET}\` on an OpenFC-Lite, \`${MINI_TARGET}\` on a Mini.`,
        },
        {
          title: 'Compare with the firmware page',
          text: 'Check that the version matches the one the [firmware page](/flash) showed, and that the board name matches the board printed on yours.',
          see: 'Both match. The firmware update is done.',
        },
        {
          title: 'Check your settings',
          text: 'Settings usually survive an update, but do not count on it. If your ports, modes or rates are back to defaults, paste the `diff all` file you saved into the CLI, press Enter, then type `save` and press Enter.',
          see: 'The board restarts and your settings are back.',
        },
      ],
      troubleshooting: [
        {
          problem: 'The Betaflight app does not list the board.',
          fix: 'Try another data cable and port. On Linux, add your user to the `dialout` group (`uucp` on Arch), log out and in again; if the port keeps disappearing, ModemManager may be grabbing it. On a Mac, allow the accessory to connect if asked.',
        },
        {
          problem: 'The board name in `version` is not the board you have.',
          fix: 'The firmware for the other board went on. Go back to the [firmware page](/flash), pick the board printed on yours and install again. Bootloader mode always works, so this is fixable.',
        },
        {
          problem: 'The version is not the one the firmware page showed.',
          fix: 'The new file did not go on. Install again, and wait for the drive to disappear by itself before you unplug.',
        },
        {
          problem: 'The board keeps coming up as the RP2350 drive.',
          fix: 'It has no working firmware. Follow [Recover a failed update](/guides/flash-openfc/recovery).',
        },
        {
          problem: 'The app says the firmware is too new or too old for it.',
          fix: 'Use the web version at app.betaflight.com, which is always the current release, rather than an old installed copy.',
        },
      ],
    },
    {
      slug: 'recovery',
      label: 'Recover',
      title: 'Recover an OpenFC after a failed update',
      description:
        'How to bring back an OpenFC flight controller after an interrupted or wrong firmware update: bootloader mode is in ROM, so the board can always be reflashed.',
      intro: [
        'An unplugged cable, a closed tab or the wrong file cannot break the flight controller for good. The bootloader lives in read-only memory inside the chip, and no firmware update touches it. If the board does not start, starts wrong, or does not show up at all, you can start over from bootloader mode.',
        'This page covers: an update that stopped halfway, firmware for the wrong board, a board that no longer connects, and settings that were lost.',
      ],
      tools: FC_TOOLS,
      callouts: [FC_SAFETY, NEVER_UNPLUG],
      steps: [
        {
          title: 'Unplug everything',
          text: 'Unplug the USB cable and the flight battery. Wait a few seconds.',
        },
        {
          title: 'Enter bootloader mode with the button',
          text: 'Hold the BOOT button and plug in USB, as in [Put your OpenFC in bootloader mode](/guides/flash-openfc/boot-mode). This works even when the board shows nothing else, has no working firmware or is not recognised.',
          see: 'The **RP2350** drive appears.',
        },
        {
          title: 'Get a fresh, checked file',
          text: 'On the [firmware page](/flash), pick the board printed on yours and download the file again. Do not reuse a file from an interrupted download.',
          see: 'The page reports the file as checked, and a `.uf2` file is saved.',
        },
        {
          title: 'Copy it onto the drive',
          text: 'Drag the file onto the RP2350 drive and leave everything plugged in until the drive disappears by itself.',
          see: 'The drive disappears: the board restarted with the new firmware.',
        },
        {
          title: 'Check and restore',
          text: 'Follow [Check the firmware on your OpenFC](/guides/flash-openfc/verify). If your settings are gone, paste your saved `diff all` into the CLI and type `save`.',
          see: 'The right board name and version, and your settings back.',
        },
      ],
      troubleshooting: [
        {
          problem: 'The RP2350 drive never appears, even with the button held.',
          fix: 'Almost always the cable or port: use a cable you know carries data, plug straight into the computer, and try another computer if you have one.',
        },
        {
          problem: 'I lost my settings and have no saved `diff all`.',
          fix: 'Set the board up again in the Betaflight app. Save a `diff all` once you are done, so next time it is one paste.',
        },
        {
          problem: 'Still stuck.',
          fix: 'Open a [support ticket](/support) with the board name, what you tried and what you saw. Ask in our [Discord](@discord) too: other pilots often have the answer fast.',
        },
      ],
    },
  ],
};

const OPENESC: GuideFamily = {
  id: 'flash-openesc',
  board: 'OpenESC',
  firmware: 'AM32',
  blurb:
    'Update AM32 on an OpenESC 4-in-1 through your flight controller from the browser, check every motor channel, and retry a failed flash.',
  pages: [
    {
      slug: 'connect',
      label: 'Connect',
      title: 'Connect your OpenESC for flashing',
      description:
        'Step 1 of updating an OpenESC: connect it through your Betaflight flight controller with props off, so the browser can reach the AM32 bootloader on each motor.',
      intro: [
        'The OpenESC has four small processors, one per motor, each running AM32. Each one has an AM32 **bootloader** that can receive new firmware. Unlike the flight controller, there is no button to press: the flashing tool wakes the bootloader up through the motor signal wire.',
        'The usual way in is **through the flight controller** (called passthrough): the browser talks to the flight controller over USB, and the flight controller passes the data on to the ESC over the 8-pin cable. A USB link adapter is an alternative, covered at the end.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_SAFETY, ESC_BROWSER_NOTE],
      steps: [
        {
          title: 'Take the propellers off',
          text: 'Remove all four propellers. Keep the battery unplugged for now.',
          see: 'Bare motor shafts, no battery connected.',
        },
        {
          title: 'Check the flight controller',
          text: 'The ESC must be plugged into the flight controller with the 8-pin cable, and the flight controller must run Betaflight. If you are not sure, follow [Check the firmware on your OpenFC](/guides/flash-openfc/verify) first.',
          see: 'The flight controller connects in the Betaflight app. Disconnect it there again before the next step: only one page can use the port at a time.',
        },
        {
          title: 'Plug the flight controller into the computer',
          text: 'Connect the flight controller with a USB data cable. Do not press the BOOT button: the flight controller has to run Betaflight normally for passthrough.',
        },
        {
          title: 'Connect from the browser',
          text: 'Open the [firmware page](/flash) and choose OpenESC, or open [esc-configurator.com](https://esc-configurator.com). Click the connect button and pick the flight controller\'s port in the list Chrome or Edge shows.',
          see: 'The page says it is connected to the flight controller.',
        },
        {
          title: 'Plug in the battery',
          text: 'Now plug the flight battery in. Keep your hands and the cables clear of the motors.',
          see: 'The motors play their start-up beeps. The ESC is powered.',
        },
        {
          title: 'Read the ESCs',
          text: 'Click the button to read the ESCs (in esc-configurator it is **Read Settings**).',
          see: 'Four ESC entries, one per motor, each showing AM32 and its version. You are ready to flash.',
        },
      ],
      sections: [
        {
          heading: 'With a USB link adapter instead',
          paragraphs: [
            'If you have no flight controller connected, a USB link adapter for AM32 or BLHeli ESCs can reach the bootloader directly. Wire it to the ESC\'s signal and ground as the adapter\'s instructions describe; the OpenESC\'s pad labels are in its documentation ([OpenESC 20×20](https://github.com/OpenDrone-hw/OpenESC-20x20), [OpenESC 30×30](https://github.com/OpenDrone-hw/OpenESC-30x30)). An adapter on one signal line reaches one motor\'s processor at a time. The battery is still needed to power the ESC.',
          ],
        },
      ],
      troubleshooting: [
        {
          problem: 'The browser lists no port.',
          fix: 'Check the flight controller is running Betaflight (not in bootloader mode), try another data cable, and close the Betaflight app or any other tab that might hold the port.',
        },
        {
          problem: 'No ESCs, or fewer than four, are found.',
          fix: 'Make sure the battery is plugged in and the 8-pin cable is seated at both ends. Unplug the battery, reconnect in the browser, plug the battery in again and read again.',
        },
        {
          problem: 'One ESC entry is always missing or shows no firmware.',
          fix: 'That motor\'s processor may be waiting in its bootloader after an earlier failed flash. Follow [Recover a failed ESC update](/guides/flash-openesc/recovery).',
        },
        {
          problem: 'No beeps when the battery goes in.',
          fix: 'Unplug the battery at once and check the battery wiring and the connector. If it still stays silent, open a [support ticket](/support).',
        },
      ],
    },
    {
      slug: 'flash',
      label: 'Install',
      title: 'Install AM32 on your OpenESC',
      description:
        'Step 2 of updating an OpenESC: get the verified AM32 file from the firmware page and flash all four motor channels through the flight controller.',
      intro: [
        'With the ESCs read, you can put new AM32 firmware on them. The [firmware page](/flash) gives you a file checked against the signed release list for your exact ESC model. You can flash from that page directly, or load the same file into esc-configurator.com.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_SAFETY, ESC_NEVER_UNPLUG, ESC_BROWSER_NOTE],
      steps: [
        {
          title: 'Pick your exact ESC model',
          text: 'On the [firmware page](/flash), choose OpenESC and the model printed on your board, 20×20 or 30×30.',
          see: 'The page shows the AM32 version it will install. Write it down; you will check it later.',
        },
        {
          title: 'Connect as in step 1',
          text: 'Follow [Connect your OpenESC for flashing](/guides/flash-openesc/connect) up to reading the ESCs.',
          see: 'Four ESCs found, battery in, propellers off.',
        },
        {
          title: 'Start the flash',
          text: 'On the firmware page, click the button to flash all ESCs. In esc-configurator instead: download the checked file from the firmware page first, click **Flash All**, choose the option to use a file from your computer and pick that file.',
          see: 'A progress bar per ESC, filling one after the other.',
        },
        {
          title: 'Wait for all four',
          text: 'Leave the battery and USB plugged in and keep the tab open until every ESC has finished.',
          see: 'All four ESCs report success. The motors beep as each one restarts.',
        },
        {
          title: 'Unplug the battery',
          text: 'Unplug the flight battery as soon as flashing is done.',
        },
      ],
      troubleshooting: [
        {
          problem: 'One ESC failed and the others worked.',
          fix: 'Flash again. The AM32 bootloader stays intact when a flash fails, so a retry is safe. See [Recover a failed ESC update](/guides/flash-openesc/recovery).',
        },
        {
          problem: 'The tool warns that the file does not match the ESC.',
          fix: 'Stop and do not force it. Firmware built for a different ESC can damage the board when the motors run. Get the file for your exact model from the firmware page.',
        },
        {
          problem: 'Flashing stops with a connection error.',
          fix: 'Unplug the battery, reload the page, connect again and retry. Make sure the computer does not go to sleep during the flash.',
        },
      ],
    },
    {
      slug: 'verify',
      label: 'Check',
      title: 'Check the firmware on your OpenESC',
      description:
        'Step 3 of updating an OpenESC: read all four ESCs, confirm each shows the AM32 version from the firmware page, then test the motors with props off.',
      intro: [
        'Confirm that all four motor channels run the new AM32 version, and that the motors still spin the right way.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_SAFETY, ESC_BROWSER_NOTE],
      steps: [
        {
          title: 'Read the ESCs again',
          text: 'With propellers off, connect as in [step 1](/guides/flash-openesc/connect): USB to the flight controller, connect in the browser, battery in, then read the ESCs.',
          see: 'Four ESC entries.',
        },
        {
          title: 'Compare the versions',
          text: 'Each entry shows AM32 and a version number. Compare all four with the version the [firmware page](/flash) showed.',
          see: 'All four show the same, new version.',
        },
        {
          title: 'Check the ESC settings',
          text: 'Look over the settings shown for each ESC, such as motor direction. If anything changed that you had set before, set it again and write the settings.',
          see: 'The settings are as you want them.',
        },
        {
          title: 'Test the motors',
          text: 'Disconnect in the browser. In the Betaflight app, open the **Motors** tab, read and accept the safety notice, and spin each motor briefly at low speed.',
          see: 'Every motor spins smoothly, in the direction the motor diagram shows.',
        },
        {
          title: 'Unplug the battery',
          text: 'Unplug the battery, then the USB cable.',
        },
      ],
      troubleshooting: [
        {
          problem: 'The ESCs show different versions.',
          fix: 'Flash again; the ones that are already current are simply rewritten.',
        },
        {
          problem: 'One ESC shows no firmware or is missing.',
          fix: 'Follow [Recover a failed ESC update](/guides/flash-openesc/recovery).',
        },
        {
          problem: 'A motor spins the wrong way.',
          fix: 'Change its direction in the ESC settings rather than resoldering wires, then test again.',
        },
        {
          problem: 'A motor stutters or does not spin.',
          fix: 'Check that the ESC version is right first. If it is, unplug the battery and look for a loose motor wire or solder joint. If you are stuck, open a [support ticket](/support).',
        },
      ],
    },
    {
      slug: 'recovery',
      label: 'Recover',
      title: 'Recover a failed ESC update',
      description:
        'How to bring back an OpenESC after a failed or interrupted AM32 flash: the AM32 bootloader stays intact, so power-cycle, reconnect and flash again.',
      intro: [
        'A failed or interrupted ESC flash is almost always fixable. The AM32 bootloader sits in its own part of each processor\'s memory and is not overwritten by a firmware update. After a failed flash, that motor\'s processor stays in its bootloader and waits for firmware. Its motor will not spin, but the processor can be flashed again.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_SAFETY, ESC_NEVER_UNPLUG],
      steps: [
        {
          title: 'Unplug the battery',
          text: 'Unplug the flight battery and wait a few seconds. Leave the propellers off.',
        },
        {
          title: 'Reconnect',
          text: 'Connect as in [step 1](/guides/flash-openesc/connect): USB to the flight controller, connect in the browser, then plug in the battery.',
          see: 'Start-up beeps from the ESCs that still have firmware. The failed one may stay silent.',
        },
        {
          title: 'Read the ESCs',
          text: 'Read the ESCs.',
          see: 'The failed ESC may show no firmware or an unknown version. That is expected.',
        },
        {
          title: 'Flash again with a fresh, checked file',
          text: 'Get the file for your exact model from the [firmware page](/flash) again and flash all ESCs, as in [Install AM32 on your OpenESC](/guides/flash-openesc/flash).',
          see: 'Every ESC reports success.',
        },
        {
          title: 'Check',
          text: 'Follow [Check the firmware on your OpenESC](/guides/flash-openesc/verify).',
          see: 'All four ESCs show the new version and all motors spin.',
        },
      ],
      troubleshooting: [
        {
          problem: 'The failed ESC is not found at all, even after a power cycle.',
          fix: 'Check the 8-pin cable and the solder joints on that motor\'s signal pad, then retry. Flash the others meanwhile; they are independent.',
        },
        {
          problem: 'It still fails after several tries.',
          fix: 'If the bootloader itself were damaged, the processor would need a special programmer, which is not a job for a beginner. Open a [support ticket](/support) with the ESC model, which motor channel fails and what the tool showed.',
        },
      ],
    },
  ],
};

export const GUIDE_FAMILIES: readonly GuideFamily[] = [OPENFC, OPENESC];

/** The family and page for a URL, with its neighbours in the family. */
export function findGuide(familyId: string, slug: string): GuideLocation | null {
  const family = GUIDE_FAMILIES.find((f) => f.id === familyId);
  if (!family) return null;
  const index = family.pages.findIndex((p) => p.slug === slug);
  if (index < 0) return null;
  return {
    family,
    page: family.pages[index],
    index,
    prev: family.pages[index - 1] ?? null,
    next: family.pages[index + 1] ?? null,
  };
}

export function findFamily(familyId: string): GuideFamily | null {
  return GUIDE_FAMILIES.find((f) => f.id === familyId) ?? null;
}

/** Every guide URL, index first, in reading order. Feeds the sitemap. */
export function guidePaths(): string[] {
  return [
    '/guides',
    ...GUIDE_FAMILIES.flatMap((f) => f.pages.map((p) => guidePath(f.id, p.slug))),
  ];
}

/** Guide markup down to plain text, for JSON-LD and anything else that is not HTML. */
export function plainText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/** schema.org HowTo for one guide page. `origin` is the canonical site origin. */
export function buildHowToJsonLd(loc: GuideLocation, origin: string) {
  const url = `${origin}${guidePath(loc.family.id, loc.page.slug)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: loc.page.title,
    description: loc.page.description,
    url,
    inLanguage: 'en',
    tool: loc.page.tools.map((name) => ({'@type': 'HowToTool', name})),
    step: loc.page.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: plainText(s.title),
      text: plainText(s.see ? `${s.text} You should see: ${s.see}` : s.text),
      url: `${url}#step-${i + 1}`,
    })),
  };
}

/** JSON for a `<script type="application/ld+json">`, safe against `</script>` in a string. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, String.raw`\u003c`);
}
