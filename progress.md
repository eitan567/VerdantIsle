Original prompt: יש בעיה באנימציה של החיות כמו horse, deer,stag שם מרצדים דיי הרבה תראה את הסרטונים וגם אני רואה בSTAG שהכפות רגליים כאילו מתנתקות מהגוף שלו בזמן הליכה לפעמים..

## 2026-06-20

- Started investigation of animal animation flickering and stag foot separation.
- Current repo was already dirty before this work: island-explorer.html modified, models/cat_rigged.fbx deleted, models/Pirate kit-glb/ untracked, video recordings untracked.
- Video frames confirmed detached stag hoof/foot pieces below the body.
- FBX diagnostics showed the old stripRootMotion heuristic could strip animal leg IK tracks during gallop, especially IKBackLegR.position, instead of a true rig-root track.
- Updated stripRootMotion to only strip root-like tracks such as Root/Armature/Hips/Pelvis/mixamorigHips, preserving quadruped IK tracks.
- Further FBX testing showed the built-in Gallop clips themselves rely on IK/foot-control bones that Three.js does not solve as constraints; this leaves small hoof clusters visually detached.
- Changed the animal gallop action to use the stable Walk clip at a faster playback rate instead of the problematic Gallop clip.
- Verified the page with wildlife enabled in Playwright full-page screenshots and no console errors. The web-game skill client also ran without errors, though its direct WebGL canvas screenshots are black in this environment.

## 2026-06-21

- User reported the animals still flicker and the motion feels interrupted, especially from ground-level views; top-down menu parrot view hides most of it.
- Found a concrete regression from the previous gallop fallback: walk/gallop can share the same AnimationAction, but state changes still called reset/crossFade on that same action, interrupting the gait loop. Added a regression probe and fixed playAnimalAction so shared actions change labels without resetting.
- Matched the successful player-character approach more closely: ground animals now smooth heading and actual movement speed toward intent instead of snapping immediately, and their sampled terrain height is filtered over time.
- Capped flee speed when using the walk clip as a gallop fallback so the feet do not visibly slide across the ground.
- Let gallop continue briefly after a threat leaves range instead of dropping straight to idle, which prevents rapid action switching at the threat boundary.
- Re-ran the shared-action regression probe, inline script parse check, and the web-game Playwright skill client with no console errors.

- User chose a clean reset for the Stag issue: removed only the Stag-specific UI/runtime wiring (stag wildlife definition and Stag.fbx ground-animal config). The asset file was not changed or deleted. Verified island-explorer.html has no stag/Stag references, script parse passes, and browser network loading no longer requests models/Stag.fbx.
