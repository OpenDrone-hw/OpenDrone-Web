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

1. The drone sits assembled until the visitor scrolls. The first scroll step is the
   explode: the spring-smoothed scroll position drives the explode progress from the
   assembled stop to the whole-drone stop, so it is scroll-linked and scrolling back up
   reassembles it. Every part eases (smootherstep) through its own timed moves, top of
   the stack first (it is a disassembly: screws leave with the part they thread into),
   and the stagger is continuous in the scroll position. The camera pulls back from the
   assembled to the exploded framing with it. No idle spin.
2. Once exploded: hover a part and the rest dims; click to select it (the camera eases
   to it; click empty space or press Escape to release). There is no on-screen chrome:
   no part label, no collapse / explode button, no progress rail.
3. Orbit: drag turns the view around the current focus, damped, with the elevation
   clamped (no flipping under the model). The drag is an offset on the scripted view: the
   scripted camera is frozen while the pointer is down, the offset stays after release and
   eases back to the beat's framing when the timeline next moves. The press has to travel
   4 px before it is a drag (otherwise it is a click), the pointer is captured so the drag
   survives leaving the canvas, hover picking and wheel steps are off while pressed, and
   `touch-action: pan-y` keeps vertical swipes scrolling the page while a horizontal
   one-finger drag orbits.
4. The scroll walkthrough is the existing one (stops, spring, keyboard, deep
   links `/#fc`, `#esc`, `#rx`, `#frame`, `#motors`, which land exploded). Each beat focuses
   a group of the exploded model: the camera moves straight from one beat's group to the
   next (no pull-back to the overview between, no rest stops), eased and smoothed, and the
   rest dims; the lights stay as they are. The dim crossfades (the lit set fades out, the
   new one fades in) instead of switching. A selection is dropped when the walkthrough
   moves.
5. `prefers-reduced-motion`: the 3D still loads on desktop, but starts on the exploded
   whole-drone stop (static exploded pose), the camera cuts instead of travelling, scroll
   steps are instant and the orbit is undamped. Under 768 px the 3D is still skipped (the
   fallback list is the content).

Frame cost: about 1.4 ms of CPU per frame mid-explode (matrix updates, instanced hardware
draws, no layout reads: the canvas rect and the label width are cached), rendering is
capped at 60 fps and pauses after 5 s idle.

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

## Other readers of these assets

- **Product page Specs drawing** (`FrameViewer`, OpenFrame and OpenMotor): reads `od3|od5/frame.glb` and `drive.glb`. It matches parts by CAD name, so every node carries `extras.part` (the CAD part name) and `FrameViewer.partName` prefers it over the node name. Each motor is one node whose children are its bodies, shaft along local Y, so the shaft-axis explode and the spinning bell keep working. Verified for both sizes on `/products/openframe` and `/products/openmotor`.
- **Builder airframe** (`public/models/frame3.glb`, `frame5.glb`, listed in `app/lib/builder/registry.ts`): `build_explode.py` also writes `frame-legacy.glb` (root `Frame`, one `occurrence of <part>` node per carbon plate, arm, cross, aluminium side plate and standoff, CAD colours with gold side plates), and `compress-explode.mjs --legacy <in> <out>` compresses it undecimated. 165 KB (3") and 171 KB (5"), was 187 KB and 172 KB. Same coordinates as before (and as the boards), z up. No route mounts the legacy `HeroScene` that reads them today.

## studio.json

Look and motion tuning only: lighting (dark rig only, the site has no light theme; one fixed
rig in world space, set once, so exposure, environment and every light are the same from the
first assembling frame to the end of the walkthrough), the dim of the rest on a focused part
(`spotlight.darkenRest`, per beat `fade`; the hero no longer lights a focused part with a
spotlight or dips the rig, so the other `spotlight` keys are unused there), camera (`distance`, `height`,
`heightOnPart`, `lift`, `stageShift`, `azimuth`), the dim of a selected part, scroll feel, material
profiles, and the beat copy. A beat is `select: {none: true}` or `select: {group}` with
a group from `explode.json` (`fc`, `esc`, `rx`, `motor` (one motor with prop, boot and
screws), `frame`, `video`); `partSize` is the fraction of the viewport height the framed
parts fill. `frameKinds` (optional, a list of explode.json part kinds) frames only the
group's core body while the whole group stays lit: the motor beat frames `["motor"]`, not
the prop, boot and screws flying round it, and the RX beat frames `["rx"]`, not its
antenna. The beat copy is unchanged from before (`handle` pulls the caption and the link
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

## Colours and lighting

CAD colours are kept except: TPU is black or green (any other print colour is drawn black),
side plates are anodised gold #FBB600, standoffs are plain aluminium (no colour chosen yet),
motors keep the previous hero's look (gold anodised bell #FBB600, green stator #147A31,
CAD whites and greys), and near-black CAD colours are lifted to a dark grey at build time
(`build_explode.py`) so carbon, props, grommets and TPU keep their shape. Orange is not a
shipped colour: the only remaining orange-ish surfaces are small electronics on the boards
and the air unit (JST connector, capacitors, ENIG pads).

Carbon: the weave of the In-the-box art (`scripts/in-the-box`: 8x8 tows of 1.8 mm, one 14.4 mm
tile, 2x2 twill), tuned matte and subtle for the hero: a few percent of albedo between tows,
roughness about 0.65, a soft normal map at `normalScale` 0.12, so the weave only shows on a close
look or at grazing light. `explode/carbon_texture.py` writes albedo, roughness and normal PNGs
(256 px, about 7 KB in all) to `public/models/carbon/`. At build time the flat faces of each carbon part
(`build_explode.py`: bottom, middle and top plate, arms, cross) get planar UVs in the part's
own long-axis frame, one UV unit per tile, so the weave runs along the part's long axis and
the scale is the same on every part; the cut edges are a separate plain dark matte primitive
(`carbonedge`), so nothing is stretched on the sides. The GLB carries the UVs and the material
name `carbon|twill` only; the scene loads the three maps itself (a GLB-embedded image would
become a blob: URL, which the page's CSP blocks) and dresses the carbon material with them
(anisotropic filtering on). MeshStandardMaterial has no anisotropy, so there is no sheen.

Metals (screws, nuts, standoffs, side plates, motors) are metalness 0.95 to 1, roughness 0.15 to
0.18 and environment intensity 1.3 to 1.4: polished or anodised, with crisp highlights from the key
and the warm kicker and visible environment reflections, not a chrome mirror.

Transitions: the camera is damped (critically damped smoothing, about 1 s, no overshoot, the
velocity carries across a retarget so a quick second step or click continues from the current
state). Between two groups the camera also sweeps round the model (a swing of up to 0.42 rad
in yaw, bell-shaped over the move, direction from which side the next group is on) instead of
cutting across it, the explode state is not touched (it only depends on the scroll position), the
dim crossfades (fade out, swap, fade in) and so does the part label (the old name fades, the text
swaps while clear, the new name fades in).

Performance: pixel ratio capped at 1.75, render loop pauses 5 s after the last input and when the
canvas is off screen or the tab is hidden, repeated fasteners are drawn instanced.

Lighting (low-key studio, `studio.json` `lighting`): ACES filmic tone mapping at exposure
0.95 (`toneMapping: "agx"` is also supported), a RoomEnvironment map at 0.35 for reflections
on carbon, gold anodise and screws, a soft white key, a warm kicker behind-left that traces
edges and gives the gold side plates and motor bells their glint, a cool low fill, almost no
ambient, and a soft contact shadow disc under the drone (a radial gradient plane, no shadow
maps; `groundShadow` is its opacity).

## Limits

- The studio panel (`_studio.html`) is retired: it drove the old Onshape GLB structure.
  Tune by editing `studio.json` and reloading.
- The TPU parts (boots, air unit mount, camera soft mounts, AirTag and antenna mount,
  bumper, XT30 mount) are preliminary in the CAD and fit the DJI O4 Pro only.
- Part names are English strings in `explode.json`, not site copy.
- `build-hero.mjs` and the board scripts remain for Onshape GLB exports of older
  assemblies; the current od3 and od5 do not use them.
