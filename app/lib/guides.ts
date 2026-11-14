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
 * `**strong**`, `*em*`) plus backticks for code. Links to `/guides/flash` are rendered
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

export type Callout = {kind: 'safety' | 'note'; title: string; text: string; /** Rendered as a numbered list under the text. */ items?: string[]};

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
  /** false: do not emit HowTo JSON-LD (the steps cannot be carried out yet). */
  howTo?: false;
  /**
   * The page as it reads while the firmware page's one-button install is on
   * (directInstallEnabled, app/lib/flasher/direct-install.ts). Replaces the
   * listed fields; the rest is shared. On in production since the OpenFC-Lite
   * pin was bench-verified (2026-11-02); the direct copy says the Mini comes later.
   */
  direct?: GuidePageDirect;
};

export type GuidePageDirect = Partial<Pick<GuidePage, 'intro' | 'callouts' | 'steps' | 'sections' | 'troubleshooting'>>;

/** The page a reader sees: its `direct` variant while the one-button install is on. */
export function resolveGuidePage(page: GuidePage, directInstall: boolean): GuidePage {
  return directInstall && page.direct ? {...page, ...page.direct} : page;
}

/** A link to the firmware page listed first in a family on the /guides index. */
export type GuideToolLink = {href: string; title: string; directTitle: string};

export type GuideFamily = {
  /** URL segment, e.g. `flash-openfc`. */
  id: string;
  /** Board family name as printed in the guide titles. */
  board: string;
  firmware: string;
  /** One line for the /guides index. */
  blurb: string;
  /** Listed before the steps on the /guides index (directTitle while the one-button install is on). */
  tool?: GuideToolLink;
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

/** The firmware page's pre-flash checklist (FcFlasher), minus props/battery: FC_SAFETY sits next to it. */
const PRE_FLASH: Callout = {
  kind: 'safety',
  title: 'Before you flash',
  text: '',
  items: [
    'Back up your config: save `diff all` in the Betaflight CLI. Flashing resets settings.',
    'Computer only (Chrome/Edge), data-capable USB cable.',
    'On a new board: test on USB before soldering.',
  ],
};

const NEVER_UNPLUG: Callout = {
  kind: 'safety',
  title: 'Never unplug while it is writing',
  text: 'Do not unplug the cable, close the browser tab or let the computer sleep while firmware is being written. If it happens anyway, see [Recover a failed update](/guides/flash-openfc/recovery).',
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
  text: 'Dragging the firmware file onto the board works in every browser. The Betaflight app, and the firmware page\'s buttons that identify the board or restart it into bootloader mode, need **Chrome or Edge** on a computer, because only those can talk to USB and serial devices. Safari and phones cannot do this.',
};

const ESC_BROWSER_NOTE: Callout = {
  kind: 'note',
  title: 'Which browser',
  text: 'Reading an ESC talks to the flight controller over a serial connection from the browser. Use **Chrome or Edge** on a computer. Safari and phones cannot do this.',
};

/** OpenFC-Lite published (2026-11-03); the Lite Mini not yet. */
const FC_NOT_PUBLISHED: Callout = {
  kind: 'note',
  title: 'The OpenFC Lite 20×20 file is not published yet',
  text: 'The [firmware page](/guides/flash) has the OpenFC Lite 30×30 file. For the OpenFC Lite 20×20 it still shows "firmware not published yet": its download will appear there once it is released. Do not use firmware files from other places.',
};

/** The status every ESC page that mentions installing carries. Tested in guides.test.ts. */
export const ESC_COMING_STATUS = 'Coming after bench verification';

const ESC_COMING: Callout = {
  kind: 'note',
  title: ESC_COMING_STATUS,
  text: 'Installing AM32 on an OpenESC from the [firmware page](/guides/flash) is **coming after bench verification**. Right now the page switches it off, and there is no published AM32 release for the OpenESC yet. You can still connect and read what your ESCs run today. Do not flash third-party AM32 files onto an OpenESC: they are not built for this board.',
};

const FC_TOOLS = [
  'A computer running Windows, macOS or Linux',
  'A USB-C cable that carries data (some cables only charge)',
  'Your OpenFC Lite 30×30 or OpenFC Lite 20×20',
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

const VERIFY_STEPS: GuideStep[] = [
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
      see: `A few lines that name Betaflight, its version number and the board: \`${LITE_TARGET}\` on an OpenFC Lite 30×30, \`${MINI_TARGET}\` on an OpenFC Lite 20×20.`,
    },
    {
      title: 'Compare with the firmware page',
      text: 'Check that the version matches the one the [firmware page](/guides/flash) listed for the file you installed, and that the board name matches the board printed on yours. If the page labelled the file a pre-release (alpha) build, the version ends in `-alpha`: that is expected, not an error.',
      see: 'Both match. The firmware update is done.',
    },
    {
      title: 'Check your settings',
      text: 'An update can reset your settings. If your ports, modes or rates are back to defaults, paste the `diff all` file you saved into the CLI, press Enter, then type `save` and press Enter.',
      see: 'The board restarts and your settings are back.',
    },
];

/**
 * One-button install on the firmware page (FcFlasher, gated by directInstallEnabled).
 * Facts: BENCH-SHEET.md run log 2026-11-02 (OpenFC-Lite, Chrome, config reset), FIRMWARE-SHIPPED.md.
 */
const BOOT_MODE_DIRECT: GuidePageDirect = {
  intro: [
    'On an OpenFC Lite 30×30 (this board only), clicking **Update firmware** on the [firmware page](/guides/flash) restarts the board into bootloader mode for you, so usually you can skip this page. Use it when that step fails, for the OpenFC Lite 20×20, or for the copy method.',
    'In bootloader mode the board shows up as a drive called **RP2350**. The bootloader is in ROM inside the chip and cannot be erased.',
  ],
  sections: [
    {
      heading: 'Other ways in',
      paragraphs: [
        "If the board runs Betaflight, type `bl rom` in the Betaflight app's **CLI** tab and press Enter. That is what the firmware page does for you. If no RP2350 drive appears, use the BOOT button.",
      ],
    },
  ],
};

const INSTALL_DIRECT: GuidePageDirect = {
  intro: [
    'In Chrome or Edge, the [firmware page](/guides/flash) installs Betaflight with one button. It checks the file and the board before it writes anything.',
    'This works for the OpenFC Lite 30×30. The OpenFC Lite 20×20 file comes later.',
    "Installing resets the board's settings, so save them first.",
  ],
  callouts: [
    PRE_FLASH,
    FC_SAFETY,
    {
      kind: 'safety',
      title: 'Never unplug while it is writing',
      text: 'Do not unplug the cable, close the tab or let the computer sleep until the page says Done. If it happens anyway, see [Recover a failed update](/guides/flash-openfc/recovery).',
    },
  ],
  steps: [
    {
      title: 'Save your settings',
      text: 'In [the Betaflight app](https://app.betaflight.com), open the **CLI** tab, type `diff all`, press Enter and click **Save to File**. Then click **Disconnect**.',
      see: 'A text file with your settings. Skip this on a brand-new board.',
    },
    {
      title: 'Click Update firmware',
      text: 'Plug in USB, open [the firmware page](/guides/flash), choose **Flight controller** and click **Update firmware**.',
    },
    {
      title: 'Choose the serial port',
      text: "Pick your board's serial port in the window that opens.",
      see: 'The board restarts into bootloader mode.',
    },
    {
      title: 'Click Continue, then choose RP2350 Boot',
      text: 'Click **Continue** and choose **RP2350 Boot** in the second window. Do not unplug anything until the page says Done.',
      see: 'The page checks the file and the board, installs, restarts the board and says **Done**.',
    },
  ],
  sections: [
    {
      heading: 'Other ways, or if it fails',
      paragraphs: [
        'If a step fails, hold the BOOT button while you plug in USB, then click **Continue**. See [Put your OpenFC in bootloader mode](/guides/flash-openfc/boot-mode).',
        'Copy method, in any browser: open **Other ways** on the firmware page and save the file. Put the board in bootloader mode, then drag the `.uf2` file onto the **RP2350** drive. The drive disappears when the board restarts. Check the board name first: this method cannot stop a wrong file.',
      ],
    },
    {
      heading: 'Linux',
      paragraphs: ['For the Update firmware button, Chrome or Edge has to open the RP2350 device. Add this udev rule once, then unplug and replug the board.'],
      code: `${UDEV_RULE}\n\n${UDEV_RELOAD}`,
    },
  ],
  troubleshooting: [
    {
      problem: 'There is no RP2350 Boot in the second window.',
      fix: 'The board did not restart into bootloader mode. Hold BOOT while you plug in USB, then click **Continue**.',
    },
    {
      problem: 'The page cannot identify the firmware on the board.',
      fix: 'It refuses rather than guess. If you are sure the board is an OpenFC Lite 30×30 or OpenFC Lite 20×20, use the copy method above.',
    },
    {
      problem: 'The page says "Not installing".',
      fix: 'It found a different board or chip than the one you chose, and wrote nothing. Pick the board printed on yours and try again.',
    },
    {
      problem: 'The page says the file failed its check.',
      fix: 'Do not use that file. Reload the page and try again. If it keeps failing, open a [support ticket](/support).',
    },
    {
      problem: 'The install stopped halfway, or the cable came out.',
      fix: 'Follow [Recover a failed update](/guides/flash-openfc/recovery).',
    },
    {
      problem: 'The page says this browser cannot reach USB.',
      fix: 'Use Chrome or Edge on a computer, or the copy method above, which works in every browser.',
    },
  ],
};

const VERIFY_DIRECT: GuidePageDirect = {
  intro: ['Once the firmware page says **Done**, confirm that the board runs the firmware you meant to install, and put your settings back.'],
  steps: VERIFY_STEPS.map((step) =>
    step.title === 'Check your settings'
      ? {
          ...step,
          text: 'Installing from the firmware page resets the settings. Paste the `diff all` file you saved into the CLI, press Enter, then type `save` and press Enter.',
        }
      : step,
  ),
};

const OPENFC: GuideFamily = {
  id: 'flash-openfc',
  board: 'OpenFC',
  firmware: 'Betaflight',
  blurb:
    'Put Betaflight on an OpenFC Lite 30×30 or OpenFC Lite 20×20 flight controller over USB, check it worked, and recover from a failed update.',
  tool: {href: '/guides/flash', title: 'Open the firmware page', directTitle: 'Update firmware with one button'},
  pages: [
    {
      slug: 'boot-mode',
      direct: BOOT_MODE_DIRECT,
      label: 'Bootloader mode',
      title: 'Put your OpenFC in bootloader mode',
      description:
        'Step 1 of updating an OpenFC flight controller: save your settings, then hold BOOT and plug in USB so the board shows up as a drive named RP2350.',
      intro: [
        'Before new firmware can go on, the flight controller has to be in **bootloader mode**. In this mode the board stops running Betaflight and shows up on your computer as a small USB drive called **RP2350**, ready to receive a firmware file.',
        'The bootloader is in ROM inside the chip and cannot be erased.',
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
          text: 'The board has a small push button for bootloader mode, usually labelled BOOT or BOOTSEL. Its position differs between the OpenFC Lite 30×30 and the OpenFC Lite 20×20, so look at the label printed on your board and at the board\'s documentation: [OpenFC Lite 30×30 on GitHub](https://github.com/OpenDrone-hw/OpenFC-Lite) or [OpenFC Lite 20×20 on GitHub](https://github.com/OpenDrone-hw/OpenFC-Lite-Mini).',
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
            'If the board is running Betaflight, you may not need the button. In the Betaflight app\'s **CLI** tab, type `bl rom` and press Enter: the board should restart straight into bootloader mode. The [firmware page](/guides/flash) also has a button meant to do the same in Chrome or Edge. Neither is checked on OpenFC boards yet: if no RP2350 drive appears and the board just restarts into Betaflight, use the BOOT button.',
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
          fix: 'It started normally, so the button was not held while the cable went in. Unplug, hold BOOT first, then plug in.',
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
      direct: INSTALL_DIRECT,
      description:
        'Step 2 of updating an OpenFC: download the verified Betaflight file from the firmware page and drag it onto the RP2350 drive.',
      intro: [
        'The way to put the firmware on is **drag and drop**. It works in every browser and on every computer: you download the file from the firmware page and copy it onto the RP2350 drive. Installing straight from the web page works for the OpenFC Lite 30×30 in Chrome or Edge; for the OpenFC Lite 20×20 it is not available yet.',
        '**OpenFC Lite 30×30: available. OpenFC Lite 20×20: not published yet.** Its download will appear on the firmware page once it is released.',
        'The firmware page checks the file before you get it: its size and checksum must match the release list built into the page, and it must be built for the board you picked.',
      ],
      tools: FC_TOOLS,
      callouts: [FC_NOT_PUBLISHED, PRE_FLASH, FC_SAFETY, NEVER_UNPLUG, BROWSER_NOTE],
      steps: [
        {
          title: 'Open the firmware page and pick your board',
          text: 'Go to [the firmware page](/guides/flash) and choose your board. The name is printed on the board: OpenFC Lite 30×30 or OpenFC Lite 20×20.',
          see: `The page shows the firmware version, whether it is a stable release or a pre-release (alpha) build, and the target name: \`${LITE_TARGET}\` for the OpenFC Lite 30×30, \`${MINI_TARGET}\` for the OpenFC Lite 20×20. Write the version down; you will check it later. For the OpenFC Lite 20×20 it still says "Firmware not published yet": come back later.`,
        },
        {
          title: 'Download and verify the file',
          text: 'When the page offers a release, click its download-and-verify button.',
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
          heading: 'Direct install: OpenFC Lite 30×30 only',
          paragraphs: [
            'The firmware page can write the file straight to an OpenFC Lite 30×30 from Chrome or Edge (checked on real boards). For the OpenFC Lite 20×20, use drag and drop, which works for every board and in every browser.',
          ],
        },
        {
          heading: 'Windows, macOS and Linux notes',
          bullets: [
            '**Windows:** no driver is needed. Drag and drop from File Explorer.',
            '**macOS:** drag and drop works from Finder. Ignore the "Disk Not Ejected Properly" message afterwards.',
            '**Linux:** drag and drop works on any desktop that mounts the drive. You only need the udev rule below if a browser or tool has to open the device itself; add it once, then unplug and replug the board.',
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
          fix: 'Follow [Recover a failed update](/guides/flash-openfc/recovery).',
        },
        {
          problem: 'The page says "Firmware not published yet" and offers no download.',
          fix: 'That is expected for the OpenFC Lite 20×20 today. Its download will appear once it is released. Do not use a firmware file from anywhere else.',
        },
        {
          problem: 'I cannot find an install button on the page.',
          fix: 'The install button is for the OpenFC Lite 30×30 in Chrome or Edge only. In other browsers, or for the OpenFC Lite 20×20, save the file and drag it onto the RP2350 drive, which works everywhere.',
        },
      ],
    },
    {
      slug: 'verify',
      direct: VERIFY_DIRECT,
      label: 'Check',
      title: 'Check the firmware on your OpenFC',
      description:
        'Step 3 of updating an OpenFC: connect in the Betaflight app, run the CLI version command and confirm the board name and version match the firmware page.',
      intro: [
        'The update finished when the drive disappeared. Now confirm that the board runs the firmware you meant to install, and that your settings are still there.',
      ],
      tools: FC_TOOLS,
      callouts: [FC_SAFETY, BROWSER_NOTE],
      steps: VERIFY_STEPS,
      troubleshooting: [
        {
          problem: 'The Betaflight app does not list the board.',
          fix: 'Try another data cable and port. On Linux, add your user to the `dialout` group (`uucp` on Arch), log out and in again; if the port keeps disappearing, ModemManager may be grabbing it. On a Mac, allow the accessory to connect if asked.',
        },
        {
          problem: 'The board name in `version` is not the board you have.',
          fix: 'The firmware for the other board went on. Go back to the [firmware page](/guides/flash), pick the board printed on yours and install again.',
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
      callouts: [FC_NOT_PUBLISHED, FC_SAFETY, NEVER_UNPLUG],
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
          text: 'Go to the [firmware page](/guides/flash), pick the board printed on yours and download the file again. Do not reuse a file from an interrupted download. If the page says "Firmware not published yet" (the OpenFC Lite 20×20 today), stop here: the board is safe in bootloader mode, and you can leave it unplugged until the file is out.',
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
    'Connect an OpenESC 4-in-1 through your flight controller and read what each motor channel runs. Installing AM32 from our page is coming after bench verification.',
  pages: [
    {
      slug: 'connect',
      label: 'Connect',
      title: 'Connect your OpenESC and read its firmware',
      description:
        'Step 1 for an OpenESC: connect it through your Betaflight flight controller with props off, and read the chip and AM32 firmware on each motor channel.',
      intro: [
        'The OpenESC has four small processors, one per motor, each running AM32. Each one has an AM32 **bootloader** that can receive new firmware. Unlike the flight controller, there is no button to press: the tool wakes the bootloader up through the motor signal wire.',
        'This guide covers connecting and reading, which works today. Installing new AM32 from our firmware page is **coming after bench verification**; see [Install AM32 on your OpenESC](/guides/flash-openesc/flash).',
        'The usual way in is **through the flight controller** (called passthrough): the browser talks to the flight controller over USB, and the flight controller passes the data on to the ESC over the 8-pin cable. The flight controller does not have to be an OpenFC: any board running Betaflight can do this. A USB link adapter is an alternative, covered at the end.',
        'Two tools can read the ESCs. The [firmware page](/guides/flash) shows the chip and the firmware name of each ESC. [esc-configurator.com](https://esc-configurator.com) also shows the AM32 version and the ESC settings. Both only read when you use them as described here.',
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
          title: 'Plug in the battery',
          text: 'Now plug the flight battery in, propellers still off. Keep your hands and the cables clear of the motors. The ESC gets its power only from the battery, so it must be in before you read.',
          see: 'The motors play their start-up beeps. The ESC is powered.',
        },
        {
          title: 'Read the ESCs',
          text: 'On the [firmware page](/guides/flash), choose OpenESC and click **Read ESC info** in its "Check your ESCs" step, then pick the flight controller\'s port in the list Chrome or Edge shows. That one click connects, switches the flight controller to ESC passthrough and reads every motor output. In esc-configurator instead, click **Connect**, then **Read Settings**. Either way, only read: do not flash anything.',
          see: 'On the firmware page: one row per motor output Betaflight has set up (four on a quad), each with the chip and the firmware name. In esc-configurator: one entry per ESC with AM32 and its version. Write down what you see.',
        },
        {
          title: 'Disconnect, then unplug the battery',
          text: 'Click **Disconnect** (on the firmware page or in esc-configurator), then unplug the flight battery.',
          see: 'The flight controller is back to normal and connects in the Betaflight app again.',
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
          problem: 'Every ESC row on the firmware page says "unreadable".',
          fix: 'The battery was not plugged in when you clicked Read, so the ESCs had no power. Click Disconnect, plug the battery in (propellers off) and click Read ESC info again. Also check the 8-pin cable is seated at both ends.',
        },
        {
          problem: 'The page finds fewer motor outputs than you have motors, or none.',
          fix: 'The page reads as many ESCs as Betaflight has motor outputs set up. Check the mixer and motor settings in the Betaflight app, then read again.',
        },
        {
          problem: 'The Betaflight app no longer connects after reading the ESCs.',
          fix: 'The flight controller is still in ESC passthrough, usually because the tab was closed without Disconnect. Power-cycle the flight controller to leave passthrough: unplug USB and the battery, wait five seconds, then plug USB back in.',
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
        'Installing AM32 on an OpenESC from the firmware page is coming after bench verification. What works today, and what to do and not do until then.',
      intro: [
        '**Coming after bench verification.** The [firmware page](/guides/flash) cannot flash an OpenESC yet. Its install code is switched off until it has been checked on real hardware, and there is no published AM32 release for the OpenESC. Nothing on this page is something to do to your ESC today.',
        'What you can do now is connect and read what your ESCs run (see [Connect your OpenESC and read its firmware](/guides/flash-openesc/connect)), and keep your current firmware. Right now the firmware page lists only the OpenESC-20x20; the 30x30 is not listed yet.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_COMING, ESC_SAFETY, ESC_NEVER_UNPLUG, ESC_BROWSER_NOTE],
      steps: [
        {
          title: 'Check the status on the firmware page',
          text: 'On the [firmware page](/guides/flash), choose OpenESC and the model printed on your board. Only the 20×20 is listed.',
          see: 'The page says "Firmware not published yet". That means there is nothing to install: this is expected today.',
        },
        {
          title: 'Read and note what your ESCs run now',
          text: 'Follow [Connect your OpenESC and read its firmware](/guides/flash-openesc/connect) and write down what each motor shows: the chip and firmware name on the firmware page, or the AM32 version in esc-configurator.',
          see: 'One line per motor written down. You clicked Disconnect and unplugged the battery afterwards.',
        },
        {
          title: 'Leave the firmware as it is',
          text: 'Do not flash AM32 files from other places onto the OpenESC, in esc-configurator or anywhere else. They are not built for this board and can damage it when the motors run.',
          see: 'Your ESCs keep working with the firmware they have.',
        },
        {
          title: 'Come back when the install is announced',
          text: 'When installing from the firmware page is enabled, this page will list the steps, and the page will offer a checked file for your exact model.',
        },
      ],
      sections: [
        {
          heading: 'What the install will look like (coming after bench verification)',
          paragraphs: [
            'This is the plan, not an instruction. Once it is enabled, the firmware page will check the file against the release list, check that the ESC chip and firmware name match your model, and refuse anything that does not match. If direct install stays unavailable, the page will give you the checked file to load into esc-configurator.com instead.',
          ],
        },
      ],
      troubleshooting: [
        {
          problem: 'The firmware page offers no download or install button for my ESC.',
          fix: 'That is expected today: installing AM32 is coming after bench verification, and there is no published OpenESC release yet.',
        },
        {
          problem: 'I want a newer AM32 right now.',
          fix: 'Wait for the OpenESC release. Generic AM32 files are not built for this board. Ask in our [Discord](@discord) or open a [support ticket](/support) if something is wrong with the ESCs you have.',
        },
        {
          problem: 'My ESC 30×30 is not listed.',
          fix: 'The firmware page lists only the OpenESC-20x20 for now. The 30x30 is not listed yet.',
        },
      ],
      howTo: false,
    },
    {
      slug: 'verify',
      label: 'Check',
      title: 'Check the firmware on your OpenESC',
      description:
        'Step 3 for an OpenESC: read all four ESCs, confirm they all run the same AM32 version, then test the motors with props off.',
      intro: [
        'Confirm that all four motor channels run the same AM32 version, and that the motors spin the right way. This works with the firmware your ESCs have today; installing a new version from our page is coming after bench verification.',
        'The AM32 version and the ESC settings are shown by [esc-configurator.com](https://esc-configurator.com), not by our firmware page: the firmware page only shows each ESC\'s chip and firmware name. Use esc-configurator here, and only read.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_SAFETY, ESC_BROWSER_NOTE],
      steps: [
        {
          title: 'Read the ESCs in esc-configurator',
          text: 'With propellers off, set up as in [step 1](/guides/flash-openesc/connect): USB to the flight controller, battery in. Open [esc-configurator.com](https://esc-configurator.com), click **Connect**, then **Read Settings**.',
          see: 'Four ESC entries, each with AM32 and a version.',
        },
        {
          title: 'Compare the versions',
          text: 'In esc-configurator, compare the four version numbers with each other. Once an OpenESC release is published on the [firmware page](/guides/flash), compare them with its version too.',
          see: 'All four show the same version.',
        },
        {
          title: 'Check the ESC settings',
          text: 'Still in esc-configurator, look over the settings shown for each ESC, such as motor direction. Change something only if you know why.',
          see: 'The settings are as you want them.',
        },
        {
          title: 'Test the motors',
          text: 'Click **Disconnect** in esc-configurator. In the Betaflight app, open the **Motors** tab, read and accept the safety notice, and spin each motor briefly at low speed.',
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
          fix: 'Do not flash them yourself with files from elsewhere. Open a [support ticket](/support) with the versions you see; reflashing from our page is coming after bench verification.',
        },
        {
          problem: 'One ESC shows no firmware or is missing.',
          fix: 'Follow [Recover a failed ESC update](/guides/flash-openesc/recovery).',
        },
        {
          problem: 'The Betaflight app does not connect after reading the ESCs.',
          fix: 'The flight controller is still in ESC passthrough. Power-cycle the flight controller to leave passthrough: unplug USB and the battery, wait five seconds, then plug USB back in.',
        },
        {
          problem: 'A motor spins the wrong way.',
          fix: 'Change its direction in the ESC settings rather than resoldering wires, then test again.',
        },
        {
          problem: 'A motor stutters or does not spin.',
          fix: 'Check that all four versions match first. If they do, unplug the battery and look for a loose motor wire or solder joint. If you are stuck, open a [support ticket](/support).',
        },
      ],
    },
    {
      slug: 'recovery',
      label: 'Recover',
      title: 'Recover a failed ESC update',
      description:
        'An OpenESC channel misbehaving after an AM32 flash: power-cycle and reconnect to read it. Reflash it with the AM32 install guide.',
      intro: [
        'This page covers reconnecting and reading the ESCs, reflashing with the AM32 install guide, and getting help. It is also for an ESC that was flashed with another tool.',
        'A failed or interrupted ESC flash is almost always fixable. The AM32 bootloader sits in its own part of each processor\'s memory and is not overwritten by a firmware update. After a failed flash, that motor\'s processor stays in its bootloader and waits for firmware. Its motor will not spin, but the processor can be flashed again.',
      ],
      tools: ESC_TOOLS,
      callouts: [ESC_COMING, ESC_SAFETY, ESC_NEVER_UNPLUG],
      steps: [
        {
          title: 'Unplug the battery',
          text: 'Unplug the flight battery and wait a few seconds. Leave the propellers off.',
        },
        {
          title: 'Reconnect',
          text: 'Set up as in [step 1](/guides/flash-openesc/connect): USB to the flight controller, then plug in the battery.',
          see: 'Start-up beeps from the ESCs that still have firmware. The failed one may stay silent.',
        },
        {
          title: 'Read the ESCs',
          text: 'Read the ESCs as in [step 1](/guides/flash-openesc/connect) (read only), then click **Disconnect**.',
          see: 'The failed ESC may show no firmware name, "unreadable" or an unknown version. That is expected.',
        },
        {
          title: 'Reflashing: coming after bench verification',
          text: 'Flash it again with [Install AM32 on your OpenESC](/guides/flash-openesc/flash). Do not flash third-party AM32 files onto the OpenESC. Leave the failed channel as it is and open a [support ticket](/support) with the ESC model, the channel and what the tool showed.',
          see: 'Nothing changes on the ESC. The other channels keep working.',
        },
        {
          title: 'Unplug the battery',
          text: 'Unplug the flight battery, then the USB cable. Keep the propellers off until the ESC is sorted out.',
        },
      ],
      troubleshooting: [
        {
          problem: 'The failed ESC is not found at all, even after a power cycle.',
          fix: 'Check the 8-pin cable and the solder joints on that motor\'s signal pad, then retry.',
        },
        {
          problem: 'The Betaflight app no longer connects to the flight controller.',
          fix: 'It is still in ESC passthrough. Power-cycle the flight controller to leave passthrough: unplug USB and the battery, wait five seconds, then plug USB back in.',
        },
        {
          problem: 'It still fails after several tries.',
          fix: 'Open a [support ticket](/support) with the ESC model, which motor channel fails and what the tool showed. If the bootloader itself were damaged, the processor would need a special programmer, which is not a job for a beginner.',
        },
      ],
      howTo: false,
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
