# Hero: exploded build

How the homepage 3D hero is made and how it plays. The drone sits whole, comes
apart into a logical exploded view, and then the scroll walkthrough visits its parts.

```
STEP assembly (Onshape release OpenFrame-3F rev2.2 / OpenFrame-5F rev2.2)
      |  scripts/hero-assets/explode/step_extract.py     (python3 + OCP, numpy)
      v
assembly.pkl  (every distinct part meshed once, every occurrence placed, CAD colours)
      |  scripts/hero-assets/explode/build_explode.py    (units, assembly order, moves)
      v
raw.glb + explode.json      (one named node per part; label, kind, timed moves, beat groups)
      |  scripts/hero-assets/compress-explode.mjs        (weld, simplify, meshopt, split)
      v
public/models/od3|od5/  frame.glb drive.glb video.glb board-*.glb chunks.json explode.json
                        + studio.json (look and motion tuning)
      |
      v
app/components/HeroDroneScene.tsx  ->  the site
```

## What plays

1. The assembled drone holds for `explode.holdSeconds` (0.9 s), then explodes over
   `explode.seconds` (2.5 s) while the camera pulls back from the assembled to the
   exploded framing. Every part eases through its own moves, top of the stack first
   (it is a disassembly: screws leave with the part they thread into).
2. Once exploded: drag to orbit (no idle spin), hover a part for its name and a dim
   of the rest, click to select it (the camera eases to it, the name stays), click
   empty space or press Escape to release. The Collapse / Explode button under the
   viewer plays the build back together and apart again.
3. The scroll walkthrough is the existing one (stops, rest stops, spring, rail
   ticks, keyboard, deep links `/#fc`, `#esc`, `#rx`, `#frame`, `#motors`). Each beat now
   focuses a group of the exploded model instead of pulling a part to a stage: the
   camera eases to the group, everything else dims, a spotlight lights it, the copy
   panel follows. A selection is dropped when the walkthrough moves.
4. `prefers-reduced-motion`: the 3D still loads on desktop, but starts in the exploded
   pose with no intro, no travelling camera (cuts), instant scroll steps and no drift.
   Under 768 px the 3D is still skipped (the fallback list is the content).

Load and cost are comparable to the previous hero: the same meshopt compression, the
same chunked streaming (airframe first, boards last), and the same material look from
`studio.json`.

| design | before (6 chunks) | after (6 chunks) |
|---|---|---|
| od3 (3") | 3.2 MB | 2.5 MB |
| od5 (5") | 3.0 MB | 2.9 MB |

## How the explode is computed

`units.py` groups the STEP leaves into parts ("units"): one screw, one plate, one
board (all SMD parts that stand on it merged in), one motor (its fragments merged),
the camera, the air unit, and so on. Names come from the CAD part names; a missing
mirrored camera soft mount is mirrored from the other one. The CAD colours are kept,
except TPU parts, which ship black and green: anything else is drawn black. The
camera side plates are anodised gold (#FBB600).

`plan.py` is the assembly-order model. Only the order and the clearances are authored;
every distance comes from the geometry:

- Layers bottom to top: bottom plate; arms and cross (also out radially along the
  arm axis, boots further along it, off the arm tips); middle plate with its press-fit
  inserts hovering over their holes; standoffs; the stack column (grommets, ESC,
  grommets, FC, nylon nuts); air unit mount, receiver (its antenna slides out of the
  mount first), air unit, air unit antennas up and back; top plate; battery pad and
  XT30 mount and connector. Each layer clears the one below by a gap measured on
  height maps of the actual parts (the top plate clears whatever is under its
  footprint after the sideways moves).
- Camera and its soft mounts go forward (the mounts then outward, once clear of the
  side plates), the bumper further forward, the side plates up above the arm layer
  and then out sideways, the AirTag mount back and down with the AirTag dropping out
  of it. Motors lift off the arm ends with their arm's sideways move, props above,
  prop nuts above those.
- Every screw: its axis, head end and tip come from its own mesh. The parts it passes
  through are the parts with surface inside the hole clearance of its shank (this is
  what `screwcheck` does with booleans). It threads into the tip-most of them (the
  bumper's screws follow the bumper). Its move is that part's sideways move plus a
  move along its axis, toward the head side, until its tip clears the head-side face of
  every part it passed through, as they stand in the exploded pose. It therefore stays
  lined up with its hole, and moves with the same timing as the part it threads into so
  that it withdraws along its axis. Washers sit between a screw and its seat.
- The bumper holes model both an M3x6 and an M3x8: only the M3x8 is kept (the shorter
  screw of two screws on one hole axis is dropped).
- Timing: a start time per kind of part, top of the stack first, each move 40% of the
  explode; parts that must wait for others have their sideways move delayed.

`check_explode.py` voxelises every part in the exploded pose and fails the build review
when two parts share surface. `check_motion.py` replays the whole timeline and
reports parts that pass through each other; screws sliding out of their own holes show
as growth over the assembled baseline and are expected.

```bash
cd scripts/hero-assets && npm install
python3 explode/step_extract.py OpenDrone-asm-3F.step /tmp/3F.pkl   # minutes, 80 MB STEP
python3 explode/build_explode.py /tmp/3F.pkl /tmp/out3
python3 explode/check_explode.py /tmp/3F.pkl /tmp/out3/units.json 1
python3 explode/check_motion.py  /tmp/3F.pkl /tmp/out3/units.json 40
node --max-old-space-size=8192 compress-explode.mjs /tmp/out3 ../../public/models/od3
cp /tmp/out3/explode.json ../../public/models/od3/
```

`app/lib/hero-explode.test.ts` checks the shipped assets: every unit has a label and
finite timed moves, exists as a node in its chunk, every beat selects a real group, chunk
sizes match `chunks.json`.

## studio.json

Look and motion tuning only: lighting, the spotlight, camera (`distance`, `height`,
`heightOnPart`, `lift`, `stageShift`, `azimuth`), explode timing, scroll feel, material
profiles, and the beat copy. A beat is `select: {none: true}` or `select: {group}` with
a group from `explode.json` (`fc`, `esc`, `rx`, `motor` (one motor with prop, boot and
screws), `frame`, `video`); `partSize` is the fraction of the viewport height the group
fills. The beat copy is unchanged from before (`handle` pulls the caption and the link
from the product's What-does-this-do content).

Materials: each GLB material is named `<class>|<r,g,b>` and the class picks the profile
in `materials[]` (carbon, alu, sideplate, steel, rubber, tpu, motor, prop, camera, tag,
antenna, heatsink, smd, fr4, padgold, silk, mask). The CAD colour is 8-bit sRGB written
into the linear glTF field, and the scene decodes it on load, so never tint to fix
brightness.

## Adding a frame size

1. Export the STEP assembly, run the pipeline above into `public/models/od<N>/`.
2. Check the log: `UNCLAIMED leaves` must be empty and every kind of part must be
   recognised by `units.classify` (a new part name needs one line there).
3. Copy `studio.json` from a neighbouring design, set `name`, `source`, the beat copy.
4. `check_explode.py` and `check_motion.py` must be clean, then look at it on `/hero-preview`
   (`?herotest` exposes `window.__hero` with `setExplode(p)`, `goTo(i)`, `step(n)`).

## Limits

- The studio panel (`_studio.html`) is retired: it drove the old Onshape GLB structure.
  Tune by editing `studio.json` and reloading.
- The TPU parts (boots, air unit mount, camera soft mounts, AirTag and antenna mount,
  bumper, XT30 mount) are preliminary in the CAD and fit the DJI O4 Pro only.
- Part names are English strings in `explode.json`, not site copy.
- The 3D is hardcoded dark and does not follow the light theme.
- `build-hero.mjs` and the board scripts remain for Onshape GLB exports of older
  assemblies; the current od3 and od5 do not use them.
