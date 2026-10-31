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

With **Real physics** on (the default), the model is simulated with [Rapier](https://rapier.rs): gravity, collisions with the floor, and real joints. Grabbing pulls the touched point toward your hand with a spring, so pulling the top of a chair tips it over, pulling the base rolls it on its wheels, and pulling the seat swivels it. Turn physics off for simpler "drag a joint" control.

## Android AR mode

On Chrome for Android (with Google Play Services for AR), an **Enter AR** button appears. Move the phone to find a surface (floor, desk), tap to place the model at true scale, then touch and drag it to push, tip or roll it. **Place again** moves it to another surface. Hand tracking and torch lighting are webcam-mode features; in AR you interact by touch. iPhone Safari does not support WebXR AR, so iPhone would need a native ARKit app.

Model size in AR comes from the **Model** settings: pick the file's units for true size, or **Fit to size** with e.g. `0.3` m for a tabletop miniature.

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
- Reduce the triangle count for phones (Blender's Decimate modifier works well), or export with Draco compression. Files load locally in the browser, so there is no upload limit, but aim for under ~20 MB on a phone.
- CAD files are usually Z-up and in millimetres: leave **Z-up** ticked, and pick **File is in mm** for true size or **Fit to size** to scale it.

## Status / roadmap

- [x] Webcam + MediaPipe hand tracking, mouse fallback
- [x] Any model, per-part joints, name-based guesses, saved setups
- [x] Room-light matching and torch-beam spotlight
- [x] Rigid-body physics (tipping over, falling, collisions)
- [x] WebXR AR mode for Android Chrome: tap a real surface to place, true scale (needs on-device testing)
- [x] Draco / Meshopt compressed GLB support
- [ ] Collide with real-world geometry in AR (WebXR depth / planes)
- [ ] Hand tracking inside AR mode
