# Hands-on AR

Load any 3D model (GLB, glTF, OBJ, STL), give its parts joints, and work it with your hands over a live camera feed. Runs entirely in the browser, so it can be hosted on GitHub Pages.

## Try it

1. Open the hosted page (or serve this folder locally: `python3 -m http.server`, then open http://localhost:8000).
2. Click **Start camera + hand tracking** and allow camera access. The page must be served over HTTPS or localhost for the camera to work.
3. A demo chair loads by default. Use **Load model** (or drag a file onto the page) to use your own.

## Interacting

| Gesture | Mouse | Effect |
|---|---|---|
| Pinch a moving part and drag | Drag a moving part | Works that joint (swivel, hinge, slide, spin) |
| Pinch any other part and drag | Drag | Moves the object on the floor; let go and it keeps rolling |
| Pinch with both hands and twist | Shift-drag or right-drag | Turns the object |
| Swipe an open palm into it | | Shoves it |
| Shine a torch / phone flashlight at it | | A virtual spotlight follows the beam, so the object lights up |

With **Match room lighting** on, the overall brightness and colour of the camera image also light the model.

## Making models move

Each top-level part of the model, plus any part whose name suggests motion, appears in the **Parts** list. Joints are guessed from names:

| Name contains | Motion |
|---|---|
| wheel, caster, tyre, roller | spins, and turns when the object rolls |
| fan, rotor, propeller, gear, pulley, knob | spins freely |
| door | hinge on a vertical edge, 0 to 110° |
| lid, hatch, flap, cover | hinge on the back edge |
| drawer, tray | slides out |
| piston, rod, plunger, slide | slides along its long axis, springs back |
| back, recline, lever, handle, pedal | hinge at the bottom, springs back |
| seat, swivel, turntable, turret, head | spins about the vertical axis |

Tick **click to select**, click a part, and change its motion, axis, pivot, limits, friction and spring. The setup is remembered per model in the browser, and **Download setup** saves it as JSON to share or reload.

Joints can also be stored in the model itself as glTF `extras` (custom properties), for example:
`{ "joint": "hinge", "axis": "y", "pivot": "-x", "min": 0, "max": 90, "spring": true }`.

### Exporting from CAD (3DEXPERIENCE, SOLIDWORKS, CATIA)

- Export **GLB/glTF** if available, otherwise STEP and convert with Blender or FreeCAD.
- Keep moving parts as **separate bodies** and give them clear names (`Seat`, `Backrest`, `Wheel_1`, `Door_Left`…).
- Reduce the triangle count for phones (Blender's Decimate modifier works well).
- CAD files are usually Z-up and in millimetres: leave **Z-up** ticked, and pick **File is in mm** for true size or **Fit to size** to scale it.

## Status / roadmap

- [x] Webcam + MediaPipe hand tracking, mouse fallback
- [x] Any model, per-part joints, name-based guesses, saved setups
- [x] Room-light matching and torch-beam spotlight
- [ ] Rigid-body physics (tipping over, falling, collisions)
- [ ] WebXR AR mode for Android Chrome: detect real floor/desk, true scale, anchoring
